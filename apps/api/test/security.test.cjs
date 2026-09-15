const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, checkPassword, digest } = require('../dist/credentials');
const { validateOrigin, requireRole } = require('../dist/security');
const { csvCell } = require('../dist/utils');
const { mediaType } = require('../dist/media.service');
const { assessmentFor, priorityPolicySchema } = require('../dist/findings.service');

test('password hashes have independent salts and reject wrong/corrupt credentials', async () => {
  const one = await hashPassword('a long test password'),
    two = await hashPassword('a long test password');
  assert.notEqual(one, two);
  assert.equal(await checkPassword('a long test password', one), true);
  assert.equal(await checkPassword('different password', one), false);
  assert.equal(await checkPassword('x', 'broken'), false);
  assert.equal(digest('opaque-session').length, 64);
  assert.notEqual(digest('opaque-session'), 'opaque-session');
});
test('cookie-authenticated mutations require a trusted browser origin', () => {
  const request = (origin, method = 'POST', cookie = true) => ({
    method,
    cookies: cookie ? { roadwatch_session: 'test' } : {},
    get: () => origin,
  });
  assert.throws(() => validateOrigin(request('https://attacker.example')), /trusted Origin/);
  assert.throws(() => validateOrigin(request(undefined)), /trusted Origin/);
  assert.doesNotThrow(() => validateOrigin(request('http://localhost:3000')));
  assert.doesNotThrow(() => validateOrigin(request(undefined, 'GET')));
});
test('role grants fail closed for read-only and device identities', () => {
  assert.throws(() => requireRole({ role: 'viewer' }, 'admin', 'reviewer'));
  assert.throws(() => requireRole({ role: 'device' }, 'admin', 'planner'));
  assert.doesNotThrow(() => requireRole({ role: 'reviewer' }, 'admin', 'reviewer'));
});
test('CSV protects spreadsheet formulas even behind control whitespace', () => {
  for (const s of ['=HYPERLINK("x")', '+1+1', '-1+1', '@SUM(A1)', '\t=1', '\u0000=1'])
    assert.match(csvCell(s), /^"'/);
  assert.equal(csvCell('ordinary,"text"'), '"ordinary,""text"""');
  assert.equal(csvCell(null), '""');
});
test('upload classifier rejects forged MIME without recognizable bytes', () => {
  assert.equal(mediaType(Buffer.from('<script>malicious</script>')), null);
  assert.equal(mediaType(Buffer.from([0xff, 0xd8, 0xff, ...Array(9).fill(0)])), 'image/jpeg');
  assert.equal(mediaType(Buffer.from('RIFFxxxxWEBPxxxx')), 'image/webp');
});
test('validated priority defaults change assessment while retaining assumed provenance', () => {
  const base = assessmentFor({ type: 'pothole', depthMm: 70 }, { version: 1 });
  const high = assessmentFor(
    { type: 'pothole', depthMm: 70 },
    {
      version: 2,
      priorityPolicy: {
        defaultTrafficExposure: 100,
        defaultVulnerableContext: 100,
        defaultGrowthScore: 100,
      },
    },
  );
  assert.ok(high.score > base.score);
  assert.equal(high.policyVersion, 'reference-1.0/org-2');
  assert.equal(high.components.find((c) => c.key === 'exposure').assumed, true);
  assert.equal(priorityPolicySchema.safeParse({ arbitraryWeight: 999 }).success, false);
  assert.equal(priorityPolicySchema.safeParse({ defaultTrafficExposure: -1 }).success, false);
});
