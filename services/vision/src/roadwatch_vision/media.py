"""Decode only local files in an isolated worker. Frame and pixel limits fail closed."""
from pathlib import Path
import warnings
import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError
from .config import Settings


def decode_frames(path: Path, settings: Settings):
    with path.open("rb") as stream: header=stream.read(32)
    image_magic=header.startswith((b"\xff\xd8\xff",b"\x89PNG\r\n\x1a\n")) or (header[:4]==b"RIFF" and header[8:12]==b"WEBP")
    if image_magic:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error",Image.DecompressionBombWarning)
                with Image.open(path) as im:
                    if im.width*im.height>settings.max_pixels or min(im.size)<16:
                        raise ValueError("image_dimensions_out_of_bounds")
                    if getattr(im,"n_frames",1)!=1: raise ValueError("animated_image_not_supported")
                    im.verify()
                with Image.open(path) as im:
                    # Preserve encoded pixel orientation: calibration refers to these pixels.
                    frame=cv2.cvtColor(np.asarray(im.convert("RGB")),cv2.COLOR_RGB2BGR)
            yield frame,0.0
        except (UnidentifiedImageError,OSError,Image.DecompressionBombError,Image.DecompressionBombWarning) as exc:
            raise ValueError("invalid_image") from exc
        return
    video_magic=header[4:8]==b"ftyp" or header[:4]==b"\x1a\x45\xdf\xa3" or (header[:4]==b"RIFF" and header[8:12]==b"AVI ")
    if not video_magic: raise ValueError("unsupported_or_invalid_media")
    cap=cv2.VideoCapture(str(path))
    try:
        if not cap.isOpened(): raise ValueError("invalid_video")
        fps=cap.get(cv2.CAP_PROP_FPS); count=cap.get(cv2.CAP_PROP_FRAME_COUNT)
        width=cap.get(cv2.CAP_PROP_FRAME_WIDTH); height=cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        if not np.isfinite([fps,count,width,height]).all() or fps<=0 or fps>120 or count<=0:
            raise ValueError("invalid_video_timing")
        if width*height>settings.max_pixels or min(width,height)<16:
            raise ValueError("video_dimensions_out_of_bounds")
        if count>settings.max_decoded_frames or count/fps>settings.max_video_seconds:
            raise ValueError("video_exceeds_duration_or_frame_limit")
        stride=max(1,int(np.ceil(count/settings.max_selected_frames)))
        decoded=0
        while True:
            success,frame=cap.read()
            if not success: break
            if decoded>=settings.max_decoded_frames: raise ValueError("video_exceeds_frame_limit")
            if frame.shape[0]*frame.shape[1]>settings.max_pixels: raise ValueError("video_dimensions_out_of_bounds")
            if decoded%stride==0 and decoded//stride<settings.max_selected_frames:
                yield frame,decoded/fps
            decoded+=1
        if decoded==0 or decoded<int(count)-2:
            raise ValueError("truncated_video")
    finally:
        cap.release()


def assess_quality(frame):
    gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
    mean=float(gray.mean()); sharpness=float(cv2.Laplacian(gray,cv2.CV_64F).var())
    reasons=[]
    if mean<12: reasons.append("underexposed")
    if mean>245: reasons.append("overexposed")
    if sharpness<5: reasons.append("low_sharpness")
    return {"eligible":not reasons,"reasons":reasons,"meanIntensity":mean,"sharpness":sharpness}
