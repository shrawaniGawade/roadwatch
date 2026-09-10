import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPriority,
  unknownMeasurement,
  estimatedMeasurement,
  measurementSchema,
  lineLengthM,
  splitRoadSegments,
  nearestPointOnRoad,
  assertWorkOrderTransition,
  toCsv,
  type Road,
} from './index';
const road: Road = {
  id: 'r1',
  name: 'Test road',
  code: 'R1',
  region: 'Test',
  owner: 'Test',
  surface: 'asphalt',
  version: 1,
  updatedAt: '2026-01-01',
  lengthM: 0,
  geometry: {
    type: 'LineString',
    coordinates: [
      [78.4, 17.4],
      [78.402, 17.4],
      [78.403, 17.401],
    ],
  },
};
test('unknown depth is preserved and triggers inspection rather than zero severity', () => {
  const a = assessPriority({ depthMm: null });
  assert.equal(a.severity, 'unknown');
  assert.equal(a.inspectionRequired, true);
  assert.ok(a.score > 0);
  assert.equal(unknownMeasurement('mm').value, null);
  assert.throws(() => measurementSchema.parse({ ...unknownMeasurement('mm'), value: 0 }));
});
test('reference pothole thresholds have exact boundary semantics', () => {
  assert.equal(assessPriority({ depthMm: 24.9 }).severity, 'low');
  assert.equal(assessPriority({ depthMm: 25 }).severity, 'moderate');
  assert.equal(assessPriority({ depthMm: 50 }).severity, 'moderate');
  assert.equal(assessPriority({ depthMm: 50.01 }).severity, 'high');
  assert.equal(assessPriority({ type: 'raveling', depthMm: 90 }).severity, 'unknown');
});
test('priority rejects nonfinite inputs and separates emergency override', () => {
  assert.throws(() => assessPriority({ depthMm: NaN }));
  assert.throws(() => estimatedMeasurement(-1, 'm'));
  assert.equal(assessPriority({ depthMm: 15, emergency: true }).priority, 'P0');
});
test('segments preserve road length and intermediate vertices', () => {
  const segments = splitRoadSegments(road, 100);
  assert.equal(segments.length, 4);
  assert.ok(
    Math.abs(
      segments.reduce((sum, s) => sum + lineLengthM(s.geometry), 0) - lineLengthM(road.geometry),
    ) < 0.1,
  );
  assert.equal(segments[0]!.coveragePct, 0);
  assert.equal(segments.at(-1)!.chainageEndM, lineLengthM(road.geometry));
});
test('nearest road point returns metric distance and chainage without modifying input', () => {
  const p: [number, number] = [78.401, 17.4001];
  const r = nearestPointOnRoad(p, road);
  assert.ok(r.distanceM > 10 && r.distanceM < 12);
  assert.ok(r.chainageM > 100 && r.chainageM < 110);
  assert.deepEqual(p, [78.401, 17.4001]);
});
test('independent verification and lifecycle sequence enforced', () => {
  assert.equal(assertWorkOrderTransition('assigned', 'start', 'crew', 'a'), 'in_progress');
  assert.throws(() => assertWorkOrderTransition('assigned', 'verify', 'admin', 'a', 'b'));
  assert.throws(() => assertWorkOrderTransition('repair_reported', 'verify', 'admin', 'a', 'a'));
  assert.throws(() => assertWorkOrderTransition('repair_reported', 'verify', 'crew', 'b', 'a'));
  assert.equal(
    assertWorkOrderTransition('repair_reported', 'verify', 'reviewer', 'b', 'a'),
    'closed',
  );
});
test('CSV neutralizes spreadsheet formulas and escapes quotes and newlines', () => {
  const csv = toCsv(['name'], [['=SUM(A1)'], [' +42'], ['a"b\nc']]);
  assert.ok(csv.includes('"\'=SUM(A1)"'));
  assert.ok(csv.includes('"\' +42"'));
  assert.ok(csv.includes('"a""b\nc"'));
});
