# RoadWatch API

NestJS modules run on Node.js, with PostgreSQL as the durable source of truth. The web application proxies `/api/v1` to this API's `/v1`. API bodies use camelCase; collections return arrays. Start through the repository launcher after building `@roadwatch/domain` and this package.

## Configuration

- `DATABASE_URL`: required PostgreSQL connection string. Schema migrations use an advisory lock and run transactionally before serving traffic.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD` (or `SEED_ADMIN_*`): initialize the administrator; password must contain at least 12 characters. Existing credentials are never silently reset at startup.
- `DEMO_SEED=true`: create explicitly illustrative Hyderabad-area fixtures. No seed photographs or hazard coordinates are claimed to be observations.
- `SEED_TEAM_PASSWORD`: optional explicit password for `reviewer@roadwatch.local`, `planner@roadwatch.local`, `crew@roadwatch.local`, `viewer@roadwatch.local`.
- `STORAGE_DRIVER=local|s3`: selects the shared `@roadwatch/storage` adapter. Local uses absolute `STORAGE_DIR` on a persistent encrypted volume. S3 uses `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT` and `S3_KMS_KEY_ID`; IAM credentials remain server-side. Objects use generated keys, checksum validation and private authenticated playback; no public static directory is mounted.
- `VISION_URL`, `VISION_SERVICE_KEY`: authenticated Python inference service. Missing/incompatible models fail persisted jobs with an explicit reason. Media is retained and jobs can be retried after configuration is corrected.
- `ALLOWED_ORIGINS`: comma-separated exact trusted browser origins. Cookie-authenticated writes require a matching Origin header.
- `COOKIE_SECURE`: set `true` behind HTTPS. Defaults to true in production; localhost development can explicitly set false.
- `API_HOST`, `API_PORT` (or `PORT`): defaults `127.0.0.1:3001`; containers bind `0.0.0.0`.
- `WORKER_ENABLED=false`: disable the in-process leased job worker when separately operating a worker process.
- `POSTGIS_REQUIRED=true`: production startup fails if PostGIS cannot be enabled. Local development permits bounded tangent-plane geometry calculations and reports `spatialMode: local_approximation`. PostGIS installations receive geometry columns, synchronization triggers and geography GiST indexes. Tenant-scoped ST_DWithin and spheroidal ST_Distance gate and rank road candidates. Display chainage still uses an approximate local projection; road attribution requires review.

## Durable boundaries

Sessions are random opaque tokens; only SHA256 digests persist. Passwords use salted scrypt. Every data-access query includes tenant scope. Mutations enforce role checks; administrator changes revoke affected sessions and cannot remove the last active administrator. Cookie-authenticated browser writes enforce Origin checks. Login failure limits persist in PostgreSQL.

Reviews and maintenance transitions take an `expectedVersion`; row locking and version checks prevent lost updates. Assignment locks confirmed defects atomically. Repair verification requires an authorized person other than the person who reported the repair. Reopening a work order returns it to assigned and requires another deliberate start. Review confirmation does not upgrade measurement provenance.

Uploads accept one JPEG, PNG, WebP, MP4 or WebM file up to 32 MiB; signatures and optional `X-Content-SHA256` are checked. Device bearer tokens may only upload to their own surveys, start/complete those surveys and send heartbeat data. Administrators can revoke a device credential immediately or rotate it with a one-time token response; these operations are audited. `Idempotency-Key` replays return the same durable receipt; reuse with different content or metadata fails. Disk writes are synced before the database transaction creates media, job, receipt and audit records. Uncommitted files are deleted on handled errors. Process crashes can leave orphan files: the operational retention/reconciliation job must inventory these separately before deletion.

The job queue uses PostgreSQL row leases with `FOR UPDATE SKIP LOCKED`, a three-minute lease, two-minute inference timeout and three attempts per retry cycle. Workers commit model results and defect/evidence records in one transaction fenced by the current lease token. Queue payloads reference private media. Retrying a failed job preserves attempts and audit history. A missing model returns an actionable failed job; it never produces mock detections.

`POST /v1/jobs/:id/observations/:index/locate` lets reviewers/admins place a retained unlocated observation using roadId, latitude, longitude and description. It preserves source model, evidence/mask and measurements, leaves coordinate accuracy unknown, and creates a candidate. Repeating the request for the same observation returns its existing defect; review and work-order steps follow normally. Authorized private media playback supports byte ranges with a bounded 32 MiB read through either storage adapter.

Every audited business mutation inserts an outbox event in the same transaction. The automation process owns outbox publication and notification delivery. Queue and workflow retries require consumer idempotency. Optional notifications routes return an empty array before automation schema initialization.

## Calibrations and location

`POST /v1/calibrations` records deviceId, method, notes and optional `projection`. The latter is a strict planar homography object matching the Python `PlanarCalibration` schema, except that the API generates its id. It includes imageWidth/imageHeight, imageToGround, validRoi, uncertainty95M, validUntil, optional cameraMatrix/distortion, offsets and heading uncertainty. Stored parameters are declared and unverified; geometry remains estimated. A metadata-only calibration does not certify physical accuracy.

Uploads may include `trajectory` as JSON and `maxSyncGapMs`. Each fix includes timestamp, latitude, longitude, horizontalAccuracy95M and optional headingDeg. The worker forwards only vision metadata fields. Vehicle coordinates alone never become a defect location. Detections without projected coordinates or unambiguous nearby-road candidates remain in the persisted job result with `inspectionRequired`; raw detections and evidence are retained. Separate observations are never merged solely by a distance threshold; possibleDuplicateIds are reviewer hints. Evidence preserves model/pipeline, calibration id, frame index, dimensions and time offset. Video timestamps are chunk-start plus explicitly unverified frame offsets, not claimed exact frame exposures. The queue result includes these counts and the full model output.

## Policy and reports

Settings accept only documented priority overrides: `defaultTrafficExposure`, `defaultVulnerableContext`, `defaultGrowthScore` (0–100). Changes recalculate all open defect assessments atomically, increment record versions and retain assumed-factor provenance. Reference depth rules are a planning reference, not an adopted engineering standard. Custom weights and thresholds require a reviewed domain-policy extension rather than silently accepting ignored JSON.

Bulk CSV/GeoJSON/summary exports require admin, planner or reviewer roles and are audited. Reports retain unknown values and measurement provenance; CSV sanitizes formula-leading cells. Run `npm run build --workspace @roadwatch/api` then `npm test --workspace @roadwatch/api`. Repository integration tests exercise actual PostgreSQL and full API lifecycles separately.
