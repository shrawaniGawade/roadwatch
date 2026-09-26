import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const target = resolve(
  process.argv[2] || `.local/backups/${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
await mkdir(target, { recursive: true, mode: 0o700 });
// Connection details stay in the child environment and are not printed/placed in argv.
const url = new URL(process.env.DATABASE_URL);
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
};
const dump = spawn('pg_dump', ['--format=custom', '--file', resolve(target, 'database.dump')], {
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
await new Promise((done, fail) => {
  dump.on('exit', (code) => (code === 0 ? done(undefined) : fail(new Error('pg_dump failed'))));
  dump.on('error', fail);
});
const files = [];
if ((process.env.STORAGE_DRIVER || 'local') === 'local') {
  const source = resolve(process.env.STORAGE_DIR || '.local/media');
  if (existsSync(source))
    for (const tenant of await readdir(source, { withFileTypes: true })) {
      if (!tenant.isDirectory()) continue;
      await mkdir(resolve(target, 'evidence', tenant.name), { recursive: true, mode: 0o700 });
      for (const item of await readdir(resolve(source, tenant.name), { withFileTypes: true })) {
        if (!item.isFile()) continue;
        const key = `${tenant.name}/${item.name}`;
        const destination = resolve(target, 'evidence', key);
        await copyFile(resolve(source, key), destination);
        const bytes = await readFile(destination);
        files.push({
          key,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
}
await writeFile(
  resolve(target, 'manifest.json'),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      storageDriver: process.env.STORAGE_DRIVER || 'local',
      files,
      note: 'Stop writes for a coordinated snapshot; validate database references and checksums after restore. S3 objects require separately versioned backup.',
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Backup written to ${target}. Store it encrypted outside this host and test restore into a separate database.`,
);
