import asyncio
from contextlib import asynccontextmanager
import hmac
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Annotated
from fastapi import FastAPI,File,Form,HTTPException,UploadFile
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from . import PIPELINE_VERSION
from .config import Settings
from .models import load_manifest,load_model
from .schema import Metadata


class BodyLimitExceeded(Exception): pass


class ServiceBoundary:
    """Authenticate BEFORE multipart parsing and enforce streamed request size."""
    def __init__(self,app,settings): self.app=app; self.settings=settings

    async def __call__(self,scope,receive,send):
        if scope["type"]!="http" or scope["path"] in ("/health","/ready"):
            return await self.app(scope,receive,send)
        keys=[v for k,v in scope["headers"] if k.lower()==b"x-service-key"]
        if not self.settings.service_key:
            return await JSONResponse({"message":"service_key_not_configured"},503)(scope,receive,send)
        if len(keys)!=1 or not hmac.compare_digest(keys[0],self.settings.service_key.encode()):
            return await JSONResponse({"message":"unauthorized"},401)(scope,receive,send)
        limit=self.settings.max_upload_bytes+262144+8192
        lengths=[v for k,v in scope["headers"] if k.lower()==b"content-length"]
        if lengths:
            try:
                if len(lengths)!=1 or int(lengths[0])>limit or int(lengths[0])<0: raise ValueError()
            except ValueError:
                return await JSONResponse({"message":"request_too_large"},413)(scope,receive,send)
        total=0
        async def bounded_receive():
            nonlocal total
            message=await receive()
            if message["type"]=="http.request":
                total+=len(message.get("body",b""))
                if total>limit: raise BodyLimitExceeded()
            return message
        try:
            return await self.app(scope,bounded_receive,send)
        except BodyLimitExceeded:
            return await JSONResponse({"message":"request_too_large"},413)(scope,receive,send)


def create_app(settings=None):
    settings=settings or Settings.from_env()
    app=FastAPI(title="RoadWatch vision",version="0.1.0",docs_url=None,redoc_url=None)
    app.add_middleware(ServiceBoundary,settings=settings)
    semaphore=asyncio.Semaphore(settings.max_concurrency)
    runtime_checked=set()

    def configured_manifest():
        manifest,artifact=load_manifest(settings.manifest_path)
        if manifest.validationStatus=="experimental" and (not settings.allow_experimental or os.getenv("NODE_ENV")=="production"):
            raise ValueError("experimental_model_not_enabled")
        signature=(manifest.sha256,manifest.format,manifest.model_dump_json(),artifact.stat().st_mtime_ns)
        if signature not in runtime_checked:
            # A checksum-valid but incompatible graph must never report ready.
            load_model(settings.manifest_path,settings.allow_experimental)
            runtime_checked.clear(); runtime_checked.add(signature)
        return manifest

    @app.get("/health")
    def health(): return {"status":"ok","pipelineVersion":PIPELINE_VERSION}

    @app.get("/ready")
    def ready():
        if not settings.service_key: return JSONResponse({"ready":False,"reason":"service_key_not_configured"},503)
        try:
            manifest=configured_manifest()
            return {"ready":True,"model":{"name":manifest.name,"version":manifest.version,"validationStatus":manifest.validationStatus}}
        except Exception:
            return JSONResponse({"ready":False,"reason":"model_not_configured"},503)

    @app.post("/v1/analyze")
    async def analyze(file:Annotated[UploadFile,File()],metadata:Annotated[str,Form()]):
        if len(metadata.encode())>262144: raise HTTPException(422,"metadata_too_large")
        try: parsed=Metadata.model_validate_json(metadata)
        except ValidationError: raise HTTPException(422,"invalid_metadata") from None
        try: configured_manifest()
        except Exception: raise HTTPException(503,"model_not_configured") from None
        if semaphore.locked(): raise HTTPException(429,"inference_capacity_busy")
        async with semaphore:
            with tempfile.TemporaryDirectory(prefix="roadwatch-inference-") as temp:
                directory=Path(temp); media=directory/"upload.media"; metadata_path=directory/"metadata.json"; result_path=directory/"result.json"
                total=0
                try:
                    with media.open("wb") as stream:
                        while data:=await file.read(1024*1024):
                            total+=len(data)
                            if total>settings.max_upload_bytes: raise HTTPException(413,"media_too_large")
                            stream.write(data)
                finally: await file.close()
                if total==0: raise HTTPException(422,"empty_media")
                metadata_path.write_text(parsed.model_dump_json())
                env=os.environ.copy()
                env["VISION_MODEL_MANIFEST"]=str(settings.manifest_path.resolve())
                env["VISION_ALLOW_EXPERIMENTAL_MODEL"]="true" if settings.allow_experimental else "false"
                for name in ("max_pixels","max_video_seconds","max_decoded_frames","max_selected_frames","timeout_seconds"):
                    env["VISION_"+name.upper()]=str(getattr(settings,name))
                env.pop("VISION_SERVICE_KEY",None)
                process=await asyncio.create_subprocess_exec(sys.executable,"-m","roadwatch_vision.worker",str(media),str(metadata_path),str(result_path),
                    stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL,env=env)
                try: await asyncio.wait_for(process.wait(),settings.timeout_seconds)
                except TimeoutError:
                    if process.returncode is None: process.kill()
                    await process.wait()
                    raise HTTPException(504,"inference_timeout") from None
                except asyncio.CancelledError:
                    if process.returncode is None: process.kill()
                    await process.wait()
                    raise
                if not result_path.exists() or result_path.stat().st_size>32*1024*1024:
                    raise HTTPException(422,"inference_failed")
                result=json.loads(result_path.read_text())
                if process.returncode or "error" in result: raise HTTPException(422,result.get("error","inference_failed"))
                return result

    @app.exception_handler(HTTPException)
    async def api_error(request,exc):
        return JSONResponse({"message":exc.detail,"code":exc.detail},exc.status_code)
    return app


app=create_app()
