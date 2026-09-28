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
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
const connection = process.env.API_TEST_DATABASE_URL || process.env.DATABASE_URL;
const db = new Pool({ connectionString: connection });
const marker = `api-integration-${randomUUID().slice(0, 8)}`;
const tenantId = randomUUID(),
  otherTenant = randomUUID();
const createdTenants: string[] = [],
  emails: string[] = [];
const password = `Integration-${randomBytes(24).toString('base64url')}`;
const workerId = `integration:${marker}`;
const sessions: Record<string, string> = {};
let road: any;

const accountLimitKeys = () =>
  emails.map((email) => `email:${createHash('sha256').update(email).digest('hex')}`);

// Exercise the real consumer twice, but partition its reads and housekeeping to
// these fixtures so running this suite cannot publish another tenant's outbox.
const scopedWorkerPool = {
  async connect() {
    const client = await db.connect();
    return {
      async query(sql: string, values: unknown[] = []) {
        if (sql.startsWith('SELECT * FROM outbox WHERE '))
          return client.query(sql.replace('WHERE ', 'WHERE tenant_id=$1 AND '), [tenantId]);
        if (sql.startsWith('SELECT tenant_id,data FROM work_orders WHERE '))
          return client.query(sql.replace('WHERE ', 'WHERE tenant_id=$1 AND '), [tenantId]);
        if (sql.startsWith('DELETE FROM sessions WHERE '))
          return client.query(sql + ' AND user_id IN (SELECT id FROM users WHERE tenant_id=$1)', [
            tenantId,
          ]);
        if (sql.startsWith('DELETE FROM login_limits WHERE '))
          return client.query(sql + ' AND key=ANY($1::text[])', [accountLimitKeys()]);
        if (sql.startsWith('INSERT INTO automation_status('))
          return client.query(sql.replace("VALUES('inbox',", 'VALUES($2,'), [...values, workerId]);
        return client.query(sql, values);
      },
      release() {
        client.release();
      },
    };
  },
};

async function request(
  path: string,
  role = 'admin',
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { Origin: origin, ...extra };
  if (sessions[role]) headers.Cookie = sessions[role];
  if (body !== undefined && !(body instanceof FormData))
    headers['Content-Type'] = 'application/json';
  return fetch(base + '/v1' + path, {
    method,
    headers,
    signal: AbortSignal.timeout(45000),
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
}
async function ok(path: string, role = 'admin', method = 'GET', body?: unknown) {
  const response = await request(path, role, method, body);
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data as any;
}
async function login(role: string, email: string, password: string) {
  const r = await request('/auth/login', 'none', 'POST', { email, password });
  assert.ok(r.ok, `Login for ${role}: ${r.status}`);
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('roadwatch_session='));
  assert.ok(
    cookie && cookie.includes('HttpOnly') && /SameSite=Lax/i.test(cookie),
    'Cookie must be HttpOnly and SameSite Lax',
  );
  sessions[role] = cookie.split(';')[0];
  return r.json();
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
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(new URL(connection!).hostname) ||
      process.env.RUN_API_INTEGRATION_TESTS === 'true',
    'Non-local databases require explicit integration authorization.',
  );
  assert.ok((await fetch(base + '/v1/health')).ok, 'Start API before integration tests');
  for (const id of [tenantId, otherTenant]) {
    await db.query('INSERT INTO tenants(id,name,settings) VALUES($1,$2,$3)', [
      id,
      marker,
      JSON.stringify({
        organizationName: marker,
        defaultRegion: 'Integration region',
        retentionDays: 30,
        version: 1,
      }),
    ]);
    createdTenants.push(id);
  }
  for (const role of ['admin', 'reviewer', 'planner', 'crew', 'viewer', 'outsider']) {
    const email = `${marker}-${role}@example.test`;
    emails.push(email);
    await db.query(
      'INSERT INTO users(id,tenant_id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        role === 'outsider' ? otherTenant : tenantId,
        email,
        `Isolated integration ${role}`,
        role === 'outsider' ? 'viewer' : role,
        await hashPassword(password),
      ],
    );
    await login(role, email, password);
  }
  [road] = await ok('/roads/import', 'planner', 'POST', {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Synthetic integration road',
          code: `${marker}-baseline`,
          owner: 'Test fixture',
          region: 'Integration region',
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [78.42, 17.42],
            [78.425, 17.425],
          ],
        },
      },
    ],
  });
  assert.ok(road, 'The isolated synthetic road must be imported.');
});
after(async () => {
  try {
    if (!createdTenants.length) return;
    const keys = (
      await db.query('SELECT storage_key FROM media WHERE tenant_id=ANY($1::uuid[])', [
        createdTenants,
      ])
    ).rows.map((row) => row.storage_key);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Fence event publication before removing only this run's rows in FK order.
      await client.query('SELECT id FROM outbox WHERE tenant_id=ANY($1::uuid[]) FOR UPDATE', [
        createdTenants,
      ]);
      if ((await client.query("SELECT to_regclass('public.notifications') AS t")).rows[0].t)
        await client.query('DELETE FROM notifications WHERE tenant_id=ANY($1::uuid[])', [
          createdTenants,
        ]);
      for (const table of [
        'evidence',
        'work_order_defects',
        'work_orders',
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
        await client.query(`DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`, [
          createdTenants,
        ]);
      await client.query('DELETE FROM tenants WHERE id=ANY($1::uuid[])', [createdTenants]);
      await client.query('DELETE FROM login_limits WHERE key=ANY($1::text[])', [
        accountLimitKeys(),
      ]);
      if ((await client.query("SELECT to_regclass('public.automation_status') AS t")).rows[0].t)
        await client.query('DELETE FROM automation_status WHERE worker=$1', [workerId]);
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
    assert.equal(
      (await db.query('SELECT count(*) FROM tenants WHERE id=ANY($1::uuid[])', [createdTenants]))
        .rows[0].count,
      '0',
    );
  } finally {
    await db.end();
  }
});

test('authentication, tenant isolation, role checks, and CSRF protect persisted records', async () => {
  assert.equal((await request('/dashboard', 'none')).status, 401);
  assert.equal((await request('/roads/' + road.id, 'outsider')).status, 404);
  assert.deepEqual(await ok('/roads', 'outsider'), []);
  assert.equal(
    (await request('/devices', 'viewer', 'POST', { name: marker, kind: 'vehicle' })).status,
    403,
  );
  assert.equal(
    (
      await request(
        '/devices',
        'admin',
        'POST',
        { name: marker, kind: 'vehicle' },
        { Origin: 'https://untrusted.example' },
      )
    ).status,
    403,
  );
  const noOrigin = await fetch(base + '/v1/devices', {
    method: 'POST',
    headers: { Cookie: sessions.admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: marker, kind: 'vehicle' }),
  });
  assert.equal(noOrigin.status, 403);
});

test('manual observation -> review -> assignment -> repair -> independent verification is atomic and versioned', async () => {
  const [longitude, latitude] = road.geometry.coordinates[0];
  const d = await ok('/defects', 'crew', 'POST', {
    roadId: road.id,
    type: 'pothole',
    latitude,
    longitude,
    description: `${marker} lifecycle observation`,
  });
  assert.equal(d.depth.value, null);
  assert.equal(d.depth.status, 'unknown');
  assert.equal(d.status, 'candidate');
  assert.ok(d.assessment.inspectionRequired);
  assert.equal(
    (
      await request(`/defects/${d.id}/reviews`, 'planner', 'POST', {
        action: 'confirm',
        reason: 'Reviewed',
        expectedVersion: 1,
      })
    ).status,
    403,
  );
  const confirmed = await ok(`/defects/${d.id}/reviews`, 'reviewer', 'POST', {
    action: 'confirm',
    reason: 'Reviewed observation with field notes',
    expectedVersion: 1,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(
    (
      await request(`/defects/${d.id}/reviews`, 'reviewer', 'POST', {
        action: 'reject',
        reason: 'Stale reviewer',
        expectedVersion: 1,
      })
    ).status,
    409,
  );
  const order = await ok('/work-orders', 'planner', 'POST', {
    defectIds: [d.id],
    crew: `${marker} crew`,
    description: 'Repair and document completion',
    dueAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal((await ok(`/defects/${d.id}`)).status, 'assigned');
  assert.equal(
    (
      await request('/work-orders', 'planner', 'POST', {
        defectIds: [d.id],
        crew: marker,
        description: 'Duplicate allocation',
        dueAt: '2026-01-02T00:00:00.000Z',
      })
    ).status,
    409,
  );
  const started = await ok(`/work-orders/${order.id}/transitions`, 'admin', 'POST', {
    action: 'start',
    notes: 'Crew on site',
    expectedVersion: 1,
  });
  const repaired = await ok(`/work-orders/${order.id}/transitions`, 'admin', 'POST', {
    action: 'report_repair',
    notes: 'Repair completed, verification required',
    expectedVersion: started.version,
  });
  assert.equal(
    (
      await request(`/work-orders/${order.id}/transitions`, 'admin', 'POST', {
        action: 'verify',
        notes: 'Cannot verify own repair',
        expectedVersion: repaired.version,
      })
    ).status,
    403,
  );
  const verified = await ok(`/work-orders/${order.id}/transitions`, 'reviewer', 'POST', {
    action: 'verify',
    notes: 'Independent site inspection completed',
    expectedVersion: repaired.version,
  });
  assert.equal(verified.status, 'closed');
  assert.equal((await ok(`/defects/${d.id}`)).status, 'closed');
  const reopened = await ok(`/work-orders/${order.id}/transitions`, 'reviewer', 'POST', {
    action: 'reopen',
    notes: 'Recurrence observed on follow-up',
    expectedVersion: verified.version,
  });
  assert.equal(reopened.status, 'assigned');
  assert.equal((await ok(`/defects/${d.id}`)).status, 'assigned');
  const audit = await ok('/audit');
  assert.ok(audit.some((a: any) => a.entityId === order.id && a.action === 'work_order.verify'));
  const stored = (
    await db.query('SELECT data FROM work_orders WHERE tenant_id=$1 AND id=$2', [
      tenantId,
      order.id,
    ])
  ).rows[0].data;
  assert.equal(stored.version, reopened.version, 'Final state must be in PostgreSQL');
});

test('invalid coordinates and mismatched segments cannot create misleading road records', async () => {
  const input = {
    roadId: road.id,
    type: 'pothole',
    latitude: 0,
    longitude: 0,
    description: marker,
  };
  assert.equal((await request('/defects', 'admin', 'POST', input)).status, 400);
  assert.equal(
    (await request('/defects', 'admin', 'POST', { ...input, latitude: 100 })).status,
    400,
  );
  assert.equal(
    (
      await request('/defects', 'admin', 'POST', {
        ...input,
        latitude: road.geometry.coordinates[0][1],
        longitude: road.geometry.coordinates[0][0],
        depthMm: -1,
      })
    ).status,
    400,
  );
});

test('GeoJSON import creates unobserved segments and rejects duplicate road codes', async () => {
  const input = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: marker, code: marker, owner: 'Test authority', region: 'Test region' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [78.4, 17.4],
            [78.405, 17.403],
          ],
        },
      },
    ],
  };
  const imported = await ok('/roads/import', 'planner', 'POST', input);
  assert.equal(imported.length, 1);
  const segments = (await ok('/segments')).filter((s: any) => s.roadId === imported[0].id);
  assert.ok(segments.length > 1);
  assert.ok(segments.every((s: any) => s.coveragePct === 0 && s.lastSurveyAt === null));
  assert.equal((await request('/roads/import', 'planner', 'POST', input)).status, 409);
});

test('device-scoped, checksum-verified uploads deduplicate and preserve private evidence', async () => {
  const device = await ok('/devices', 'admin', 'POST', { name: marker, kind: 'vehicle' });
  const id = device.device?.id || device.id,
    token = device.token || device.deviceToken;
  assert.ok(token);
  const deviceHeaders = { Authorization: `Bearer ${token}` };
  const scoped = await request('/dashboard', 'none', 'GET', undefined, deviceHeaders);
  assert.equal(scoped.status, 403);
  const surveyResponse = await request(
    '/surveys',
    'none',
    'POST',
    { deviceId: id, name: marker, roadIds: [road.id] },
    deviceHeaders,
  );
  assert.ok(surveyResponse.ok);
  const survey = (await surveyResponse.json()) as any;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const capturedAt = '2026-09-08T10:00:00.000Z';
  const form = (time = capturedAt) => {
    const f = new FormData();
    f.set('file', new Blob([png], { type: 'image/png' }), 'test.png');
    f.set('surveyId', survey.id);
    f.set('capturedAt', time);
    return f;
  };
  const headers = { ...deviceHeaders, 'Idempotency-Key': marker };
  const first = await request('/uploads', 'none', 'POST', form(), headers);
  const receipt = (await first.json()) as any;
  assert.ok(first.ok, JSON.stringify(receipt));
  const duplicate = await request('/uploads', 'none', 'POST', form(), headers);
  const repeated = (await duplicate.json()) as any;
  assert.ok(duplicate.ok);
  assert.equal(repeated.mediaId, receipt.mediaId);
  assert.equal(repeated.duplicate, true);
  assert.equal(
    (await request('/uploads', 'none', 'POST', form('2026-09-08T11:00:00.000Z'), headers)).status,
    409,
  );
  assert.equal((await request(`/media/${receipt.mediaId}`, 'none')).status, 401);
  assert.equal((await request(`/media/${receipt.mediaId}`, 'outsider')).ok, false);
  const evidence = await request(`/media/${receipt.mediaId}`);
  assert.ok(evidence.ok);
  assert.deepEqual(Buffer.from(await evidence.arrayBuffer()), png);
  assert.equal(
    (
      await db.query('SELECT count(*) FROM jobs WHERE tenant_id=$1 AND media_id=$2', [
        tenantId,
        receipt.mediaId,
      ])
    ).rows[0].count,
    '1',
  );
  // A no-model service must fail honestly; a configured model can reject this tiny
  // image on quality. Neither outcome is allowed to create invented road defects.
  let job: any;
  for (let i = 0; i < 30; i++) {
    job = (await ok('/jobs')).find((j: any) => j.id === receipt.jobId);
    if (job && ['failed', 'completed'].includes(job.status)) break;
    await delay(1000);
  }
  assert.ok(['failed', 'completed'].includes(job?.status), 'Job must leave queue');
  if (job.status === 'failed') assert.ok(job.error);
  else assert.equal(job.result.detections.length, 0);
});

test('exports are authenticated and contain stable road identifiers, units and unknown values', async () => {
  assert.equal((await request('/reports/defects.csv', 'none')).status, 401);
  const csv = await request('/reports/defects.csv');
  assert.ok(csv.ok);
  assert.match(csv.headers.get('content-type') || '', /csv/);
  const content = await csv.text();
  assert.match(content, /road/i);
  assert.match(content, /depth/i);
  const geo = await ok('/reports/geojson');
  assert.equal(geo.type, 'FeatureCollection');
});

test('internal inbox consumes committed events once and acknowledges within the tenant', async () => {
  const { initialize, tick } = await import('../apps/automation/src/worker.mjs');
  await initialize(db);
  await tick(scopedWorkerPool);
  const first = await ok('/notifications');
  assert.ok(first.length > 0);
  await tick(scopedWorkerPool);
  assert.equal((await ok('/notifications')).length, first.length);
  assert.deepEqual(await ok('/notifications', 'outsider'), []);
  await ok(`/notifications/${first[0].id}/acknowledge`, 'admin', 'POST', {});
  assert.ok((await ok('/notifications')).find((n: any) => n.id === first[0].id).acknowledgedAt);
});
