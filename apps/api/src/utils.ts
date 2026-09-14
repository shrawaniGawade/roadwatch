import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DbClient } from './database';
import type { Principal } from './security';

export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException({
      message: result.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; '),
      code: 'validation_error',
    });
  return result.data;
}
export const identifier = (id: string) => parse(z.string().uuid(), id);
export function conflict(message = 'This record changed. Refresh and try again.') {
  throw new ConflictException({ message, code: 'version_conflict' });
}
export function missing(entity: string): never {
  throw new NotFoundException({ message: `${entity} was not found.`, code: 'not_found' });
}
export async function audit(
  c: DbClient,
  actor: Principal,
  action: string,
  entityType: string,
  entityId: string,
  details: unknown = {},
) {
  const eventId = uuid();
  await c.query(
    'INSERT INTO audit(id,tenant_id,actor,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      eventId,
      actor.tenantId,
      actor.name || actor.email,
      action,
      entityType,
      entityId,
      JSON.stringify(details),
    ],
  );
  await c.query(
    'INSERT INTO outbox(id,tenant_id,event_type,aggregate_id,payload) VALUES($1,$2,$3,$4,$5)',
    [
      uuid(),
      actor.tenantId,
      action,
      entityId,
      JSON.stringify({ auditId: eventId, actorId: actor.id, entityType, details }),
    ],
  );
}
export function meters(a: number[], b: number[]) {
  const r = Math.PI / 180;
  const p =
    Math.sin(((b[1] - a[1]) * r) / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(p), Math.sqrt(1 - p));
}
export function lineLength(coordinates: number[][]) {
  return coordinates.slice(1).reduce((sum, p, i) => sum + meters(coordinates[i], p), 0);
}
export function locateOnLine(point: number[], coordinates: number[][]) {
  let distance = Infinity,
    chainage = 0,
    covered = 0;
  const sx = 111195 * Math.cos((point[1] * Math.PI) / 180),
    sy = 111195;
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1],
      b = coordinates[i];
    const ax = (a[0] - point[0]) * sx,
      ay = (a[1] - point[1]) * sy,
      bx = (b[0] - point[0]) * sx,
      by = (b[1] - point[1]) * sy;
    const dx = bx - ax,
      dy = by - ay,
      length = meters(a, b),
      t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < distance) {
      distance = d;
      chainage = covered + t * length;
    }
    covered += length;
  }
  return { distance, chainage };
}
export function splitLine(coordinates: number[][], interval = 100) {
  const output: { coordinates: number[][]; start: number; end: number }[] = [];
  let segment = [coordinates[0]],
    chainage = 0,
    start = 0,
    next = interval;
  for (let i = 1; i < coordinates.length; i++) {
    let a = coordinates[i - 1];
    const b = coordinates[i];
    let remaining = meters(a, b);
    while (chainage + remaining >= next && remaining > 0) {
      const fraction = (next - chainage) / remaining,
        cut = [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
      segment.push(cut);
      output.push({ coordinates: segment, start, end: next });
      a = cut;
      remaining = meters(a, b);
      chainage = next;
      start = next;
      next += interval;
      segment = [cut];
    }
    chainage += remaining;
    segment.push(b);
  }
  if (chainage > start) output.push({ coordinates: segment, start, end: chainage });
  return output;
}
export const unknownMeasurement = (
  unit: string,
  reason = 'Requires calibrated physical measurement.',
) => ({ value: null, unit, status: 'unknown', method: 'unavailable', uncertainty95: null, reason });
export const estimatedMeasurement = (value: number | undefined, unit: string) =>
  value === undefined
    ? unknownMeasurement(unit)
    : {
        value,
        unit,
        status: 'estimated',
        method: 'manual_report',
        uncertainty95: null,
        reason: 'Unverified field estimate; requires survey confirmation.',
      };
export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
