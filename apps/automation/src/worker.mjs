import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function overdueEvent(order, tenantId, now = Date.now()) {
  const due = Date.parse(order.dueAt);
  if (!Number.isFinite(due) || due >= now || order.status === 'closed') return null;
  return {
    key: `overdue:${tenantId}:${order.id}:${order.dueAt}`,
    title: `${order.code || 'Work order'} is overdue`,
    body: `Assigned to ${order.crew || 'unassigned crew'}. Due ${new Date(due).toISOString()}. Current status: ${order.status}. Review the maintenance schedule.`,
    entityType: 'work_order',
    entityId: order.id,
  };
}

export async function initialize(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(71836214)');
    await c.query(
      await readFile(new URL('../migrations/001_notifications.sql', import.meta.url), 'utf8'),
    );
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

// Outbox acknowledgement and inbox insertion share a transaction. Multiple workers
// may run safely; SKIP LOCKED distributes rows and unique keys make replay idempotent.
export async function tick(pool) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const events = await c.query(
      'SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED',
    );
    let created = 0;
    for (const event of events.rows) {
      if (/work.?order|job.*fail|defect.*(confirm|urgent)/i.test(event.event_type)) {
        const result = await c.query(
          `INSERT INTO notifications(id,tenant_id,source_event_id,event_key,title,body,entity_type,entity_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            randomUUID(),
            event.tenant_id,
            event.id,
            `event:${event.id}`,
            event.event_type.replace(/[._]/g, ' '),
            `An update was recorded for ${event.payload.entityType || 'record'} ${event.aggregate_id}. Open the audit trail for details.`,
            event.payload.entityType || 'record',
            event.aggregate_id,
          ],
        );
        created += result.rowCount;
      }
      await c.query(
        'UPDATE outbox SET published_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1',
        [event.id],
      );
    }
    const overdue =
      await c.query(`SELECT tenant_id,data FROM work_orders WHERE data->>'status'<>'closed'
      AND (data->>'dueAt')::timestamptz < now()`);
    for (const row of overdue.rows) {
      const event = overdueEvent(row.data, row.tenant_id);
      if (!event) continue;
      const result = await c.query(
        `INSERT INTO notifications(id,tenant_id,event_key,title,body,entity_type,entity_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key) DO NOTHING RETURNING id`,
        [
          randomUUID(),
          row.tenant_id,
          event.key,
          event.title,
          event.body,
          event.entityType,
          event.entityId,
        ],
      );
      created += result.rowCount;
      if (result.rowCount)
        await c.query(
          `INSERT INTO audit(id,tenant_id,actor,action,entity_type,entity_id,details)
        VALUES($1,$2,'Automation','work_order.overdue','work_order',$3,$4)`,
          [
            randomUUID(),
            row.tenant_id,
            event.entityId,
            JSON.stringify({ dueAt: row.data.dueAt, notificationId: result.rows[0].id }),
          ],
        );
    }
    // Session data is transient; evidence records are retained pending an explicit
    // legal-hold-aware retention policy. Never silently remove a repair's evidence.
    await c.query('DELETE FROM sessions WHERE expires_at < now()');
    await c.query("DELETE FROM login_limits WHERE started_at < now()-interval '1 day'");
    await c.query(
      `INSERT INTO automation_status(worker,last_success_at,detail) VALUES('inbox',now(),$1)
      ON CONFLICT(worker) DO UPDATE SET last_success_at=excluded.last_success_at,detail=excluded.detail`,
      [JSON.stringify({ consumed: events.rowCount, notificationsCreated: created })],
    );
    await c.query('COMMIT');
    return { consumed: events.rowCount, notificationsCreated: created };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  let stopped = false;
  const abort = new AbortController();
  const stop = () => {
    stopped = true;
    abort.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const interval = Number(process.env.AUTOMATION_INTERVAL_MS || 30000);
  if (!Number.isFinite(interval) || interval < 1000 || interval > 3600000)
    throw new Error('Invalid AUTOMATION_INTERVAL_MS');
  await initialize(pool);
  console.log('Durable inbox and overdue maintenance monitoring started.');
  try {
    while (!stopped) {
      try {
        const result = await tick(pool);
        if (result.notificationsCreated) console.log(JSON.stringify(result));
      } catch (error) {
        console.error('Automation transaction rolled back:', error.message);
      }
      try {
        await delay(interval, undefined, { signal: abort.signal });
      } catch {}
    }
  } finally {
    await pool.end();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
