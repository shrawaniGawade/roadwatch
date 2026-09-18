import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { createEvidenceStore } from '@roadwatch/storage';
import { z } from 'zod';
import {
  defectTypes,
  haversineM,
  measurementSchema,
  nearestPointOnRoad,
  unknownMeasurement,
} from '@roadwatch/domain';
import { Database } from './database';
import { AssetsService } from './assets.service';
import { Principal, requireRole } from './security';
import { digest } from './credentials';
import { audit, identifier, now, parse, uuid } from './utils';
import { assessmentFor } from './findings.service';

const optionalNumber = z.preprocess(
  (v) => (v === '' || v === undefined ? undefined : Number(v)),
  z.number().finite().optional(),
);
const decodeJson = (value: unknown) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return Symbol('invalid_json');
  }
};
const trajectoryFix = z
  .object({
    timestamp: z.string().datetime({ offset: true }),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    horizontalAccuracy95M: z.number().positive().max(10000),
    headingDeg: z.number().min(0).lt(360).nullable().optional(),
  })
  .strict();
const metadataSchema = z
  .object({
    surveyId: z.string().uuid(),
    capturedAt: z.string().datetime({ offset: true }),
    latitude: optionalNumber.refine((v) => v === undefined || (v >= -90 && v <= 90)),
    longitude: optionalNumber.refine((v) => v === undefined || (v >= -180 && v <= 180)),
    locationAccuracyM: optionalNumber.refine((v) => v === undefined || (v > 0 && v <= 10000)),
    calibrationId: z.preprocess((v) => (v === '' ? undefined : v), z.string().uuid().optional()),
    trajectory: z.preprocess(decodeJson, z.array(trajectoryFix).max(2000).optional()),
    maxSyncGapMs: z.preprocess(
      (v) => (v === undefined ? undefined : Number(v)),
      z.number().int().positive().max(2000).optional(),
    ),
  })
  .strict()
  .refine(
    (v) => (v.latitude === undefined) === (v.longitude === undefined),
    'Latitude and longitude must be supplied together.',
  );
const detectionSchema = z
  .object({
    type: z.enum(defectTypes),
    confidence: z.number().min(0).max(1),
    mask: z.array(z.array(z.number().finite())).max(10000),
    bbox: z.array(z.number().finite()).length(4),
    length: measurementSchema.optional(),
    width: measurementSchema.optional(),
    depth: measurementSchema.optional(),
    area: measurementSchema.optional(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    locationAccuracyM: z.number().nonnegative().nullish(),
    timeOffsetMs: z.number().int().nonnegative().max(3600000).optional(),
    frameIndex: z.number().int().nonnegative().optional(),
    widthPx: z.number().int().positive().max(16384).optional(),
    heightPx: z.number().int().positive().max(16384).optional(),
  })
  .passthrough();
const resultSchema = z
  .object({
    pipelineVersion: z.string().min(1),
    model: z.object({ name: z.string(), version: z.string(), ready: z.boolean() }).passthrough(),
    quality: z.object({ eligible: z.boolean(), reasons: z.array(z.string()) }).passthrough(),
    detections: z.array(detectionSchema).max(10000),
    frameCount: z.number().int().nonnegative(),
  })
  .passthrough();
export function mediaType(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return null;
}
function publicJob(row: any) {
  return {
    id: row.id,
    surveyId: row.survey_id,
    mediaId: row.media_id,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    pipelineVersion: row.pipeline_version,
    result: row.result || null,
  };
}
@Injectable()
export class MediaService implements OnModuleInit, OnModuleDestroy {
  readonly evidenceStore = createEvidenceStore();
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private activeAbort?: AbortController;
  constructor(
    @Inject(Database) readonly db: Database,
    @Inject(AssetsService) readonly assets: AssetsService,
  ) {}
  async onModuleInit() {
    if (process.env.WORKER_ENABLED !== 'false') {
      this.timer = setInterval(() => void this.tick(), 1500);
      this.timer.unref();
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.activeAbort?.abort();
    await this.evidenceStore.close?.();
  }
  async upload(
    actor: Principal,
    file: Express.Multer.File | undefined,
    body: unknown,
    key?: string,
    expectedChecksum?: string,
  ) {
    requireRole(actor, 'admin', 'planner', 'crew', 'device');
    if (!file || !file.buffer || file.buffer.length === 0)
      throw new BadRequestException('A nonempty media file is required.');
    const metadata = parse(metadataSchema, body),
      mime = mediaType(file.buffer);
    if (!mime)
      throw new UnsupportedMediaTypeException(
        'Supported media: JPEG, PNG, WebP, MP4 and WebM with valid file signatures.',
      );
    const sha256 = digest(file.buffer);
    if (expectedChecksum && expectedChecksum.toLowerCase() !== sha256)
      throw new BadRequestException('The media checksum does not match X-Content-SHA256.');
    const idempotencyKey = parse(
      z
        .string()
        .min(1)
        .max(160)
        .regex(/^[A-Za-z0-9:_-]+$/),
      key || digest(`${metadata.surveyId}:${metadata.capturedAt}:${sha256}`),
    );
    const requestHash = digest(JSON.stringify({ ...metadata, sha256 }));
    const id = uuid(),
      jobId = uuid(),
      storageKey = `${actor.tenantId}/${id}`;
    await this.evidenceStore.put(storageKey, file.buffer);
    let retained = false;
    try {
      return await this.db
        .tx(async (c) => {
          await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `${actor.tenantId}:${idempotencyKey}`,
          ]);
          const survey = await this.assets.get(actor, 'surveys', metadata.surveyId, c, true);
          if (actor.deviceId && survey.deviceId !== actor.deviceId)
            throw new ForbiddenException('Device cannot upload to another device survey.');
          const previous = (
            await c.query(
              'SELECT * FROM upload_requests WHERE tenant_id=$1 AND idempotency_key=$2',
              [actor.tenantId, idempotencyKey],
            )
          ).rows[0];
          if (previous) {
            if (previous.request_hash !== requestHash)
              throw new ConflictException(
                'Idempotency key was already used for different media or metadata.',
              );
            const job = (
              await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2', [
                actor.tenantId,
                previous.job_id,
              ])
            ).rows[0];
            return {
              mediaId: previous.media_id,
              jobId: job.id,
              sha256,
              job: publicJob(job),
              duplicate: true,
            };
          }
          if (survey.status !== 'active')
            throw new ConflictException(
              'Create or select an active survey before uploading media.',
            );
          if (metadata.calibrationId) {
            const calibration = await this.assets.get(
              actor,
              'calibrations',
              metadata.calibrationId,
              c,
            );
            if (calibration.deviceId !== survey.deviceId)
              throw new BadRequestException('Calibration does not belong to the survey device.');
          }
          const filename =
            file.originalname.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 200) || 'evidence';
          await c.query(
            'INSERT INTO media(id,tenant_id,survey_id,filename,mime_type,storage_key,sha256,size_bytes,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              id,
              actor.tenantId,
              survey.id,
              filename,
              mime,
              storageKey,
              sha256,
              file.buffer.length,
              JSON.stringify(metadata),
            ],
          );
          const job = (
            await c.query(
              'INSERT INTO jobs(id,tenant_id,survey_id,media_id) VALUES($1,$2,$3,$4) RETURNING *',
              [jobId, actor.tenantId, survey.id, id],
            )
          ).rows[0];
          await c.query(
            'INSERT INTO upload_requests(tenant_id,idempotency_key,sha256,request_hash,survey_id,media_id,job_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [actor.tenantId, idempotencyKey, sha256, requestHash, survey.id, id, jobId],
          );
          await audit(c, actor, 'media.uploaded', 'media', id, {
            sha256,
            jobId,
            surveyId: survey.id,
            sizeBytes: file.buffer.length,
          });
          // Retention is set only after the transaction promise commits below.
          return { mediaId: id, jobId, sha256, job: publicJob(job), duplicate: false };
        })
        .then((receipt) => {
          retained = !receipt.duplicate;
          return receipt;
        });
    } finally {
      if (!retained) await this.evidenceStore.remove(storageKey).catch(() => undefined);
    }
  }
  async jobs(actor: Principal) {
    return (
      await this.db.query(
        'SELECT * FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500',
        [actor.tenantId],
      )
    ).rows.map(publicJob);
  }
  async retry(actor: Principal, id: string) {
    requireRole(actor, 'admin', 'planner');
    identifier(id);
    return this.db.tx(async (c) => {
      const row = (
        await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
          actor.tenantId,
          id,
        ])
      ).rows[0];
      if (!row) throw new BadRequestException('Job was not found.');
      if (row.status !== 'failed') throw new ConflictException('Only failed jobs may be retried.');
      const job = (
        await c.query(
          "UPDATE jobs SET status='queued',error=NULL,retry_limit=attempts+3,available_at=now(),lease_until=NULL,lease_token=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
          [actor.tenantId, id],
        )
      ).rows[0];
      await audit(c, actor, 'job.retry_requested', 'job', id, { previousError: row.error });
      return publicJob(job);
    });
  }
  async locateObservation(actor: Principal, id: string, indexText: string, body: unknown) {
    requireRole(actor, 'admin', 'reviewer');
    identifier(id);
    const index = parse(z.coerce.number().int().nonnegative(), indexText);
    const input = parse(
      z
        .object({
          roadId: z.string().uuid(),
          latitude: z.number().finite().min(-90).max(90),
          longitude: z.number().finite().min(-180).max(180),
          description: z.string().trim().min(5).max(4000),
        })
        .strict(),
      body,
    );
    return this.db.tx(async (c) => {
      const job = (
        await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
          actor.tenantId,
          id,
        ])
      ).rows[0];
      if (!job) throw new BadRequestException('Processing job was not found.');
      if (job.status !== 'completed' || !job.result?.detections)
        throw new ConflictException('Only completed inference observations can be located.');
      const parsed = parse(resultSchema, job.result),
        detection = parsed.detections[index];
      if (!detection)
        throw new BadRequestException('Observation index is outside the retained result.');
      const mapping = job.result.observationDefectIds || {};
      if (mapping[String(index)])
        return this.assets.get(actor, 'defects', mapping[String(index)], c);
      const road = await this.assets.get(actor, 'roads', input.roadId, c),
        match = (
          await this.assets.nearbyRoads(actor, [input.longitude, input.latitude], 100, [road.id], c)
        )[0];
      if (!match)
        throw new BadRequestException('Place the observation within 100 m of the selected road.');
      const media = (
        await c.query('SELECT * FROM media WHERE tenant_id=$1 AND id=$2', [
          actor.tenantId,
          job.media_id,
        ])
      ).rows[0];
      const segments = (await this.assets.list(actor, 'segments', c)).filter(
          (s) => s.roadId === road.id,
        ),
        settings = await this.assets.settings(actor, c);
      const depth = detection.depth || unknownMeasurement('mm'),
        assessment = assessmentFor({ type: detection.type, depthMm: depth.value }, settings),
        defectId = uuid();
      const evidence = {
        id: uuid(),
        mediaId: media.id,
        url: `/api/v1/media/${media.id}`,
        filename: media.filename,
        mimeType: media.mime_type,
        capturedAt: media.metadata.capturedAt,
        sha256: media.sha256,
        mask: detection.mask,
        width: detection.widthPx,
        height: detection.heightPx,
        timeOffsetMs: detection.timeOffsetMs,
        frameIndex: detection.frameIndex,
        calibrationId: media.metadata.calibrationId || null,
        observationIndex: index,
        model: parsed.model,
        pipelineVersion: parsed.pipelineVersion,
        timingBasis: media.mime_type.startsWith('video/')
          ? 'chunk_start_plus_unverified_frame_offset'
          : 'image_capture',
      };
      const defect = {
        id: defectId,
        code: `RW-${defectId.slice(0, 8).toUpperCase()}`,
        roadId: road.id,
        roadName: road.name,
        segmentId:
          segments.find(
            (s) => s.chainageStartM <= match.chainageM && s.chainageEndM >= match.chainageM,
          )?.id || null,
        type: detection.type,
        status: 'candidate',
        priority: assessment.priority,
        severity: assessment.severity,
        latitude: input.latitude,
        longitude: input.longitude,
        locationAccuracyM: null,
        chainageM: match.chainageM,
        description: input.description,
        length: detection.length || unknownMeasurement('m'),
        width: detection.width || unknownMeasurement('m'),
        depth,
        area: detection.area || unknownMeasurement('m2'),
        confidence: detection.confidence,
        source: 'vision_manual_location',
        observedAt: media.metadata.capturedAt,
        updatedAt: now(),
        version: 1,
        evidence: [evidence],
        assessment,
        locationMethod: 'reviewer_map_selection',
        model: parsed.model,
        pipelineVersion: parsed.pipelineVersion,
        jobId: id,
        observationIndex: index,
        timeOffsetMs: detection.timeOffsetMs,
        timingBasis: evidence.timingBasis,
      };
      await c.query(
        'INSERT INTO defects(id,tenant_id,road_id,segment_id,data) VALUES($1,$2,$3,$4,$5)',
        [defectId, actor.tenantId, road.id, defect.segmentId, JSON.stringify(defect)],
      );
      await c.query(
        'INSERT INTO evidence(id,tenant_id,media_id,defect_id,data) VALUES($1,$2,$3,$4,$5)',
        [evidence.id, actor.tenantId, media.id, defectId, JSON.stringify(evidence)],
      );
      mapping[String(index)] = defectId;
      const unlocated = Math.max(0, (job.result.unlocatedDetections || 0) - 1);
      const result = {
        ...job.result,
        observationDefectIds: mapping,
        defectIds: [...new Set([...(job.result.defectIds || []), defectId])],
        createdDefects: (job.result.createdDefects || 0) + 1,
        unlocatedDetections: unlocated,
        inspectionRequired: unlocated > 0,
      };
      await c.query('UPDATE jobs SET result=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        id,
        JSON.stringify(result),
      ]);
      const survey = await this.assets.get(actor, 'surveys', job.survey_id, c, true);
      survey.defectsDetected++;
      await c.query('UPDATE surveys SET data=$3 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        survey.id,
        JSON.stringify(survey),
      ]);
      await audit(c, actor, 'observation.located', 'defect', defectId, {
        jobId: id,
        index,
        locationMethod: 'reviewer_map_selection',
        locationAccuracyM: null,
        model: parsed.model,
      });
      return defect;
    });
  }
  async media(actor: Principal, id: string) {
    identifier(id);
    const row = (
      await this.db.query('SELECT * FROM media WHERE tenant_id=$1 AND id=$2', [actor.tenantId, id])
    ).rows[0];
    if (!row) throw new BadRequestException('Evidence was not found.');
    return row;
  }
  async readMedia(actor: Principal, id: string) {
    const media = await this.media(actor, id),
      bytes = await this.evidenceStore.read(media.storage_key);
    if (digest(bytes) !== media.sha256)
      throw new ConflictException('Evidence checksum validation failed; media is quarantined.');
    return { ...media, bytes };
  }
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    let job: any;
    try {
      await this.db.tx(async (c) => {
        const expired = await c.query(
          `UPDATE jobs SET status='failed',error='Worker lease expired after the retry budget was exhausted.',lease_until=NULL,lease_token=NULL,updated_at=now()
           WHERE (tenant_id,id) IN (SELECT tenant_id,id FROM jobs WHERE status='processing' AND lease_until<now() AND attempts>=retry_limit ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED)
           RETURNING tenant_id,id,media_id,attempts,error`,
        );
        for (const stale of expired.rows) {
          await audit(c, this.workerActor(stale.tenant_id), 'job.failed', 'job', stale.id, {
            mediaId: stale.media_id,
            attempts: stale.attempts,
            error: stale.error,
            reason: 'lease_expired',
          });
        }
      });
      const lease = uuid();
      job = (
        await this.db.query(
          `UPDATE jobs SET status='processing',attempts=attempts+1,lease_until=now()+interval '3 minutes',lease_token=$1,updated_at=now()
        WHERE (tenant_id,id)=(SELECT tenant_id,id FROM jobs WHERE attempts<retry_limit AND ((status='queued' AND available_at<=now()) OR (status='processing' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
          [lease],
        )
      ).rows[0];
      if (!job) return;
      const actor: Principal = {
        id: '00000000-0000-4000-8000-000000000000',
        tenantId: job.tenant_id,
        name: 'Vision worker',
        email: '',
        role: 'admin',
      };
      const media = await this.readMedia(actor, job.media_id),
        bytes: Buffer = media.bytes;
      const metadata: Record<string, unknown> = { capturedAt: media.metadata.capturedAt };
      for (const key of [
        'latitude',
        'longitude',
        'locationAccuracyM',
        'trajectory',
        'maxSyncGapMs',
      ])
        if (media.metadata[key] !== undefined) metadata[key] = media.metadata[key];
      if (media.metadata.calibrationId) {
        const record = await this.assets.get(actor, 'calibrations', media.metadata.calibrationId);
        if (record.projection) metadata.calibration = record.projection;
      }
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(bytes)], { type: media.mime_type }),
        media.filename,
      );
      form.append('metadata', JSON.stringify(metadata));
      if (!process.env.VISION_SERVICE_KEY)
        throw Object.assign(
          new Error('HTTP 503: VISION_SERVICE_KEY is not configured; inference is unavailable.'),
          { permanent: true },
        );
      this.activeAbort = new AbortController();
      const timeout = setTimeout(() => this.activeAbort?.abort(), 120000);
      let result;
      try {
        const response = await fetch(
          `${(process.env.VISION_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')}/v1/analyze`,
          {
            method: 'POST',
            headers: { 'X-Service-Key': process.env.VISION_SERVICE_KEY },
            body: form,
            signal: this.activeAbort.signal,
          },
        );
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 2000);
          throw Object.assign(new Error(`Vision HTTP ${response.status}: ${detail}`), {
            permanent:
              response.status === 503 ||
              (response.status >= 400 && response.status < 500 && response.status !== 429),
          });
        }
        result = parse(resultSchema, await response.json());
        if (!result.model.ready)
          throw Object.assign(
            new Error('Vision returned model.ready=false; no simulated results accepted.'),
            { permanent: true },
          );
      } finally {
        clearTimeout(timeout);
        this.activeAbort = undefined;
      }
      await this.commitResult(actor, job, media, result);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
      if (job) {
        const failed = (error as any)?.permanent || job.attempts >= job.retry_limit;
        await this.db
          .tx(async (c) => {
            const changed = await c.query(
              `UPDATE jobs SET status=$4,error=$5,available_at=now()+interval '15 seconds'*attempts,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 RETURNING id`,
              [job.tenant_id, job.id, job.lease_token, failed ? 'failed' : 'queued', message],
            );
            if (changed.rowCount && failed) {
              await audit(c, this.workerActor(job.tenant_id), 'job.failed', 'job', job.id, {
                mediaId: job.media_id,
                attempts: job.attempts,
                error: message,
              });
            }
          })
          .catch((err) => console.error('Could not persist job failure:', err.message));
      } else console.error('Job worker poll failed:', message);
    } finally {
      this.running = false;
    }
  }
  private workerActor(tenantId: string): Principal {
    return {
      id: '00000000-0000-4000-8000-000000000000',
      tenantId,
      name: 'Vision worker',
      email: '',
      role: 'admin',
    };
  }
  private async commitResult(
    actor: Principal,
    job: any,
    media: any,
    result: z.infer<typeof resultSchema>,
  ) {
    await this.db.tx(async (c) => {
      const row = (
        await c.query(
          'SELECT lease_token,status FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [actor.tenantId, job.id],
        )
      ).rows[0];
      if (!row || row.lease_token !== job.lease_token || row.status !== 'processing') return;
      const survey = await this.assets.get(actor, 'surveys', job.survey_id, c, true),
        settings = await this.assets.settings(actor, c),
        segments = await this.assets.list(actor, 'segments', c);
      let created = 0,
        unlocated = 0;
      const defectIds: string[] = [],
        observationDefectIds: Record<string, string> = {};
      if (result.quality.eligible)
        for (const [index, det] of result.detections.entries()) {
          // Vehicle GPS is not the pothole position. Only accept projected coordinates emitted by a calibrated pipeline.
          if (det.latitude == null || det.longitude == null || det.locationAccuracyM == null) {
            unlocated++;
            continue;
          }
          const candidates = await this.assets.nearbyRoads(
            actor,
            [det.longitude, det.latitude],
            25,
            survey.roadIds.length ? survey.roadIds : null,
            c,
          );
          const best = candidates[0];
          if (
            !best ||
            best.distanceM > 25 ||
            (candidates[1] && candidates[1].distanceM - best.distanceM < 5)
          ) {
            unlocated++;
            continue;
          }
          await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            `${actor.tenantId}:${best.road.id}`,
          ]);
          const existing = (
            await c.query(
              "SELECT data FROM defects WHERE tenant_id=$1 AND road_id=$2 AND data->>'type'=$3 AND data->>'status' NOT IN ('closed','rejected') FOR UPDATE",
              [actor.tenantId, best.road.id, det.type],
            )
          ).rows.map((r) => r.data);
          // Spatial proximity is only a review hint: disjoint neighbouring potholes must not be merged automatically.
          const possibleDuplicateIds = existing
            .filter(
              (d) => haversineM([d.longitude, d.latitude], [det.longitude!, det.latitude!]) < 5,
            )
            .map((d) => d.id);
          const evidence = {
            id: uuid(),
            mediaId: media.id,
            url: `/api/v1/media/${media.id}`,
            filename: media.filename,
            mimeType: media.mime_type,
            capturedAt: media.metadata.capturedAt,
            sha256: media.sha256,
            mask: det.mask,
            width: det.widthPx,
            height: det.heightPx,
            timeOffsetMs: det.timeOffsetMs,
            frameIndex: det.frameIndex,
            calibrationId: media.metadata.calibrationId || null,
            observationIndex: index,
            model: result.model,
            pipelineVersion: result.pipelineVersion,
            timingBasis: media.mime_type.startsWith('video/')
              ? 'chunk_start_plus_unverified_frame_offset'
              : 'image_capture',
          };
          const id = uuid(),
            depth = det.depth || unknownMeasurement('mm'),
            assessment = assessmentFor({ type: det.type, depthMm: depth.value }, settings);
          const d = {
            id,
            code: `RW-${id.slice(0, 8).toUpperCase()}`,
            roadId: best.road.id,
            roadName: best.road.name,
            segmentId:
              segments.find(
                (s) =>
                  s.roadId === best.road.id &&
                  s.chainageStartM <= best.chainageM &&
                  s.chainageEndM >= best.chainageM,
              )?.id || null,
            type: det.type,
            status: 'candidate',
            priority: assessment.priority,
            severity: assessment.severity,
            latitude: det.latitude,
            longitude: det.longitude,
            locationAccuracyM: det.locationAccuracyM,
            chainageM: best.chainageM,
            description:
              'Model observation awaiting authorized review. Road attribution uses a proximity candidate and requires verification.',
            length: det.length || unknownMeasurement('m'),
            width: det.width || unknownMeasurement('m'),
            depth,
            area: det.area || unknownMeasurement('m2'),
            confidence: det.confidence,
            source: 'vision',
            observedAt: media.metadata.capturedAt,
            updatedAt: now(),
            version: 1,
            evidence: [evidence],
            assessment,
            possibleDuplicateIds,
            model: result.model,
            pipelineVersion: result.pipelineVersion,
            jobId: job.id,
            observationIndex: index,
            timeOffsetMs: det.timeOffsetMs,
            timingBasis: evidence.timingBasis,
          };
          await c.query(
            'INSERT INTO defects(id,tenant_id,road_id,segment_id,data) VALUES($1,$2,$3,$4,$5)',
            [id, actor.tenantId, d.roadId, d.segmentId, JSON.stringify(d)],
          );
          created++;
          await c.query(
            'INSERT INTO evidence(id,tenant_id,media_id,defect_id,data) VALUES($1,$2,$3,$4,$5)',
            [evidence.id, actor.tenantId, media.id, d.id, JSON.stringify(evidence)],
          );
          defectIds.push(d.id);
          observationDefectIds[String(index)] = d.id;
        }
      survey.framesProcessed += result.frameCount;
      survey.defectsDetected += created;
      await c.query('UPDATE surveys SET data=$3 WHERE tenant_id=$1 AND id=$2', [
        actor.tenantId,
        survey.id,
        JSON.stringify(survey),
      ]);
      const stored = {
        ...result,
        createdDefects: created,
        unlocatedDetections: unlocated,
        defectIds,
        observationDefectIds,
        inspectionRequired: unlocated > 0,
        note: unlocated
          ? 'Unlocated observations retained here; calibrated geolocation and road review are required before map placement.'
          : null,
      };
      await c.query(
        "UPDATE jobs SET status='completed',result=$3,pipeline_version=$4,error=NULL,lease_until=NULL,lease_token=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, job.id, JSON.stringify(stored), result.pipelineVersion],
      );
      await audit(c, actor, 'job.completed', 'job', job.id, {
        mediaId: media.id,
        createdDefects: created,
        unlocatedDetections: unlocated,
        model: result.model,
      });
    });
  }
}
