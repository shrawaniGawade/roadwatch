"""One request per subprocess: bounded lifetime, no remote media decoding."""
from datetime import timedelta
import json
import os
from pathlib import Path
import sys
from . import PIPELINE_VERSION
from .config import Settings
from .geometry import footprint_measurements
from .media import assess_quality,decode_frames
from .models import load_model
from .schema import Metadata,unknown


def analyze(path,metadata,model,settings):
    detections=[]; reasons=set(); eligible_frames=0; frame_count=0
    with path.open("rb") as stream: header=stream.read(16)
    is_video=header[4:8]==b"ftyp" or header[:4]==b"\x1a\x45\xdf\xa3" or (header[:4]==b"RIFF" and header[8:12]==b"AVI ")
    if is_video and metadata.videoTiming!="constant_fps_verified":
        # Nominal video FPS is not an exposure timestamp for variable-rate sources.
        metadata=metadata.model_copy(update={"trajectory":[]})
        reasons.add("video_exposure_timing_unverified_geolocation_withheld")
    for frame,offset in decode_frames(path,settings):
        frame_count+=1
        quality=assess_quality(frame); reasons.update(quality["reasons"])
        if not quality["eligible"]: continue
        eligible_frames+=1
        at=metadata.capturedAt+timedelta(seconds=offset)
        for det in model.predict(frame):
            geometry_ok=det.pop("geometryEligible",False)
            if geometry_ok:
                det.update(footprint_measurements(det["mask"],metadata,frame.shape,at))
            else:
                det.update({key:unknown(unit,det.get("measurementReason","mask_topology_requires_review")) for key,unit in
                            [("length","m"),("width","m"),("area","m2"),("depth","mm")]})
            det.update(frameIndex=frame_count-1,timeOffsetMs=round(offset*1000),widthPx=frame.shape[1],heightPx=frame.shape[0])
            detections.append(det)
            if len(detections)>1000: raise ValueError("too_many_detections_split_media")
    return {"pipelineVersion":PIPELINE_VERSION,"model":{"name":model.manifest.name,"version":model.manifest.version,"ready":True,
            "validationStatus":model.manifest.validationStatus,"artifactSha256":model.manifest.sha256,
            "datasetManifestSha256":model.manifest.datasetManifestSha256,"license":model.manifest.license,
            "sourceUrl":model.manifest.sourceUrl},
            "calibrationId":metadata.calibration.id if metadata.calibration else None,
            "timing":{"capturedAt":metadata.capturedAt.isoformat(),"reference":"submitted_capture_time",
                      "videoFrameOffsets":metadata.videoTiming if is_video else "not_applicable"},
            "quality":{"eligible":eligible_frames>0,"reasons":sorted(reasons),"eligibleFrames":eligible_frames},
            "detections":detections,"frameCount":frame_count}


def main():
    settings=Settings.from_env()
    try:
        # OS-level CPU limit is supplementary to the parent's hard wall-clock timeout.
        if sys.platform.startswith("linux"):
            import resource
            resource.setrlimit(resource.RLIMIT_CPU,(settings.timeout_seconds,settings.timeout_seconds+1))
            resource.setrlimit(resource.RLIMIT_FSIZE,(64*1024*1024,64*1024*1024))
        metadata=Metadata.model_validate_json(Path(sys.argv[2]).read_text())
        model=load_model(settings.manifest_path,settings.allow_experimental)
        result=analyze(Path(sys.argv[1]),metadata,model,settings)
        Path(sys.argv[3]).write_text(json.dumps(result,allow_nan=False))
    except Exception as exc:
        # Local error code only. No credentials, source paths, decoder stderr or weights.
        code=str(exc) if isinstance(exc,ValueError) and len(str(exc))<100 else "inference_failed"
        Path(sys.argv[3]).write_text(json.dumps({"error":code}))
        sys.exit(2)


if __name__=="__main__": main()
