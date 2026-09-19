import io
import json
from fastapi.testclient import TestClient
import numpy as np
from PIL import Image
import pytest
from roadwatch_vision.app import create_app
from roadwatch_vision.config import Settings
from roadwatch_vision.models import load_model

KEY="integration-test-service-key-not-production"
META=json.dumps({"capturedAt":"2026-01-01T00:00:00Z"})


def image_bytes():
    rng=np.random.default_rng(123)
    buffer=io.BytesIO(); Image.fromarray(rng.integers(10,230,(64,64,3),dtype=np.uint8)).save(buffer,format="PNG")
    return buffer.getvalue()


def client(path=None,**kw):
    return TestClient(create_app(Settings(service_key=KEY,manifest_path=path,allow_experimental=True,**kw)))


def test_health_and_missing_model_are_honest():
    c=client()
    assert c.get("/health").status_code==200
    assert c.get("/ready").status_code==503
    response=c.post("/v1/analyze",headers={"X-Service-Key":KEY},data={"metadata":META},files={"file":("road.png",image_bytes(),"image/png")})
    assert response.status_code==503
    assert response.json()["message"]=="model_not_configured"


@pytest.mark.parametrize("headers",[{}, {"X-Service-Key":"wrong"}, {"Authorization":"Bearer "+KEY}])
def test_spoofed_auth_rejected_before_multipart(headers):
    response=client().post("/v1/analyze",headers=headers,content=b"not-even-multipart")
    assert response.status_code==401


def test_invalid_media_rejected_with_real_onnx_runtime(onnx_manifest):
    response=client(onnx_manifest).post("/v1/analyze",headers={"X-Service-Key":KEY},data={"metadata":META},files={"file":("fake.png",b"not-a-picture","image/png")})
    assert response.status_code==422
    assert response.json()["message"]=="unsupported_or_invalid_media"


def test_real_onnx_contract_round_trip_unknown_measurement(onnx_manifest):
    response=client(onnx_manifest).post("/v1/analyze",headers={"X-Service-Key":KEY},data={"metadata":META},files={"file":("road.png",image_bytes(),"image/png")})
    assert response.status_code==200,response.text
    body=response.json()
    assert body["frameCount"]==1
    assert body["model"]["validationStatus"]=="experimental"
    manifest=json.loads(onnx_manifest.read_text())
    assert body["model"]["artifactSha256"]==manifest["sha256"]
    assert body["model"]["datasetManifestSha256"]==manifest["datasetManifestSha256"]
    assert body["timing"]["reference"]=="submitted_capture_time"
    assert body["timing"]["videoFrameOffsets"]=="not_applicable"
    assert body["detections"][0]["type"]=="pothole"
    assert body["detections"][0]["depth"]["value"] is None
    assert "latitude" not in body["detections"][0]


def test_experimental_artifact_not_enabled_implicitly(onnx_manifest):
    with pytest.raises(ValueError,match="experimental_model_not_enabled"):
        load_model(onnx_manifest)


def test_checksum_tampering_fails(onnx_manifest):
    data=json.loads(onnx_manifest.read_text()); data["sha256"]="f"*64; onnx_manifest.write_text(json.dumps(data))
    assert client(onnx_manifest).get("/ready").status_code==503


def test_production_rejects_experimental_even_when_enabled(onnx_manifest,monkeypatch):
    monkeypatch.setenv("NODE_ENV","production")
    assert client(onnx_manifest).get("/ready").status_code==503


def test_bound_request_and_metadata_validation(onnx_manifest):
    c=client(onnx_manifest,max_upload_bytes=1024)
    response=c.post("/v1/analyze",headers={"X-Service-Key":KEY,"Content-Length":"99999999"},content=b"x")
    assert response.status_code==413
    response=c.post("/v1/analyze",headers={"X-Service-Key":KEY},data={"metadata":'{"capturedAt":"2026-01-01T00:00:00","latitude":17}'},files={"file":("x",b"x")})
    assert response.status_code==422
