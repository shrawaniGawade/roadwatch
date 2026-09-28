import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createEvidenceStore } from '@roadwatch/storage';

const require = createRequire(import.meta.url);
const { hashPassword } = require('../apps/api/dist/credentials.js');
const base = process.env.API_URL || 'http://127.0.0.1:3001';
const proxy = process.env.WEB_URL || 'http://localhost:3000';
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
const connection = process.env.API_TEST_DATABASE_URL || process.env.DATABASE_URL;
const db = new Pool({ connectionString: connection });
const tenantId = randomUUID(),
  adminId = randomUUID(),
  marker = `admin-integration-${randomUUID().slice(0, 8)}`;
const adminEmail = `${marker}-admin@example.test`,
  adminPassword = `Test-${randomBytes(24).toString('base64url')}`;
const sessions: Record<string, string> = {},
  emails = [adminEmail];
let road: any,
  initialized = false;

async function request(
  path: string,
  role = 'admin',
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
  throughProxy = false,
) {
  const headers: Record<string, string> = { Origin: origin, ...extra };
  if (sessions[role]) headers.Cookie = sessions[role];
  if (body !== undefined && !(body instanceof FormData))
    headers['Content-Type'] = 'application/json';
  return fetch((throughProxy ? proxy + '/api/v1' : base + '/v1') + path, {
    method,
    headers,
    signal: AbortSignal.timeout(45000),
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
}
async function ok(path: string, role = 'admin', method = 'GET', body?: unknown) {
  const r = await request(path, role, method, body),
    data = await r.json();
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${JSON.stringify(data)}`);
  return data as any;
}
async function login(email: string, password: string, role: string) {
  const r = await request('/auth/login', 'none', 'POST', { email, password });
  assert.equal(r.status, 200, `Login: ${r.status} ${await r.clone().text()}`);
  const cookie = r.headers.getSetCookie().find((v) => v.startsWith('roadwatch_session='));
  assert.ok(cookie);
  sessions[role] = cookie.split(';')[0];
  return r.json();
}
async function user(role: string) {
  const email = `${marker}-${role}-${randomUUID().slice(0, 4)}@example.test`,
    password = `Test-${randomBytes(24).toString('base64url')}`;
  emails.push(email);
  return {
    record: await ok('/users', 'admin', 'POST', {
      email,
      password,
      role,
      name: `Integration ${role}`,
    }),
    email,
    password,
  };
}

before(async () => {
  assert.ok(connection, 'An explicit integration PostgreSQL connection is required.');
  assert.notEqual(
    process.env.NODE_ENV,
    'production',
    'Never run fixture-writing tests in production.',
  );
  assert.ok(
    process.env.DEMO_SEED === 'true' || process.env.RUN_API_INTEGRATION_TESTS === 'true',
    'Enable DEMO_SEED or explicitly authorize RUN_API_INTEGRATION_TESTS.',
  );
  const hostname = new URL(connection!).hostname;
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(hostname) ||
      process.env.RUN_API_INTEGRATION_TESTS === 'true',
    'Non-local databases require explicit integration authorization.',
  );
  assert.ok((await fetch(base + '/v1/health')).ok, 'Start the API before integration testing.');
  await db.query('INSERT INTO tenants(id,name,settings) VALUES($1,$2,$3)', [
    tenantId,
    marker,
    JSON.stringify({
      organizationName: marker,
      defaultRegion: 'Integration region',
      retentionDays: 30,
      version: 1,
    }),
  ]);
  initialized = true;
  await db.query(
    'INSERT INTO users(id,tenant_id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5,$6)',
    [
      adminId,
      tenantId,
      adminEmail,
      'Isolated integration administrator',
      await hashPassword(adminPassword),
      'admin',
    ],
  );
  await login(adminEmail, adminPassword, 'admin');
  const viewer = await user('viewer');
  await login(viewer.email, viewer.password, 'viewer');
  const roads = await ok('/roads/import', 'admin', 'POST', {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Isolated integration road',
          code: marker,
          region: 'Integration region',
          owner: 'Test fixture',
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [78.4, 17.4],
            [78.405, 17.405],
          ],
        },
      },
    ],
  });
  road = roads[0];
});

after(async () => {
  if (initialized) {
    const keys = (
      await db.query('SELECT storage_key FROM media WHERE tenant_id=$1', [tenantId])
    ).rows.map((r) => r.storage_key);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Fence automation publication before deleting this isolated tenant's notifications/events.
      await client.query('SELECT id FROM outbox WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
      if ((await client.query("SELECT to_regclass('public.notifications') AS t")).rows[0].t)
        await client.query('DELETE FROM notifications WHERE tenant_id=$1', [tenantId]);
      for (const table of [
        'evidence',
        'work_order_defects',
        'upload_requests',
        'jobs',
        'media',
        'defects',
        'surveys',
        'calibrations',
        'devices',
        'segments',
        'roads',
        'audit',
        'outbox',
        'users',
      ])
        await client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
      await client.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
      await client.query('DELETE FROM login_limits WHERE key=ANY($1::text[])', [
        emails.map((email) => `email:${createHash('sha256').update(email).digest('hex')}`),
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const store = createEvidenceStore();
    try {
      for (const key of keys) await store.remove(key);
    } finally {
      await store.close?.();
    }
  }
  await db.end();
});

test('administrator creates users; password and role changes revoke existing sessions', async () => {
  const member = await user('reviewer');
  assert.equal(member.record.role, 'reviewer');
  assert.equal(member.record.tenantId, tenantId);
  assert.equal(member.record.password_hash, undefined);
  assert.equal(member.record.password, undefined);
  await login(member.email, member.password, 'member');
  assert.equal((await request('/auth/me', 'member')).status, 200);
  const nextPassword = `Changed-${randomBytes(24).toString('base64url')}`;
  await ok(`/users/${member.record.id}`, 'admin', 'PATCH', { password: nextPassword });
  assert.equal(
    (await request('/auth/me', 'member')).status,
    401,
    'Password replacement must invalidate the old session.',
  );
  assert.equal(
    (
      await request('/auth/login', 'none', 'POST', {
        email: member.email,
        password: member.password,
      })
    ).status,
    401,
  );
  await login(member.email, nextPassword, 'member');
  const accountKey = `email:${createHash('sha256').update(member.email).digest('hex')}`;
  assert.equal(
    (await db.query('SELECT key FROM login_limits WHERE key=$1', [accountKey])).rowCount,
    0,
    'Successful login clears only the account failure limit.',
  );
  await ok(`/users/${member.record.id}`, 'admin', 'PATCH', { role: 'viewer' });
  assert.equal(
    (await request('/auth/me', 'member')).status,
    401,
    'Role changes must invalidate sessions before permissions can be reused.',
  );
  const audit = await ok('/audit');
  assert.ok(
    audit.some(
      (e: any) =>
        e.action === 'user.updated' && e.entityId === member.record.id && e.details.passwordChanged,
    ),
  );
});

test('last-administrator invariants and viewer restrictions are enforced', async () => {
  assert.equal(
    (await request(`/users/${adminId}`, 'admin', 'PATCH', { role: 'viewer' })).status,
    409,
  );
  assert.equal(
    (await request(`/users/${adminId}`, 'admin', 'PATCH', { active: false })).status,
    409,
  );
  assert.equal((await ok('/auth/me')).role, 'admin');
  assert.equal((await request('/users', 'viewer')).status, 403);
  assert.equal(
    (
      await request('/users', 'viewer', 'POST', {
        name: 'Unauthorized',
        email: `${marker}-forbidden@example.test`,
        password: adminPassword,
        role: 'admin',
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(`/users/${adminId}`, 'viewer', 'PATCH', { active: false })).status,
    403,
  );
  assert.equal((await request('/reports/defects.csv', 'viewer')).status, 403);
});

test('rotating and revoking a device immediately invalidates previous bearer credentials', async () => {
  const device = await ok('/devices', 'admin', 'POST', {
      name: 'Isolated device credential test',
      kind: 'vehicle',
    }),
    id = device.id;
  const heartbeat = (token: string) =>
    request(
      '/devices/heartbeat',
      'none',
      'POST',
      { uploadBacklog: 0 },
      { Authorization: `Bearer ${token}` },
    );
  assert.equal((await heartbeat(device.token)).status, 201);
  assert.equal((await request(`/devices/${id}/rotate-token`, 'viewer', 'POST', {})).status, 403);
  const rotated = await ok(`/devices/${id}/rotate-token`, 'admin', 'POST', {});
  assert.notEqual(rotated.token, device.token);
  assert.equal((await heartbeat(device.token)).status, 401);
  assert.equal((await heartbeat(rotated.token)).status, 201);
  assert.equal(
    (
      await request(
        '/devices/heartbeat',
        'none',
        'POST',
        { uploadBacklog: 0 },
        { Authorization: `Bearer ${rotated.token}` },
        true,
      )
    ).status,
    201,
    'Next must preserve device credentials.',
  );
  assert.equal(
    (
      await request(
        '/dashboard',
        'none',
        'GET',
        undefined,
        { Authorization: `Bearer ${rotated.token}` },
        true,
      )
    ).status,
    403,
    'Device scope also applies through the proxy.',
  );
  await ok(`/devices/${id}/revoke`, 'admin', 'POST', {
    reason: 'Integration verifies compromised credential revocation',
  });
  assert.equal((await heartbeat(rotated.token)).status, 401);
  const persisted = (
    await db.query('SELECT token_hash,data FROM devices WHERE tenant_id=$1 AND id=$2', [
      tenantId,
      id,
    ])
  ).rows[0];
  assert.equal(persisted.token_hash, null);
  assert.equal(persisted.data.credentialStatus, 'revoked');
});

test('priority policy defaults recalculate persisted open assessments without hiding assumptions', async () => {
  const [longitude, latitude] = road.geometry.coordinates[0];
  const defect = await ok('/defects', 'admin', 'POST', {
    roadId: road.id,
    type: 'pothole',
    latitude,
    longitude,
    depthMm: 70,
    description: 'Isolated priority policy validation',
  });
  const original = defect.assessment.score;
  const settings = await ok('/settings', 'admin', 'PATCH', {
    organizationName: marker,
    defaultRegion: 'Integration region',
    retentionDays: 30,
    priorityPolicy: {
      defaultTrafficExposure: 100,
      defaultVulnerableContext: 100,
      defaultGrowthScore: 100,
    },
  });
  const recalculated = await ok(`/defects/${defect.id}`);
  assert.ok(recalculated.assessment.score > original);
  assert.ok(recalculated.version > defect.version);
  assert.match(recalculated.assessment.policyVersion, new RegExp(`org-${settings.version}$`));
  assert.equal(
    recalculated.assessment.components.find((c: any) => c.key === 'exposure').assumed,
    true,
  );
  assert.equal(recalculated.depth.status, 'estimated');
  const persisted = (
    await db.query('SELECT data FROM defects WHERE tenant_id=$1 AND id=$2', [tenantId, defect.id])
  ).rows[0].data;
  assert.equal(persisted.assessment.score, recalculated.assessment.score);
  assert.equal(
    (
      await request('/settings', 'admin', 'PATCH', {
        organizationName: marker,
        defaultRegion: 'Integration region',
        retentionDays: 30,
        priorityPolicy: { unimplementedWeight: 200 },
      })
    ).status,
    400,
  );
});

test('terminal inference failures preserve evidence and emit one committed audit/outbox event', async () => {
  const device = await ok('/devices', 'admin', 'POST', {
      name: 'Isolated failure-event device',
      kind: 'vehicle',
    }),
    survey = await ok('/surveys', 'admin', 'POST', {
      deviceId: device.id,
      name: 'Failure event boundary test',
      roadIds: [road.id],
    });
  // A recognizable JPEG signature with invalid encoded content passes upload identification,
  // then must fail the actual decoder/model boundary without producing any detections.
  const bytes = Buffer.from([0xff, 0xd8, 0xff, ...Array(29).fill(0)]),
    key = randomUUID();
  const form = () => {
    const f = new FormData();
    f.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'invalid-encoded-content.jpg');
    f.set('surveyId', survey.id);
    f.set('capturedAt', '2026-09-08T12:00:00.000Z');
    return f;
  };
  const response = await request('/uploads', 'admin', 'POST', form(), { 'Idempotency-Key': key }),
    receipt = (await response.json()) as any;
  assert.ok(response.ok);
  let job: any;
  for (let i = 0; i < 60; i++) {
    job = (await ok('/jobs')).find((j: any) => j.id === receipt.jobId);
    if (job?.status === 'failed') break;
    await delay(500);
  }
  assert.equal(job?.status, 'failed');
  assert.ok(job.error);
  assert.equal(
    (await request(`/media/${receipt.mediaId}`)).status,
    200,
    'Failed inference must retain original evidence.',
  );
  const replay = await request('/uploads', 'admin', 'POST', form(), { 'Idempotency-Key': key });
  assert.equal(((await replay.json()) as any).jobId, receipt.jobId);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM audit WHERE tenant_id=$1 AND entity_id=$2 AND action='job.failed'",
        [tenantId, receipt.jobId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='job.failed'",
        [tenantId, receipt.jobId],
      )
    ).rows[0].n,
    1,
  );
});

test('more than 10 MiB survives the Next.js proxy; the API still enforces its 32 MiB limit', async () => {
  const device = await ok('/devices', 'admin', 'POST', {
      name: 'Isolated large upload device',
      kind: 'vehicle',
    }),
    survey = await ok('/surveys', 'admin', 'POST', {
      deviceId: device.id,
      name: 'Proxy upload boundary test',
      roadIds: [road.id],
    });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const bytes = Buffer.alloc(12 * 1024 * 1024, 0);
  png.copy(bytes);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const form = (content: Buffer, capturedAt = '2026-09-08T12:00:00.000Z') => {
    const f = new FormData();
    f.set(
      'file',
      new Blob([new Uint8Array(content)], { type: 'image/png' }),
      'integration-padded.png',
    );
    f.set('surveyId', survey.id);
    f.set('capturedAt', capturedAt);
    return f;
  };
  assert.equal(
    (
      await request(
        '/uploads',
        'admin',
        'POST',
        form(png),
        { Origin: 'https://untrusted.example' },
        true,
      )
    ).status,
    403,
    'Next must preserve browser Origin for CSRF enforcement.',
  );
  const wrongChecksum = await request(
    '/uploads',
    'admin',
    'POST',
    form(png),
    { 'Idempotency-Key': randomUUID(), 'X-Content-SHA256': '0'.repeat(64) },
    true,
  );
  assert.equal(
    wrongChecksum.status,
    400,
    'Next must forward the checksum header to API validation.',
  );
  const proxyKey = randomUUID(),
    uploadHeaders = { 'Idempotency-Key': proxyKey, 'X-Content-SHA256': checksum };
  const upload = await request('/uploads', 'admin', 'POST', form(bytes), uploadHeaders, true);
  const uploadText = await upload.text();
  assert.ok(upload.ok, `Next proxy upload ${upload.status}: ${uploadText.slice(0, 500)}`);
  const receipt = JSON.parse(uploadText);
  assert.equal(receipt.sha256, checksum);
  const stored = (
    await db.query('SELECT size_bytes,sha256 FROM media WHERE tenant_id=$1 AND id=$2', [
      tenantId,
      receipt.mediaId,
    ])
  ).rows[0];
  assert.equal(Number(stored.size_bytes), bytes.length);
  assert.equal(stored.sha256, checksum);
  const repeated = await request('/uploads', 'admin', 'POST', form(bytes), uploadHeaders, true);
  assert.ok(repeated.ok);
  assert.equal(
    ((await repeated.json()) as any).mediaId,
    receipt.mediaId,
    'Next must preserve the idempotency key.',
  );
  const changed = await request(
    '/uploads',
    'admin',
    'POST',
    form(bytes, '2026-09-08T12:00:01.000Z'),
    uploadHeaders,
    true,
  );
  assert.equal(changed.status, 409, 'A proxied constant key with changed metadata must conflict.');
  const range = await request(
    `/media/${receipt.mediaId}`,
    'admin',
    'GET',
    undefined,
    { Range: 'bytes=0-15' },
    true,
  );
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-15/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 16));
  const tooLarge = Buffer.alloc(33 * 1024 * 1024, 0);
  png.copy(tooLarge);
  const rejected = await request(
    '/uploads',
    'admin',
    'POST',
    form(tooLarge),
    { 'Idempotency-Key': randomUUID() },
    true,
  );
  assert.equal(
    rejected.status,
    413,
    `Oversized upload should be rejected; got ${rejected.status}.`,
  );
  for (let i = 0; i < 40; i++) {
    const job = (await ok('/jobs')).find((j: any) => j.id === receipt.jobId);
    if (job && ['completed', 'failed'].includes(job.status)) return;
    await delay(500);
  }
  assert.fail('The uploaded evidence must reach an explicit completed or failed processing state.');
});
