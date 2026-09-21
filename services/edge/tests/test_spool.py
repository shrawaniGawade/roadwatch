import json
import sqlite3
import httpx
import pytest
from roadwatch_edge.spool import Spool,SpoolFull
from roadwatch_edge.uploader import Uploader,validate_api


def spool(tmp_path,max_bytes=1_000_000): return Spool(tmp_path,max_bytes=max_bytes,min_free_bytes=0)
META={"surveyId":"survey-1","capturedAt":"2026-01-01T00:00:00Z"}


def test_durable_capture_recovered_after_restart(tmp_path):
    s=spool(tmp_path); identity=s.add(b"example-image-bytes",META)
    restarted=spool(tmp_path)
    assert restarted.status()["backlog"]==1
    assert restarted.claim()["id"]==identity


def test_power_loss_between_manifest_and_database_adopts_once(tmp_path):
    s=spool(tmp_path); identity=s.add(b"image",META)
    with s.connect() as db: db.execute("DELETE FROM chunks WHERE id=?",(identity,))
    assert s.recover()["adopted"]==1
    assert s.recover()["adopted"]==0


def test_large_bounded_trajectory_manifest_recovers_without_loss(tmp_path):
    s=spool(tmp_path)
    trajectory=[{"timestamp":f"2026-01-01T00:00:{i//10:02d}.{i%10}00Z","latitude":17.4,
                 "longitude":78.4,"horizontalAccuracy95M":0.8,"headingDeg":0} for i in range(600)]
    identity=s.add(b"image",{**META,"trajectory":trajectory})
    assert (tmp_path/(identity+".json")).stat().st_size>65536
    with s.connect() as db: db.execute("DELETE FROM chunks WHERE id=?",(identity,))
    assert s.recover()["adopted"]==1
    assert s.claim()["metadata"]["trajectory"]==trajectory


def test_capacity_does_not_evict_unacknowledged(tmp_path):
    s=spool(tmp_path,max_bytes=300000)
    identity=s.add(b"x"*100000,META)
    with pytest.raises(SpoolFull): s.add(b"y"*300000,META)
    assert (tmp_path/(identity+".jpg")).exists()


def test_retry_reuses_idempotency_and_only_deletes_after_receipt(tmp_path):
    s=spool(tmp_path); identity=s.add(b"image",META); calls=[]
    def handler(request):
        calls.append(request.headers["Idempotency-Key"])
        assert request.headers["Authorization"]=="Bearer secret"
        return httpx.Response(503) if len(calls)==1 else httpx.Response(201,json={"id":"receipt-1"})
    uploader=Uploader(s,"http://127.0.0.1:3001","secret",httpx.Client(transport=httpx.MockTransport(handler)))
    assert uploader.upload_one(); assert (tmp_path/(identity+".jpg")).exists()
    with s.connect() as db: db.execute("UPDATE chunks SET next_retry=0")
    assert uploader.upload_one(); assert calls==[identity,identity]
    assert not (tmp_path/(identity+".jpg")).exists()
    assert s.status()["counts"]["acknowledged"]==1
    uploader.close()


def test_bad_auth_blocks_without_deleting_evidence(tmp_path):
    s=spool(tmp_path); identity=s.add(b"image",META)
    uploader=Uploader(s,"http://localhost:3001","bad",httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(401))))
    uploader.upload_one()
    assert s.status()["counts"]["blocked"]==1
    assert (tmp_path/(identity+".jpg")).exists()
    assert s.retry_blocked()==1


def test_checksum_corruption_never_uploads(tmp_path):
    s=spool(tmp_path); identity=s.add(b"image",META); (tmp_path/(identity+".jpg")).write_bytes(b"corrupt")
    def no_request(request): raise AssertionError("Corrupt media must not be uploaded")
    Uploader(s,"http://localhost:3001","secret",httpx.Client(transport=httpx.MockTransport(no_request))).upload_one()
    assert s.status()["counts"]["blocked"]==1


def test_device_token_never_sent_over_nonlocal_http():
    with pytest.raises(ValueError,match="https"):
        validate_api("http://example.com")


def test_upload_preserves_gnss_trajectory_accuracy_and_sync_bound(tmp_path):
    from email.parser import BytesParser
    from email.policy import default
    trajectory=[{"timestamp":META["capturedAt"],"latitude":17.4,"longitude":78.4,
                 "horizontalAccuracy95M":0.8,"headingDeg":0}]
    s=spool(tmp_path)
    s.add(b"image",{**META,"trajectory":trajectory,"locationAccuracyM":0.8,"maxSyncGapMs":250,
                    "calibrationId":"camera-calibration","timestampMethod":"host_frame_receipt"})
    def handler(request):
        message=BytesParser(policy=default).parsebytes(
            b"Content-Type: "+request.headers["content-type"].encode()+b"\r\n\r\n"+request.read())
        fields={part.get_param("name",header="content-disposition"):part.get_payload(decode=True).decode()
                for part in message.iter_parts() if part.get_filename() is None}
        assert json.loads(fields["trajectory"])==trajectory
        assert fields["locationAccuracyM"]=="0.8"
        assert fields["maxSyncGapMs"]=="250"
        assert fields["calibrationId"]=="camera-calibration"
        assert "timestampMethod" not in fields # local diagnostic, unsupported by ingestion schema
        return httpx.Response(201,json={"mediaId":"test-contract-receipt"})
    uploader=Uploader(s,"http://localhost:3001","secret",httpx.Client(transport=httpx.MockTransport(handler)))
    assert uploader.upload_one()
    assert s.status()["counts"]["acknowledged"]==1
    uploader.close()
