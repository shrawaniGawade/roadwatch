import hashlib
import json
from urllib.parse import urlparse
import httpx


def validate_api(url):
    parsed=urlparse(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid_api_url")
    if parsed.scheme!="https" and not (parsed.scheme=="http" and parsed.hostname in ("127.0.0.1","localhost","::1")):
        raise ValueError("device_token_requires_https_except_loopback")
    return url.rstrip("/")


class Uploader:
    def __init__(self,spool,api_url,token,client=None):
        if not token: raise ValueError("ROADWATCH_DEVICE_TOKEN_required")
        self.spool=spool; self.api_url=validate_api(api_url); self.token=token
        self.client=client or httpx.Client(timeout=httpx.Timeout(60,connect=10),follow_redirects=False)

    def upload_one(self):
        chunk=self.spool.claim()
        if not chunk: return False
        try:
            path=self.spool.path/chunk["filename"]
            with path.open("rb") as stream:
                if hashlib.file_digest(stream,"sha256").hexdigest()!=chunk["sha256"]:
                    self.spool.retry(chunk["id"],"local_checksum_mismatch",False); return True
                stream.seek(0)
                metadata={k:str(v) for k,v in chunk["metadata"].items() if k in
                          ("surveyId","capturedAt","latitude","longitude","locationAccuracyM","calibrationId","maxSyncGapMs")
                          and v is not None}
                # Multipart fields are strings. Python repr would silently produce
                # invalid JSON, and omitting the fixes loses exposure interpolation.
                if chunk["metadata"].get("trajectory") is not None:
                    metadata["trajectory"]=json.dumps(chunk["metadata"]["trajectory"],allow_nan=False,separators=(",",":"))
                response=self.client.post(self.api_url+"/v1/uploads",headers={"Authorization":"Bearer "+self.token,
                    "Idempotency-Key":chunk["id"],"X-Content-SHA256":chunk["sha256"]},data=metadata,
                    files={"file":(chunk["filename"],stream,"image/jpeg")})
            if 200<=response.status_code<300:
                # The backend contract acknowledges after evidence/job transaction commit.
                try: receipt=response.json()
                except ValueError:
                    self.spool.retry(chunk["id"],"invalid_upload_receipt",True); return True
                if not isinstance(receipt,dict):
                    self.spool.retry(chunk["id"],"invalid_upload_receipt",True); return True
                if receipt.get("sha256",chunk["sha256"])!=chunk["sha256"]:
                    self.spool.retry(chunk["id"],"receipt_checksum_mismatch",False); return True
                self.spool.acknowledge(chunk["id"],receipt)
            else:
                self.spool.retry(chunk["id"],f"http_{response.status_code}",response.status_code in (408,425,429) or response.status_code>=500)
        except (httpx.HTTPError,OSError):
            self.spool.retry(chunk["id"],"upload_transport_or_file_failure",True)
        return True

    def heartbeat(self):
        try:
            response=self.client.post(self.api_url+"/v1/devices/heartbeat",headers={"Authorization":"Bearer "+self.token},
                                      json={"uploadBacklog":self.spool.status()["backlog"]})
            return 200<=response.status_code<300
        except httpx.HTTPError: return False

    def close(self): self.client.close()
