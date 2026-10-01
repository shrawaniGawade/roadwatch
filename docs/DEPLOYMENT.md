# Operating RoadWatch

This repository contains a running application, test suite and deployment configuration.
Infrastructure configuration is not evidence of a deployed or field-qualified system.
The validation record distinguishes locally exercised paths from external dependencies.

## Local development

Use Node.js 24, Python 3.12, `uv`, PostgreSQL 14+ and npm. On this workstation
PostgreSQL runs in `.local/postgres` on loopback port 55432; it has a separate data
directory and does not modify a system PostgreSQL cluster. The local cluster uses
trust authentication and must never be exposed to a network.

```sh
npm run setup
npm run dev
```

Setup generates `.env` and `.local/credentials.txt` with mode 0600. It never replaces
existing credentials. Changing the seed password environment variable does not change
an existing account: use Administration to rotate it. Local fixture accounts are
created only when explicit seed credentials are supplied. `DEMO_SEED=true` adds
illustrative roads and defects; it is false in the production Compose definition.

The launcher starts the API, vision service, automation worker and Next.js process.
Ctrl+C stops these processes. `npm run db:stop` separately stops the development
database. Code changes to the API require a restart; Next.js refreshes UI edits.

## Containers and HTTPS

Copy `infra/production.env.example` to a private file such as `.env.compose.local`,
fill its variables, then run:

```sh
docker compose --env-file .env.compose.local up --build -d
docker compose --env-file .env.compose.local logs --tail=100 api vision automation
```

The database and vision service have no published ports. Web binds host loopback 3000.
Terminate TLS through the sample Caddy configuration or an equivalent gateway. Set
APP_ORIGIN exactly to the browser's HTTPS origin, including any nonstandard port.
The API issues Secure cookies in production. HTTP is only for local development.
Next.js rewrites are built into the application. Set `API_ORIGIN` consistently at
image build and runtime; Compose already uses `http://api:3001` for both. Set a licensed
`NEXT_PUBLIC_MAP_STYLE_URL` before building to include a basemap. Without it, the UI
draws registered road geometry on a plain background. Rebuild after changing either
public map configuration or the rewrite origin.
Do not set trust-proxy broadly; explicitly configure your ingress and client-address
handling before applying fleet-wide rate limits behind multiple proxies.

`POSTGIS_REQUIRED=true` prevents silent spatial fallback in production. The API
initializes spatial columns, indexes and geometry triggers when PostGIS is present.
Use a migration account for initial schema setup and a reduced-privilege application
role once your deployment separates schema changes from process startup. The supplied
Compose database account is for a controlled single-host deployment; it is not a
complete managed-database IAM configuration.

Docker and PostGIS were not available on the implementation workstation. The local
application uses explicit `local_approximation` spatial mode. CI is configured with
PostGIS, but a checked-in CI file does not mean its remote job has run.

## Evidence storage

Local storage uses generated tenant/object UUID keys, exclusive writes, restrictive
permissions, file and directory fsync, and SHA-256 verification. To run API replicas,
use the S3 driver or a correctly shared private filesystem; do not give each replica
an independent local evidence directory.

Configure S3 with `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION` (or AWS_REGION), optional
`S3_KMS_KEY_ID`, and the AWS SDK workload credential provider chain. An optional
`S3_ENDPOINT` supports an approved compatible service. Compose forwards these storage
settings and permits API outbound connectivity. Supply workload credentials through
your hosting environment or a private Compose override; the example does not embed
AWS keys. No credential is sent to the
browser. Objects use AES-256 encryption or KMS, upload checksums and conditional
creation. Enable Block Public Access, versioning, private bucket policy and recovery
retention. The sample bucket policy only denies insecure transport; attach a least
privilege workload policy for GetObject/PutObject/DeleteObject and required KMS actions.
SDK tests exercise command construction and corrupt-object rejection; a real S3
account/bucket integration must be validated in the target environment.

The UI's evidence retention field records an audited policy. **Automatic evidence
deletion is not enabled.** Add jurisdiction-approved legal holds, repair warranty
retention, redaction and deletion review before enabling expiry. Object lifecycle
rules must never expire still-referenced evidence independently of database policy.

## Detection and physical measurements

The service starts without a model but returns HTTP 503 for inference until configured.
The optional downloaded YOLOv8n baseline is experimental and pothole-only; production
rejects experimental artifacts by default. Its license conflict and missing training provenance are recorded in
`models/BASELINE-NOTICE.md`. Train and approve a model using the vision tools and local
held-out data. Approval is an engineering release process, not a magic manifest flag.

For an explicitly authorized production trial, mount a checksummed model and manifest
under `models/`, set `CONTAINER_MODEL_MANIFEST` to its `/models/.../manifest.json` path,
and set both `VISION_ALLOW_EXPERIMENTAL_MODEL=true` and
`VISION_ALLOW_PRODUCTION_TRIAL=true` in the private Compose environment file. The UI
labels every result experimental. These flags do not make a model field validated.
The RF-DETR ONNX detection adapter supports four RDD2022 road classes but returns
boxes, not measured defect footprints; length, area and depth remain unknown.

Ordinary RGB can supply visual observations. Physical length/area need validated
calibration and visibility; depth needs stereo/3D or an independent field measurement.
The implemented stereo math is a library, not a connected stereo sensor driver.
Host receipt timestamps from USB/RTSP cameras are not hardware exposure timestamps.
Validate clock alignment, rolling shutter, vibration, lens distortion, GNSS covariance,
heading, camera offsets and survey procedures on the actual vehicle before field use.

Unlocated observations remain available in job results and can be located by an
authorized reviewer. Their manually selected location retains unknown accuracy.
Fixed CCTV needs a surveyed camera-to-ground relationship. Mobile mapping and precise
geospatial storage/processing must comply with the relevant country's requirements;
for an Indian rollout, consult the source-backed design report's entity and location
constraints before selecting a cloud provider.

## Reliability and monitoring

Uploads are acknowledged after private-object write and PostgreSQL media/job commit.
An idempotency key binds bytes and metadata. Worker leases survive API restarts and
use bounded retries. This is at-least-once job execution with transactionally
idempotent result commits; it is not a promise of exactly-once delivery over a network.
Failed jobs are retained, inspectable and retryable. A malformed or unavailable model
does not remove evidence. Infrastructure operators must monitor orphaned object
growth after process/power failures between object write and transaction commit.

The SQL outbox and internal inbox persist workflow events and overdue-order alerts.
They do not send email, SMS or external webhooks. Install a delivery adapter only
after destinations, retries and consent are explicitly configured. RabbitMQ and
Temporal from the architectural options are not runtime dependencies: PostgreSQL
leases and transactions provide the current durable queue/workflow state.

Probe `/v1/health` for API liveness and `/v1/ready` for database/spatial/model status.
Vision `/health` is process liveness; `/ready` identifies missing, incompatible or
unapproved models. An application can be usable for manual review while inference
is unavailable. Alert on failed/old queued jobs, expired leases, offline devices,
automation heartbeat age, storage errors, request failures and backup age. Centralize
logs with access controls; add deployment-specific OpenTelemetry/exporter wiring
before setting an operational SLO. Do not log cookies, device tokens or camera URLs.

## Backup, restore and release

Run `node scripts/backup.mjs` with writes stopped for a coordinated database/evidence
snapshot. Protect the destination: exports contain private evidence and password
hashes. The helper uses pg_dump custom format and stores local evidence hashes.
For S3, maintain a separate versioned object backup. A database dump alone is not a
full recovery plan.

Restore into a separate empty database with `pg_restore --no-owner`, attach a separate
evidence copy, compare manifest hashes against media records, then run authentication,
map, private-evidence and maintenance smoke tests. Only cut over after verification.
Use point-in-time recovery and off-host encrypted backups for actual operations.

Release with locked dependencies, `npm run build`, `npm test`, Python tests, API
integration tests and browser tests. Evaluate model precision/recall by class,
lighting, rain, camera and region; measure false urgent alerts and location/size
errors on independent ground truth. Load-test the intended fleet and model hardware,
run a restore drill, test camera connectivity loss and verify the authority's
maintenance priority policy before expanding coverage. No application test can
replace this physical and operational acceptance work.
