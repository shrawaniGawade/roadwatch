# RoadWatch edge collector

The collector captures bounded JPEG evidence from an OpenCV webcam, authorized RTSP source, or local video file. Capture and upload run independently, so a network outage does not stop local recording until the configured disk limit. This is sampled frame acquisition, **not full-fidelity continuous video archival**. Choose sampling from vehicle speed, visible road length and required repeated views; the default one frame/second is an operator starting point, not a validated road-survey rate.

Install from the root with `uv pip install --python .venv/bin/python -e services/edge`. Provision a device through the RoadWatch API and keep its one-time token in `ROADWATCH_DEVICE_TOKEN`. Never put the token in the spool or source URLs. API connections require HTTPS except loopback development addresses.

```sh
export ROADWATCH_DEVICE_TOKEN='the-one-time-provisioned-device-token'
roadwatch-edge create-survey --device-id DEVICE_ID --name 'Morning survey' --road-id ROAD_ID
roadwatch-edge --spool ./edge-spool capture --source 0 --survey-id SURVEY_ID --interval 1
# Run separately under the host's service supervisor:
roadwatch-edge --spool ./edge-spool upload --api http://127.0.0.1:3001
roadwatch-edge --spool ./edge-spool status
roadwatch-edge --spool ./edge-spool recover
roadwatch-edge --spool ./edge-spool retry-blocked
```

The `create-survey` command uses device Bearer authentication. Upload sends multipart `file`, `surveyId`, `capturedAt` and optional `calibrationId`, together with an immutable per-capture UUID in `Idempotency-Key` and SHA-256 in `X-Content-SHA256`. Metadata supplied by a hardware adapter also preserves `latitude`, `longitude`, `locationAccuracyM`, JSON `trajectory` and `maxSyncGapMs`; the generic capture command does not acquire these values. Metadata is bounded to 256 KiB. Backend acknowledgement means that the private evidence and processing job have committed. The uploader deletes local media only after that acknowledgement. Repeated upload attempts use the same UUID; identical bytes captured at different times remain different observations. Device heartbeats include backlog counts. User/device/survey authorization is enforced by the backend, not trusted from metadata.

## Durability and bounded storage

Each accepted capture is committed in this order: write and fsync image → atomic rename → fsync JSON manifest → SQLite transaction commit (`WAL`, `synchronous=FULL`). Power loss between the manifest and SQLite commit is recoverable: `recover` verifies the image hash and adopts the manifest once. Partial files and unreferenced images are quarantined, not uploaded as complete evidence. Power loss after the server accepted an upload but before local acknowledgement is handled by the persisted idempotency key. Expired upload leases are retried.

Defaults are 2 GiB total spool capacity and 128 MiB minimum filesystem free space. Use `--max-bytes` and `--min-free-bytes` to size the full workload. At capacity the capture process stops with exit code 2 and a clear reason; it never silently evicts unacknowledged frames. Quarantine and retained SQLite audit history consume capacity too. The operational supervisor should alert on capture exit, blocked items and increasing backlog. Indefinite outages cannot be supported with finite storage.

Transport and 5xx/429 errors use bounded exponential retry. Unrecoverable 4xx errors, checksum failure, or 20 unsuccessful attempts enter `blocked`, retaining evidence. Correct the cause and invoke `retry-blocked`. No automatic credential refresh or destructive cleanup is attempted. `upload --once` makes a single eligible attempt and is useful for diagnostics.

## Timing and physical deployment limitations

OpenCV's generic collector records **host frame-receipt time**, not a verified hardware exposure timestamp. That provenance is retained in each local manifest. Do not claim millimetre survey measurements or precise moving-vehicle defect GPS from this timestamp. A hardware integration must acquire exposure timestamps, GNSS fixes/covariance, IMU attitude and synchronization status and bind the correct calibration to each observation. This CLI deliberately does not invent GPS from the camera address or a fixed configuration.

RTSP connections use FFmpeg read/open timeout parameters. USB driver behavior varies; supervise capture with a hard process-stop timeout and restart policy on the actual device. Test unplugging cameras, power removal, disk exhaustion, thermal behavior and cellular interruption before deployment. Run capture/upload as separate unprivileged supervised processes with a writable private spool, protected token environment file and TLS API egress. Spool permissions are 0700; files are 0600. Keep RTSP credentials in the device's protected service environment; command-line source URLs can otherwise appear in process listings.

Tests cover checksum corruption, full disk behavior, orphan recovery, credential rejection and idempotent retries using a mock transport. Actual camera/RTSP hardware and sustained offline field duration still require device tests.

Upstream interfaces: [OpenCV VideoCapture](https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html), [HTTPX clients](https://www.python-httpx.org/advanced/clients/), [Python sqlite3](https://docs.python.org/3/library/sqlite3.html). Current OpenCV is Apache-2.0, HTTPX is BSD-3-Clause, and Python's standard library uses the Python Software Foundation license. Verify separately licensed codec/binary components in the deployment image.
