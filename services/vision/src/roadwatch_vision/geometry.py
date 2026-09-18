"""Metric geometry with explicit frame conventions and no monocular cavity claim."""
from datetime import datetime
import math
import cv2
import numpy as np
from .schema import Fix, Metadata, PlanarCalibration, measured, unknown


def interpolate_fix(fixes: list[Fix], exposure: datetime, max_gap_ms: int = 500) -> Fix | None:
    """No extrapolation. Interpolate in a short local tangent-plane approximation."""
    for fix in fixes:
        if fix.timestamp == exposure:
            return fix
    for a, b in zip(fixes, fixes[1:]):
        if a.timestamp < exposure < b.timestamp:
            gap = (b.timestamp - a.timestamp).total_seconds()
            if gap * 1000 > max_gap_ms:
                return None
            t = (exposure - a.timestamp).total_seconds() / gap
            heading = None
            if a.headingDeg is not None and b.headingDeg is not None:
                heading = (a.headingDeg + t * ((b.headingDeg-a.headingDeg+180) % 360-180)) % 360
            dl = (b.longitude-a.longitude+180) % 360-180
            return Fix(timestamp=exposure, latitude=a.latitude+t*(b.latitude-a.latitude),
                       longitude=(a.longitude+t*dl+180) % 360-180,
                       horizontalAccuracy95M=max(a.horizontalAccuracy95M,b.horizontalAccuracy95M),
                       headingDeg=heading)
    return None


def project_ground(pixels, calibration: PlanarCalibration, image_shape, at: datetime):
    h, w = image_shape[:2]
    if (w, h) != (calibration.imageWidth, calibration.imageHeight):
        raise ValueError("calibration_resolution_mismatch")
    if at > calibration.validUntil:
        raise ValueError("calibration_expired")
    points = np.asarray(pixels, dtype=np.float64).reshape(-1, 2)
    if len(points) < 3 or not np.isfinite(points).all():
        raise ValueError("invalid_polygon")
    roi = np.asarray(calibration.validRoi,dtype=np.float32)
    if any(cv2.pointPolygonTest(roi, tuple(map(float,p)), False) < 0 for p in points):
        raise ValueError("outside_calibrated_roi")
    if calibration.cameraMatrix:
        k=np.asarray(calibration.cameraMatrix,dtype=np.float64)
        points=cv2.undistortPoints(points.reshape(-1,1,2),k,np.asarray(calibration.distortion) if calibration.distortion else None,P=k).reshape(-1,2)
    hmatrix=np.asarray(calibration.imageToGround,dtype=np.float64)
    if abs(np.linalg.det(hmatrix)) < 1e-12 or np.linalg.cond(hmatrix) > 1e10:
        raise ValueError("singular_calibration")
    homogeneous=np.column_stack((points,np.ones(len(points)))) @ hmatrix.T
    if np.any(np.abs(homogeneous[:,2]) < 1e-9):
        raise ValueError("projection_at_horizon")
    ground=homogeneous[:,:2]/homogeneous[:,2,None]
    if not np.isfinite(ground).all() or np.max(np.abs(ground)) > 200:
        raise ValueError("ground_projection_out_of_range")
    return ground


def offset_coordinate(fix: Fix, forward_m: float, right_m: float):
    """Heading clockwise from north; right positive east at heading zero."""
    if fix.headingDeg is None or abs(fix.latitude) > 85:
        raise ValueError("heading_or_local_projection_unavailable")
    angle=math.radians(fix.headingDeg)
    north=forward_m*math.cos(angle)-right_m*math.sin(angle)
    east=forward_m*math.sin(angle)+right_m*math.cos(angle)
    radius=6378137.0
    lat=fix.latitude+math.degrees(north/radius)
    lon=(fix.longitude+math.degrees(east/(radius*math.cos(math.radians(fix.latitude))))+180)%360-180
    return lat,lon


def footprint_measurements(mask, metadata: Metadata, image_shape, at: datetime):
    result={"length":unknown("m","calibration_required"), "width":unknown("m","calibration_required"),
            "area":unknown("m2","calibration_required"), "depth":unknown("mm","rgb_does_not_measure_cavity_depth")}
    calibration=metadata.calibration
    if not calibration:
        return result
    try:
        ground=project_ground(mask,calibration,image_shape,at)
        (_, _), dims, _ = cv2.minAreaRect(ground.astype(np.float32))
        length,width=sorted(map(float,dims),reverse=True)
        area=float(abs(cv2.contourArea(ground.astype(np.float32))))
        if area<=1e-8: raise ValueError("degenerate_footprint")
        u=calibration.uncertainty95M
        result.update(length=measured(length,"m","calibrated_planar_major_extent",2*u),
                      width=measured(width,"m","calibrated_planar_minor_extent",2*u),
                      area=measured(area,"m2","calibrated_planar_polygon",2*(length+width)*u+math.pi*u*u))
        fix=interpolate_fix(metadata.trajectory,at,metadata.maxSyncGapMs)
        if fix:
            moments=cv2.moments(ground.astype(np.float32))
            center=np.array([moments["m10"]/moments["m00"],moments["m01"]/moments["m00"]])
            forward=float(center[0]+calibration.cameraOffsetForwardM)
            right=float(center[1]+calibration.cameraOffsetRightM)
            lat,lon=offset_coordinate(fix,forward,right)
            # Conservative sum; not a statistical independence assertion.
            heading_error=math.hypot(forward,right)*math.sin(math.radians(min(90,calibration.headingAccuracy95Deg)))
            result.update(latitude=lat,longitude=lon,locationAccuracyM=fix.horizontalAccuracy95M+u+heading_error)
    except ValueError as exc:
        for field,unit in [("length","m"),("width","m"),("area","m2")]:
            result[field]=unknown(unit,str(exc))
    # A lone antenna/phone fix is deliberately NOT labelled as defect coordinates.
    return result


def stereo_depth(disparity, focal_px: float, baseline_m: float, disparity_sigma_px: float):
    """Z=fB/d; sigma_Z = fB sigma_d/d². Invalid disparity remains NaN."""
    if min(focal_px,baseline_m,disparity_sigma_px) <= 0:
        raise ValueError("positive_stereo_calibration_required")
    d=np.asarray(disparity,dtype=np.float64)
    valid=np.isfinite(d)&(d>0)
    z=np.full_like(d,np.nan); sigma=np.full_like(d,np.nan)
    z[valid]=focal_px*baseline_m/d[valid]
    sigma[valid]=focal_px*baseline_m*disparity_sigma_px/d[valid]**2
    return z,sigma


def depression_below_plane(points, intact_points, max_residual_m: float = 0.01):
    """For an already calibrated local z-up cloud; depth is normal to intact plane.

    No RGB endpoint fabricates these points. Reject non-planar reference samples.
    Returns pointwise depressions; caller must mask occlusions and establish coverage.
    """
    intact=np.asarray(intact_points,dtype=np.float64)
    cavity=np.asarray(points,dtype=np.float64)
    if intact.ndim!=2 or intact.shape[1]!=3 or len(intact)<6 or cavity.ndim!=2 or cavity.shape[1]!=3:
        raise ValueError("insufficient_surface_points")
    if not np.isfinite(intact).all() or not np.isfinite(cavity).all():
        raise ValueError("invalid_surface_points")
    centroid=intact.mean(axis=0)
    _,singular,vh=np.linalg.svd(intact-centroid,full_matrices=False)
    if singular[1] < 1e-6:
        raise ValueError("degenerate_reference_surface")
    normal=vh[-1]
    if normal[2]<0: normal=-normal
    residual=np.abs((intact-centroid)@normal)
    if np.max(residual)>max_residual_m:
        raise ValueError("nonplanar_reference_surface")
    return np.maximum(0,-(cavity-centroid)@normal)
