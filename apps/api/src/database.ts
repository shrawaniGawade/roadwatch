import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { seed } from './seed';
import { initializeSpatial } from './spatial';

export type DbClient = Pool | PoolClient;
@Injectable()
export class Database implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;
  spatialMode: 'postgis' | 'local_approximation' = 'local_approximation';
  constructor() {
    if (!process.env.DATABASE_URL)
      throw new Error('DATABASE_URL is required; durable PostgreSQL storage must be configured.');
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    this.pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));
  }
  async onModuleInit() {
    await this.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(71836211)');
      await c.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const directory = resolve(__dirname, '../migrations');
      for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
        if ((await c.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).rowCount)
          continue;
        await c.query(await readFile(resolve(directory, name), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
      }
    });
    this.spatialMode = await initializeSpatial(this.pool);
    await seed(this);
  }
  query<T extends QueryResultRow = any>(sql: string, values: unknown[] = []) {
    return this.pool.query<T>(sql, values);
  }
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
