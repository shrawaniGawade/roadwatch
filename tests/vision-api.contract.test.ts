/**
 * Integration contracts, not model-accuracy tests. The positive observations below
 * are explicitly synthetic fixtures injected at the persisted inference boundary.
 * No detector, checkpoint, running server, or .env file is replaced by this suite.
 * Run after building/starting API:
 * node --env-file=.env --import tsx --test tests/vision-api.contract.test.ts
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { Database } = require('../apps/api/dist/database.js');
const { AssetsService } = require('../apps/api/dist/assets.service.js');
const { MediaService } = require('../apps/api/dist/media.service.js');
const { hashPassword } = require('../apps/api/dist/credentials.js');
const db = new Database(); // Existing test DB only: do not migrate, seed, or start its worker.
const base = process.env.API_URL || 'http://127.0.0.1:3001';
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
const tenantId = randomUUID();
const marker = `vision-contract-${randomUUID().slice(0, 8)}`;
const sessions: Record<string, string> = {};
const capturedAt = '2026-09-08T10:00:00.000Z';
let road: any, survey: any, calibration: any, actor: any, service: any;
let tenantCreated = false;

async function request(path: string, role = 'admin', method = 'GET', body?: unknown) {
  return fetch(base + '/v1' + path, {
    method,
    headers: {
      Origin: origin,
      ...(sessions[role] ? { Cookie: sessions[role] } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function ok(path: string, role = 'admin', method = 'GET', body?: unknown) {
  const response = await request(path, role, method, body);
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return value as any;
}

before(async () => {
  assert.ok(
    process.env.SEED_TEAM_PASSWORD,
    'Load .env development test credentials without logging them',
  );
  assert.ok((await fetch(base + '/v1/health')).ok, 'Start the built API before running this suite');
  await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, marker]);
  tenantCreated = true;
  const passwordHash = await hashPassword(process.env.SEED_TEAM_PASSWORD);
  for (const role of ['admin', 'reviewer', 'viewer']) {
    const id = randomUUID(),
      email = `${marker}-${role}@example.test`;
    await db.query(
      'INSERT INTO users(id,tenant_id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [id, tenantId, email, marker, role, passwordHash],
    );
    const response = await request('/auth/login', 'none', 'POST', {
      email,
      password: process.env.SEED_TEAM_PASSWORD,
    });
    assert.ok(response.ok, `Temporary ${role} login must succeed`);
    const cookie = response.headers.getSetCookie().find((c) => c.startsWith('roadwatch_session='));
    assert.ok(cookie);
    sessions[role] = cookie.split(';')[0];
    if (role === 'admin') actor = { id, tenantId, email, name: marker, role };
  }
  road = (
    await ok('/roads/import', 'admin', 'POST', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: marker, code: marker },
          geometry: {
            type: 'LineString',
            coordinates: [
              [78.4, 17.4],
              [78.41, 17.4],
            ],
          },
        },
      ],
    })
  )[0];
  const device = await ok('/devices', 'admin', 'POST', { name: marker, kind: 'vehicle' });
  survey = await ok('/surveys', 'admin', 'POST', {
    deviceId: device.id,
    name: marker,
    roadIds: [road.id],
  });
  calibration = await ok('/calibrations', 'reviewer', 'POST', {
    deviceId: device.id,
    method: 'Synthetic analytic contract fixture, not a field calibration',
    projection: {
      kind: 'planar',
      imageWidth: 640,
      imageHeight: 480,
      imageToGround: [
        [0, -0.01, 5],
        [0.01, 0, -3.2],
        [0, 0, 1],
      ],
      validRoi: [
        [0, 0],
        [639, 0],
        [639, 479],
        [0, 479],
      ],
      uncertainty95M: 0.04,
      cameraOffsetForwardM: 0.5,
      cameraOffsetRightM: -0.2,
      headingAccuracy95Deg: 2,
      validUntil: '2027-01-01T00:00:00.000Z',
    },
  });
  service = new MediaService(db, new AssetsService(db));
});

after(async () => {
  await service?.onModuleDestroy();
  try {
    if (tenantCreated)
      await db.tx(async (c: any) => {
        if ((await c.query("SELECT to_regclass('notifications') AS name")).rows[0].name)
          await c.query('DELETE FROM notifications WHERE tenant_id=$1', [tenantId]);
        // Fixed table names; only this suite's unique tenant is removed.
        for (const table of [
          'upload_requests',
          'evidence',
          'jobs',
          'media',
          'work_order_defects',
          'work_orders',
          'defects',
          'calibrations',
          'surveys',
          'devices',
          'segments',
          'roads',
          'audit',
          'outbox',
          'users',
        ])
          await c.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
        await c.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
      });
  } finally {
    await db.onModuleDestroy();
  }
});

const estimate = (value: number, unit: string) => ({
  value,
  unit,
  status: 'estimated',
  method: 'synthetic_planar_contract_fixture',
  uncertainty95: 0.04,
});
const unknownDepth = {
  value: null,
  unit: 'mm',
  status: 'unknown',
  method: 'unavailable',
  uncertainty95: null,
  reason: 'rgb_cannot_measure_cavity_depth',
};
function observation(index: number, located = true) {
  const x = 20 + index * 100;
  return {
    type: 'pothole',
    confidence: 0.91,
    mask: [
      [x, 300],
      [x + 35, 300],
      [x + 35, 330],
      [x, 330],
    ],
    bbox: [x, 300, x + 35, 330],
    widthPx: 640,
    heightPx: 480,
    frameIndex: 2,
    timeOffsetMs: 1250,
    length: estimate(0.35, 'm'),
    width: estimate(0.3, 'm'),
    area: estimate(0.105, 'm2'),
    depth: unknownDepth,
    latitude: located ? 17.4 : null,
    longitude: located ? 78.4003 + index * 0.000005 : null,
    locationAccuracyM: located ? 1.2 : null,
  };
}
function result(detections: unknown[]) {
  return {
    pipelineVersion: 'synthetic-contract-v1',
    model: {
      name: 'synthetic-contract-fixture',
      version: 'test-only',
      ready: true,
      validationStatus: 'experimental',
    },
    quality: { eligible: true, reasons: ['synthetic_fixture_not_model_accuracy_evidence'] },
    detections,
    frameCount: 3,
  };
}

async function persistFixture(detections: unknown[]) {
  const mediaId = randomUUID(),
    jobId = randomUUID(),
    lease = randomUUID();
  // The private evidence body is outside this test boundary; its synthetic storage
  // reference is never decoded or exposed. Root's upload suite tests real storage.
  const media = {
    id: mediaId,
    filename: 'synthetic-contract.mp4',
    mime_type: 'video/mp4',
    sha256: 'e'.repeat(64),
    metadata: { surveyId: survey.id, capturedAt, calibrationId: calibration.id },
  };
  await db.query(
    'INSERT INTO media(id,tenant_id,survey_id,filename,mime_type,storage_key,sha256,size_bytes,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      mediaId,
      tenantId,
      survey.id,
      media.filename,
      media.mime_type,
      `${tenantId}/${mediaId}`,
      media.sha256,
      1,
      JSON.stringify(media.metadata),
    ],
  );
  const job = (
    await db.query(
      "INSERT INTO jobs(id,tenant_id,survey_id,media_id,status,lease_token,lease_until) VALUES($1,$2,$3,$4,'processing',$5,now()+interval '1 hour') RETURNING *",
      [jobId, tenantId, survey.id, mediaId, lease],
    )
  ).rows[0];
  // Exercise actual transaction/association code against PostgreSQL, without a
  // running worker claiming a fake model or replacing the deployed vision service.
  await service.commitResult(actor, job, media, result(detections));
  return { jobId, mediaId };
}

test('API worker multipart preserves trajectory, calibration, lever arm and uncertainty over HTTP', async () => {
  const trajectory = [0, 200].map((ms) => ({
    timestamp: new Date(Date.parse(capturedAt) + ms).toISOString(),
    latitude: 17.4,
    longitude: 78.4,
    horizontalAccuracy95M: 0.7,
    headingDeg: 12,
  }));
  let received: any, committed: any, workerFailure: unknown;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/analyze');
      assert.equal(req.headers['x-service-key'], 'test-only-service-key');
      const pieces: Buffer[] = [];
      for await (const piece of req) pieces.push(Buffer.from(piece));
      const form = await new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': req.headers['content-type']! },
        body: Buffer.concat(pieces),
      }).formData();
      received = JSON.parse(String(form.get('metadata')));
      assert.deepEqual(
        Buffer.from(await (form.get('file') as File).arrayBuffer()),
        Buffer.from('synthetic-boundary-media'),
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result([])));
    } catch (error) {
      workerFailure = error;
      res.writeHead(500);
      res.end('contract failure');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const priorUrl = process.env.VISION_URL,
    priorKey = process.env.VISION_SERVICE_KEY;
  let instance: any;
  try {
    // This process only: no .env file or running service configuration is modified.
    process.env.VISION_URL = `http://127.0.0.1:${address.port}`;
    process.env.VISION_SERVICE_KEY = 'test-only-service-key';
    const fakeDb = {
      // Lease expiry/failure updates use a transaction-scoped client; the claim
      // still uses the pool query. Both share this boundary fixture's SQL handler.
      tx: async (callback: (client: any) => Promise<unknown>) => callback({ query: fakeDb.query }),
      query: async (sql: string, parameters: unknown[] = []) => {
        if (sql.includes('RETURNING *'))
          return {
            rows: [
              {
                id: randomUUID(),
                tenant_id: tenantId,
                media_id: randomUUID(),
                lease_token: parameters[0],
                attempts: 1,
                retry_limit: 3,
              },
            ],
          };
        if (sql.includes('error=$5')) workerFailure = new Error(String(parameters[4]));
        return { rows: [] };
      },
    };
    instance = new MediaService(fakeDb, { get: async () => calibration });
    instance.readMedia = async () => ({
      bytes: Buffer.from('synthetic-boundary-media'),
      mime_type: 'image/jpeg',
      filename: 'contract.jpg',
      metadata: {
        capturedAt,
        calibrationId: calibration.id,
        latitude: 17.4,
        longitude: 78.4,
        locationAccuracyM: 0.7,
        trajectory,
        maxSyncGapMs: 250,
      },
    });
    instance.commitResult = async (_a: unknown, _j: unknown, _m: unknown, value: unknown) => {
      committed = value;
    };
    await instance.tick();
    assert.equal(workerFailure, undefined);
    assert.ok(received, 'Worker must reach the authenticated multipart HTTP boundary');
    assert.deepEqual(received.trajectory, trajectory);
    assert.deepEqual(received.calibration, calibration.projection);
    assert.equal(received.calibration.cameraOffsetRightM, -0.2);
    assert.equal(received.locationAccuracyM, 0.7);
    assert.equal(received.maxSyncGapMs, 250);
    assert.equal(
      received.calibrationId,
      undefined,
      'Forward the typed projection, not the admin record',
    );
    assert.equal(
      received.videoTiming,
      undefined,
      'Unverified upload timing must not be silently certified',
    );
    assert.equal(committed.model.validationStatus, 'experimental');
  } finally {
    if (priorUrl === undefined) delete process.env.VISION_URL;
    else process.env.VISION_URL = priorUrl;
    if (priorKey === undefined) delete process.env.VISION_SERVICE_KEY;
    else process.env.VISION_SERVICE_KEY = priorKey;
    await instance?.onModuleDestroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('separate nearby masks create distinct candidates and retain frame/measurement provenance', async () => {
  const fixture = await persistFixture([observation(0), observation(1), observation(2, false)]);
  const job = (await ok('/jobs')).find((j: any) => j.id === fixture.jobId);
  assert.equal(job.status, 'completed');
  assert.equal(job.result.createdDefects, 2);
  assert.equal(job.result.unlocatedDetections, 1);
  assert.equal(job.result.inspectionRequired, true);
  assert.equal(
    new Set(job.result.defectIds).size,
    2,
    'Sub-metre proximity cannot merge disjoint holes',
  );
  assert.equal(
    job.result.observationDefectIds['2'],
    undefined,
    'Antenna GPS cannot supply an unlocated defect point',
  );
  const first = await ok('/defects/' + job.result.observationDefectIds['0']);
  const second = await ok('/defects/' + job.result.observationDefectIds['1']);
  assert.ok(
    second.possibleDuplicateIds.includes(first.id),
    'Proximity should remain a review hint',
  );
  for (const [index, d] of [first, second].entries()) {
    assert.equal(d.status, 'candidate');
    assert.deepEqual(d.depth, unknownDepth);
    assert.deepEqual(d.length, estimate(0.35, 'm'));
    assert.equal(d.locationAccuracyM, 1.2);
    assert.equal(d.evidence[0].width, 640);
    assert.equal(d.evidence[0].height, 480);
    assert.equal(d.evidence[0].timeOffsetMs, 1250);
    assert.equal(d.evidence[0].observationIndex, index);
    assert.equal(d.evidence[0].sha256, 'e'.repeat(64));
    assert.equal(d.evidence[0].model.validationStatus, 'experimental');
    assert.equal(d.evidence[0].pipelineVersion, 'synthetic-contract-v1');
    assert.match(d.evidence[0].timingBasis, /unverified/);
    assert.equal(
      d.observedAt,
      capturedAt,
      'Chunk timestamp is retained separately from the unverified frame offset',
    );
  }
});

test('retained unlocated observation supports authorized, idempotent manual mapping with unknown GPS precision', async () => {
  const fixture = await persistFixture([observation(0, false)]);
  const path = `/jobs/${fixture.jobId}/observations/0/locate`;
  const placement = {
    roadId: road.id,
    latitude: 17.4,
    longitude: 78.4005,
    description: 'Synthetic contract fixture placement; no surveyed position claim',
  };
  assert.equal((await request(path, 'viewer', 'POST', placement)).status, 403);
  assert.equal((await request(path, 'none', 'POST', placement)).status, 401);
  assert.equal(
    (await request(path, 'reviewer', 'POST', { ...placement, latitude: 0, longitude: 0 })).status,
    400,
  );
  const [a, b] = await Promise.all([
    ok(path, 'reviewer', 'POST', placement),
    ok(path, 'reviewer', 'POST', placement),
  ]);
  assert.equal(a.id, b.id, 'Concurrent retries must locate one retained observation exactly once');
  assert.equal(a.source, 'vision_manual_location');
  assert.equal(a.locationMethod, 'reviewer_map_selection');
  assert.equal(a.locationAccuracyM, null);
  assert.deepEqual(a.depth, unknownDepth);
  assert.deepEqual(a.area, estimate(0.105, 'm2'));
  assert.equal(a.status, 'candidate');
  assert.equal(a.evidence[0].timeOffsetMs, 1250);
  assert.equal(a.evidence[0].width, 640);
  assert.equal(a.model.validationStatus, 'experimental');
  const job = (await ok('/jobs')).find((j: any) => j.id === fixture.jobId);
  assert.equal(job.result.unlocatedDetections, 0);
  assert.equal(job.result.createdDefects, 1);
  assert.equal(job.result.observationDefectIds['0'], a.id);
  assert.equal(
    (
      await db.query('SELECT count(*) FROM evidence WHERE tenant_id=$1 AND media_id=$2', [
        tenantId,
        fixture.mediaId,
      ])
    ).rows[0].count,
    '1',
  );
});
