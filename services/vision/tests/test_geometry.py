from datetime import datetime,timedelta,timezone
import numpy as np
import pytest
from roadwatch_vision.geometry import depression_below_plane,footprint_measurements,interpolate_fix,offset_coordinate,project_ground,stereo_depth
from roadwatch_vision.schema import Fix,Metadata,PlanarCalibration

T=datetime(2026,1,1,tzinfo=timezone.utc)


def calibration(**kw):
    values=dict(id="c1",kind="planar",imageWidth=100,imageHeight=100,imageToGround=[[.01,0,0],[0,.01,0],[0,0,1]],
                validRoi=[[0,0],[99,0],[99,99],[0,99]],uncertainty95M=.01,validUntil=T+timedelta(days=1))
    return PlanarCalibration(**(values|kw))


def test_analytic_planar_dimensions_and_depth_unknown():
    meta=Metadata(capturedAt=T,calibration=calibration())
    result=footprint_measurements([[10,10],[60,10],[60,40],[10,40]],meta,(100,100,3),T)
    assert result["length"]["value"]==pytest.approx(.5)
    assert result["width"]["value"]==pytest.approx(.3)
    assert result["area"]["value"]==pytest.approx(.15)
    assert result["depth"]["value"] is None
    assert result["length"]["uncertainty95"]==.02


def test_calibration_does_not_survive_resize_or_expiry():
    with pytest.raises(ValueError,match="resolution"):
        project_ground([[1,1],[20,1],[20,20]],calibration(),(200,200),T)
    with pytest.raises(ValueError,match="expired"):
        project_ground([[1,1],[20,1],[20,20]],calibration(),(100,100),T+timedelta(days=2))


def test_stereo_metric_and_uncertainty_and_invalid_disparity():
    depth,sigma=stereo_depth(np.array([20.,0.,np.nan]),800,.2,.25)
    assert depth[0]==8; assert sigma[0]==.1
    assert np.isnan(depth[1:]).all()


def test_depression_relative_to_plane_is_not_camera_range():
    ground=[[x,y,0] for x in (-1,0,1) for y in (-1,0,1)]
    result=depression_below_plane([[0,0,-.05],[0,0,.01]],ground)
    assert result.tolist()==pytest.approx([.05,0])


def test_sync_no_extrapolation_and_heading_wrap():
    a=Fix(timestamp=T,latitude=17,longitude=78,horizontalAccuracy95M=.1,headingDeg=359)
    b=Fix(timestamp=T+timedelta(milliseconds=200),latitude=17.00001,longitude=78,horizontalAccuracy95M=.2,headingDeg=1)
    midpoint=interpolate_fix([a,b],T+timedelta(milliseconds=100))
    assert midpoint.headingDeg==0
    assert midpoint.latitude==pytest.approx(17.000005)
    assert interpolate_fix([a,b],T-timedelta(milliseconds=1)) is None
    assert interpolate_fix([a,b],T+timedelta(milliseconds=100),100) is None


def test_ground_offsets_are_not_antenna_location():
    fix=Fix(timestamp=T,latitude=17,longitude=78,horizontalAccuracy95M=.1,headingDeg=0)
    north,east=offset_coordinate(fix,10,2)
    assert north>17 and east>78
    meta=Metadata(capturedAt=T,latitude=17,longitude=78)
    result=footprint_measurements([[1,1],[5,1],[5,5]],meta,(100,100),T)
    assert "latitude" not in result
