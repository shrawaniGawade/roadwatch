import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

if (existsSync('.env')) process.loadEnvFile('.env');
assert.equal(
  process.env.DEMO_SEED,
  'true',
  'This fixture is for an explicit demonstration workspace.',
);
assert.notEqual(process.env.NODE_ENV, 'production');
const base = process.env.WEB_URL || 'http://localhost:3000';
const origin = process.env.APP_ORIGIN || base;
let cookie;
async function request(path, method = 'GET', body, extra = {}) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...extra,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45000),
  });
  assert.ok(response.ok, `${method} ${path} failed with HTTP ${response.status}`);
  return response;
}
const login = await request('/auth/login', 'POST', {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
});
cookie = login.headers
  .getSetCookie()
  .find((value) => value.startsWith('roadwatch_session='))
  .split(';')[0];
const devices = await (await request('/devices')).json();
assert.ok(devices.length, 'Provision a demonstration device first.');
const survey = await (
  await request('/surveys', 'POST', {
    deviceId: devices[0].id,
    name: 'Public-domain photo smoke · location unknown',
    roadIds: [],
  })
).json();
const bytes = await readFile('tests/fixtures/pothole-public-domain.jpg');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const form = new FormData();
form.append('surveyId', survey.id);
// This synthetic import timestamp is not the historical camera exposure time.
form.append('capturedAt', new Date().toISOString());
form.append(
  'file',
  new Blob([bytes], { type: 'image/jpeg' }),
  'public-domain-smoke-location-unknown.jpg',
);
const upload = await (
  await request('/uploads', 'POST', form, {
    'Idempotency-Key': `public-photo-smoke-${randomUUID()}`,
    'X-Content-SHA256': sha256,
  })
).json();
let job;
for (let attempt = 0; attempt < 90; attempt++) {
  job = (await (await request('/jobs')).json()).find((item) => item.id === upload.jobId);
  if (job && ['completed', 'failed'].includes(job.status)) break;
  await delay(1000);
}
assert.equal(job?.status, 'completed', job?.error || 'Processing did not complete');
assert.ok(
  job.result.detections.length > 0,
  'Expected at least one observation on the smoke photograph',
);
assert.ok(job.result.detections[0].mask.length >= 3, 'Expected a segmentation outline');
assert.equal(job.result.createdDefects, 0, 'Unknown photo location must not create a road hazard');
assert.equal(job.result.unlocatedDetections, job.result.detections.length);
assert.equal(job.result.detections[0].depth.value, null, 'RGB must not fabricate cavity depth');
const retained = Buffer.from(await (await request(`/media/${upload.mediaId}`)).arrayBuffer());
assert.equal(createHash('sha256').update(retained).digest('hex'), sha256);
await request(`/surveys/${survey.id}/complete`, 'POST');
const record = {
  checkedAt: new Date().toISOString(),
  surveyId: survey.id,
  jobId: job.id,
  mediaId: upload.mediaId,
  sha256,
  status: job.status,
  detections: job.result.detections.length,
  confidence: job.result.detections[0].confidence,
  maskPoints: job.result.detections[0].mask.length,
  unlocatedDetections: job.result.unlocatedDetections,
  createdDefects: job.result.createdDefects,
  model: job.result.model,
  note: 'Runtime smoke only; this public-domain photograph has no known geographic location or metrology ground truth. The upload timestamp is synthetic.',
};
await mkdir('.artifacts', { recursive: true });
await writeFile('.artifacts/real-model-smoke.json', JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
await request('/auth/logout', 'POST');
