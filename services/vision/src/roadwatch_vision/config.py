from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    service_key: str = ""
    manifest_path: Path | None = None
    max_upload_bytes: int = 32 * 1024 * 1024
    max_pixels: int = 16_000_000
    max_video_seconds: int = 60
    max_decoded_frames: int = 1800
    max_selected_frames: int = 30
    timeout_seconds: int = 90
    max_concurrency: int = 2
    allow_experimental: bool = False

    @classmethod
    def from_env(cls):
        values = {"service_key": os.getenv("VISION_SERVICE_KEY", ""),
                  "manifest_path": Path(os.environ["VISION_MODEL_MANIFEST"]) if os.getenv("VISION_MODEL_MANIFEST") else None}
        experimental=os.getenv("VISION_ALLOW_EXPERIMENTAL_MODEL","false")
        if experimental not in ("true","false"):
            raise ValueError("VISION_ALLOW_EXPERIMENTAL_MODEL must be true or false")
        values["allow_experimental"]=experimental=="true"
        # Bound operator settings as well; a malformed environment must fail startup.
        limits = {"max_upload_bytes": (1024, 256 * 1024 * 1024), "max_pixels": (4096, 32_000_000),
                  "max_video_seconds": (1, 300), "max_decoded_frames": (1, 18000),
                  "max_selected_frames": (1, 120), "timeout_seconds": (1, 600), "max_concurrency": (1, 8)}
        for key, (low, high) in limits.items():
            raw = os.getenv("VISION_" + key.upper())
            if raw is not None:
                value = int(raw)
                if not low <= value <= high:
                    raise ValueError(f"VISION_{key.upper()} must be between {low} and {high}")
                values[key] = value
        return cls(**values)
