import test from 'node:test';
import assert from 'node:assert/strict';
import { overdueEvent } from '../src/worker.mjs';

const order = {
  id: 'one',
  code: 'WO-1',
  crew: 'North',
  dueAt: '2026-01-01T00:00:00Z',
  status: 'assigned',
};
test('overdue rules exclude closed, future, invalid, and exact deadline orders', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(overdueEvent(order, 'tenant', now), null);
  assert.equal(overdueEvent({ ...order, status: 'closed' }, 'tenant', now + 1), null);
  assert.equal(overdueEvent({ ...order, dueAt: 'broken' }, 'tenant', now + 1), null);
  assert.equal(overdueEvent(order, 'tenant', now - 1), null);
  assert.ok(overdueEvent(order, 'tenant', now + 1));
});
test('deduplication identity persists across sweeps but changes for a rescheduled deadline', () => {
  const first = overdueEvent(order, 'tenant', Date.parse('2026-01-02'));
  assert.equal(first.key, overdueEvent(order, 'tenant', Date.parse('2026-01-03')).key);
  assert.notEqual(
    first.key,
    overdueEvent({ ...order, dueAt: '2026-01-02T00:00:00Z' }, 'tenant', Date.parse('2026-01-03'))
      .key,
  );
  assert.notEqual(first.key, overdueEvent(order, 'another', Date.parse('2026-01-03')).key);
});
