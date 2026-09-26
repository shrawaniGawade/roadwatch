import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { database } from './database.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
if (!existsSync('.env') || !existsSync('.venv/bin/python'))
  throw new Error('Run npm run setup first.');
process.loadEnvFile('.env');
if (process.env.DATABASE_URL === 'postgresql://roadwatch@127.0.0.1:55432/roadwatch')
  database('start');
for (const workspace of ['@roadwatch/domain', '@roadwatch/storage', '@roadwatch/api']) {
  if (spawnSync('npm', ['run', 'build', '-w', workspace], { stdio: 'inherit' }).status !== 0)
    process.exit(1);
}
const children = [];
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 3000).unref();
}
function launch(name, command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.on('error', (error) => {
    console.error(`${name}: ${error.message}`);
    shutdown(1);
  });
  child.on('exit', (code) => {
    if (!closing) {
      console.error(`${name} exited (${code})`);
      shutdown(code || 1);
    }
  });
  children.push(child);
  return child;
}
async function ready(url) {
  for (let i = 0; i < 90 && !closing; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    await delay(1000);
  }
  throw new Error(`Startup timed out: ${url}`);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
try {
  launch('vision', resolve('.venv/bin/python'), [
    '-m',
    'uvicorn',
    'roadwatch_vision.app:app',
    '--host',
    '127.0.0.1',
    '--port',
    '8001',
  ]);
  launch('api', process.execPath, ['apps/api/dist/main.js']);
  await ready(`http://127.0.0.1:${process.env.API_PORT || 3001}/v1/health`);
  launch('automation', process.execPath, ['apps/automation/src/worker.mjs']);
  launch(
    'web',
    process.execPath,
    [
      resolve('node_modules/next/dist/bin/next'),
      'dev',
      '--hostname',
      '0.0.0.0',
      '--port',
      process.env.WEB_PORT || '3000',
    ],
    resolve('apps/web'),
  );
  await ready(`http://localhost:${process.env.WEB_PORT || 3000}/login`);
  console.log(
    '\nRoadWatch ready: http://localhost:3000\nCredentials: .local/credentials.txt\nModel status and ingestion errors are visible in Surveys. Ctrl+C stops services; PostgreSQL remains available.\n',
  );
} catch (error) {
  console.error(error);
  shutdown(1);
}
