from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

CLASSES = ("pothole", "longitudinal_crack", "transverse_crack", "alligator_crack",
           "patch_deterioration", "raveling", "edge_break", "surface_deformation")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Fix(StrictModel):
    timestamp: datetime
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    horizontalAccuracy95M: float = Field(gt=0, le=10000)
    headingDeg: float | None = Field(default=None, ge=0, lt=360)

    @model_validator(mode="after")
    def utc_required(self):
        if self.timestamp.tzinfo is None:
            raise ValueError("timestamp must include UTC offset")
        return self


class PlanarCalibration(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    kind: Literal["planar"]
    imageWidth: int = Field(gt=0, le=16384)
    imageHeight: int = Field(gt=0, le=16384)
    # Homography maps undistorted pixels into vehicle forward/right metres.
    imageToGround: list[list[float]]
    cameraMatrix: list[list[float]] | None = None
    distortion: list[float] = Field(default_factory=list, max_length=14)
    validRoi: list[list[float]] = Field(min_length=3, max_length=1000)
    uncertainty95M: float = Field(gt=0, le=10)
    cameraOffsetForwardM: float = Field(default=0, ge=-30, le=30)
    cameraOffsetRightM: float = Field(default=0, ge=-30, le=30)
    headingAccuracy95Deg: float = Field(default=5, gt=0, le=180)
    validUntil: datetime

    @model_validator(mode="after")
    def matrix_shapes(self):
        for matrix in [self.imageToGround] + ([self.cameraMatrix] if self.cameraMatrix else []):
            if len(matrix) != 3 or any(len(row) != 3 for row in matrix):
                raise ValueError("calibration matrices must be 3x3")
        if any(len(p) != 2 for p in self.validRoi):
            raise ValueError("validRoi must contain pixel pairs")
        if self.distortion and not self.cameraMatrix:
            raise ValueError("distortion requires cameraMatrix")
        if len(self.distortion) not in (0, 4, 5, 8, 12, 14):
            raise ValueError("unsupported distortion coefficients")
        if self.validUntil.tzinfo is None:
            raise ValueError("validUntil must include UTC offset")
        return self


class Metadata(StrictModel):
    capturedAt: datetime
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    locationAccuracyM: float | None = Field(default=None, gt=0, le=10000)
    calibration: PlanarCalibration | None = None
    trajectory: list[Fix] = Field(default_factory=list, max_length=10000)
    maxSyncGapMs: int = Field(default=500, gt=0, le=2000)
    videoTiming: Literal["unverified","constant_fps_verified"] = "unverified"

    @model_validator(mode="after")
    def consistent(self):
        if self.capturedAt.tzinfo is None:
            raise ValueError("capturedAt must include UTC offset")
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("latitude and longitude must be supplied together")
        times = [f.timestamp for f in self.trajectory]
        if times != sorted(times) or len(set(times)) != len(times):
            raise ValueError("trajectory timestamps must be unique and increasing")
        return self


def unknown(unit: str, reason: str):
    return {"value": None, "unit": unit, "status": "unknown", "method": "unavailable",
            "uncertainty95": None, "reason": reason}


def measured(value: float, unit: str, method: str, uncertainty: float):
    # Geometry computed from a calibration is an estimate until field-certified.
    return {"value": float(value), "unit": unit, "status": "estimated", "method": method,
            "uncertainty95": float(uncertainty)}
