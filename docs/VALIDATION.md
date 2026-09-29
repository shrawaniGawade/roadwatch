# Validation record

Executed on 8 September 2026 on macOS arm64. This record describes the implementation
and checks actually run; it does not certify a road survey or deployed service.

## Automated checks

| Check | Result | Evidence covered |
|---|---|---|
| `npm run build` | Passed | Shared domain/storage, NestJS compilation, Next.js production build |
| `npm test` | 18 passed | Scoring boundaries, unknown dimensions, geometry, lifecycle rules, credentials, roles/origin checks, file storage, S3 command/checksum contracts, overdue rules |
| `npm run test:vision` | 29 passed | Image validation, model availability/approval checks, segmentation decoding, calibration and timing math, dataset validation, offline spool and crash recovery |
| `npm run test:integration` | 16 passed | Actual HTTP/PostgreSQL workflows, isolated tenants, roles and sessions, device credentials, policy updates, durable uploads, failure auditing, worker HTTP metadata and evidence localization |
| `npm run test:e2e` | 4 passed | Chromium login and eight workspace views, rendered map, persisted manual reporting, authenticated CSV download, mobile navigation and overflow |
| `npm audit --omit=dev --audit-level=high` | Passed; zero reported vulnerabilities | npm production dependency advisories at check time |

Total: **67 passing automated test cases**, plus the runtime and recovery checks below.
Python tests emitted two upstream deprecation warnings from Starlette/AnyIO test
helpers. They did not fail the checks. An advisory scan is not a security audit.

API integration fixtures use temporary tenants and generated credentials and remove
only their own rows and evidence afterward. Browser tests use the explicit local
demonstration workspace; the created observation is verified after reload, then
removed with a version/status check. Export/login audit records remain accountable.

## Upload and inference path

The initial 12 MiB upload test exposed Next.js proxy truncation. The application now
has a streaming upload App Route that forwards to a fixed API origin. Regression
checks passed for a 12 MiB file with matching SHA-256, repeat idempotency keys, changed
metadata rejection, private byte-range playback, invalid Origin rejection and the
API's 32 MiB file limit. JSON uploads are rejected at the multipart boundary.

A pinned ONNX artifact was downloaded and verified against SHA-256
`a8553eb1dd0113fa8d7c8985e21f3a50f8ee641e2fa2a4efc93b14c93932fc5b`.
The complete local path was exercised using the attributed public-domain pothole
photograph in `tests/fixtures`:

1. Authenticate through the web application and create a demonstration survey.
2. Upload the original JPEG with an idempotency key and checksum.
3. Store private evidence, execute the persisted job and run real ONNX inference.
4. Retain **one pothole observation**, confidence **0.911373**, with a **69-point mask**.
5. Retain **one unlocated observation** and create **zero mapped road defects** because
   the photograph has no known geographic location.
6. Preserve unknown physical dimensions, retrieve byte-identical private evidence,
   and complete the survey.
7. Open the result in Chromium and verify that the original image and segmentation
   polygon render without JavaScript errors.

This is a positive runtime smoke test, not a precision/recall benchmark. Its upload
timestamp is synthetic. The photo has no surveyed dimensions or ground-truth mask.
`npm run smoke:model` reproduces the API check in an explicit demo workspace with
an enabled model. It leaves a clearly named, unlocated photo survey for inspection.

The downloaded baseline is pothole-only and experimental. Its embedded AGPL license
and publisher MIT label conflict; training data provenance is unavailable. Production
rejects this experimental manifest. See [the model notice](../models/BASELINE-NOTICE.md).

## Runtime and production routing

`npm run dev` was started successfully with PostgreSQL, the NestJS API, FastAPI
vision service, automation worker and Next.js UI. API readiness reported connected
PostgreSQL, local evidence storage, an experimental model ready for local inference,
and a fresh automation heartbeat.

A separate Next.js production server on port 3002 was tested and stopped. Health
requests passed through its production rewrite, while the exact upload route
enforced content type and authentication. Rewrites use the **build-time** API origin;
the upload route uses its **runtime** origin. The Dockerfile and Compose configuration
supply matching values. The public map style is also a build-time setting.

Local PostgreSQL is version 14.24 without PostGIS. This environment explicitly reports
`local_approximation`. Docker/Compose and remote GitHub Actions have **not** been run
here. The deployment definition and CI require PostGIS rather than silently accepting
that fallback.

## Recovery drill

With application writes stopped, `scripts/backup.mjs` created a custom-format
PostgreSQL dump and private evidence copy. The dump was restored into the separate
database `roadwatch_restore_validation`:

- Restored snapshot: **8 roads, 20 defects and 5 users**. These include illustrative
  seed data and early test fixtures present at snapshot time.
- Both evidence files matched the backup manifest, database sizes and SHA-256 hashes.
- A temporary API on port 3004 used the restored database and separate evidence copy.
- Existing administrator authentication, the dashboard and authenticated retrieval
  of both private objects passed. The temporary API was stopped afterward.

This validates the local backup/restore path on one host. Off-host recovery, S3 object
version recovery, point-in-time recovery, restore timing at fleet scale and a live
cutover have not been exercised.

## Remaining field and deployment acceptance

Before operational use, supply and validate:

- Permitted authority road geometry, source identifiers, road ownership and revision
  history; a licensed map style; approved camera/CCTV access.
- Actual vehicle or fixed-camera calibration, sensor drivers, synchronized exposure
  timestamps and GNSS/IMU quality. The included generic collector records host receipt
  time; stereo geometry is a library rather than a connected sensor driver.
- Rights-cleared multi-class training data, approved model weights and independent
  field measurements of detection, localization and dimension error across operating
  conditions. RGB alone does not measure cavity depth or pavement-layer thickness.
- An approved severity/maintenance policy, incident response ownership and field
  verification procedures. Reference scores are not certified PCI/IRI.
- Target-environment PostGIS/container checks, real S3 integration if selected,
  HTTPS/identity configuration, monitoring, load testing and off-host recovery.

Automatic survey coverage calculation, evidence expiry, plate/face redaction,
external SMS/email delivery and deployment-specific telemetry exporters are not
implemented. Coverage in seed data is illustrative; retention settings record policy
without deleting evidence. Notifications currently remain inside the application.

Local detailed records are `.artifacts/real-model-smoke.json`,
`.artifacts/restore-validation.json`, and `.artifacts/screenshots/`. They are excluded
from Git together with credentials, evidence, database files and model weights.
