import argparse
from datetime import datetime,timezone
import json
import os
from pathlib import Path
import signal
import sys
import threading
import time
import cv2
import httpx
from .spool import Spool,SpoolFull
from .uploader import Uploader,validate_api


def capture(spool,source,survey_id,interval,stop,calibration_id=None):
    camera=int(source) if source.isdigit() else source
    if source.startswith(("rtsp://","rtsps://")):
        cap=cv2.VideoCapture(camera,cv2.CAP_FFMPEG,[cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,5000,cv2.CAP_PROP_READ_TIMEOUT_MSEC,5000])
    else:
        cap=cv2.VideoCapture(camera)
    if not cap.isOpened():
        cap.release(); raise RuntimeError("camera_open_failed")
    next_capture=time.monotonic(); count=0
    try:
        while not stop.is_set():
            success,frame=cap.read()
            received=datetime.now(timezone.utc).isoformat()
            if not success: raise RuntimeError("camera_read_failed_capture_stopped")
            if frame.shape[0]*frame.shape[1]>16_000_000: raise RuntimeError("camera_resolution_exceeds_limit")
            if time.monotonic()<next_capture: continue
            success,jpeg=cv2.imencode(".jpg",frame,[cv2.IMWRITE_JPEG_QUALITY,92])
            if not success: raise RuntimeError("jpeg_encoding_failed")
            metadata={"surveyId":survey_id,"capturedAt":received,"timestampMethod":"host_frame_receipt_not_hardware_exposure"}
            if calibration_id: metadata["calibrationId"]=calibration_id
            spool.add(jpeg.tobytes(),metadata); count+=1
            next_capture=time.monotonic()+interval
            if count%10==0: print(json.dumps({"captured":count,"backlog":spool.status()["backlog"]}),flush=True)
    finally: cap.release()
    return count


def main():
    parser=argparse.ArgumentParser(description="RoadWatch edge capture: tokens stay in environment, never spool metadata.")
    parser.add_argument("--spool",type=Path,default=Path("./edge-spool"))
    parser.add_argument("--max-bytes",type=int,default=2*1024**3)
    parser.add_argument("--min-free-bytes",type=int,default=128*1024**2)
    sub=parser.add_subparsers(dest="command",required=True)
    record=sub.add_parser("capture"); record.add_argument("--source",default="0")
    record.add_argument("--survey-id",required=True); record.add_argument("--interval",type=float,default=1)
    record.add_argument("--calibration-id")
    upload=sub.add_parser("upload"); upload.add_argument("--api",default="http://127.0.0.1:3001"); upload.add_argument("--once",action="store_true")
    survey=sub.add_parser("create-survey"); survey.add_argument("--api",default="http://127.0.0.1:3001")
    survey.add_argument("--device-id",required=True); survey.add_argument("--name",required=True); survey.add_argument("--road-id",action="append",default=[])
    sub.add_parser("status"); sub.add_parser("recover"); sub.add_parser("retry-blocked")
    args=parser.parse_args()
    if args.max_bytes<1024*1024 or args.min_free_bytes<0: parser.error("invalid spool capacity")
    stop=threading.Event()
    for sig in (signal.SIGINT,signal.SIGTERM): signal.signal(sig,lambda *_:stop.set())
    if args.command=="create-survey":
        url=validate_api(args.api); token=os.environ.get("ROADWATCH_DEVICE_TOKEN","")
        if not token: parser.error("ROADWATCH_DEVICE_TOKEN is required")
        with httpx.Client(timeout=30,follow_redirects=False) as client:
            response=client.post(url+"/v1/surveys",headers={"Authorization":"Bearer "+token},
                                 json={"deviceId":args.device_id,"name":args.name,"roadIds":args.road_id})
            if not 200<=response.status_code<300: raise SystemExit(f"survey_creation_failed_http_{response.status_code}")
            print(json.dumps(response.json(),indent=2)); return
    spool=Spool(args.spool,args.max_bytes,args.min_free_bytes)
    if args.command=="status": print(json.dumps(spool.status(),indent=2)); return
    if args.command=="recover": print(json.dumps(spool.recover(),indent=2)); return
    if args.command=="retry-blocked": print(json.dumps({"reset":spool.retry_blocked()})); return
    spool.recover()
    if args.command=="capture":
        if not .1<=args.interval<=60: parser.error("interval must be 0.1–60 seconds")
        try: capture(spool,args.source,args.survey_id,args.interval,stop,args.calibration_id)
        except (SpoolFull,RuntimeError) as exc:
            print(json.dumps({"captureStopped":True,"reason":str(exc)}),file=sys.stderr); raise SystemExit(2) from None
    elif args.command=="upload":
        uploader=Uploader(spool,args.api,os.environ.get("ROADWATCH_DEVICE_TOKEN",""))
        last_heartbeat=0
        try:
            while not stop.is_set():
                handled=uploader.upload_one()
                if time.monotonic()-last_heartbeat>30:
                    uploader.heartbeat(); last_heartbeat=time.monotonic()
                if args.once: break
                if not handled: stop.wait(1)
        finally: uploader.close()


if __name__=="__main__": main()
