import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const data = resolve(root, '.local/postgres');
const port = process.env.LOCAL_PG_PORT || '55432';
const run = (command, args, allowFailure = false) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (!allowFailure && result.status !== 0)
    throw new Error(`${command} failed. Install PostgreSQL 14+ or use docker compose.`);
  return result.status;
};
export function database(action = 'start') {
  if (action === 'stop') {
    if (existsSync(data)) run('pg_ctl', ['-D', data, 'stop', '-m', 'fast'], true);
    return;
  }
  mkdirSync(resolve(root, '.local'), { recursive: true });
  if (!existsSync(resolve(data, 'PG_VERSION'))) {
    run('initdb', [
      '-D',
      data,
      '-U',
      'roadwatch',
      '--auth-local=trust',
      '--auth-host=trust',
      '--encoding=UTF8',
      '--locale=C',
    ]);
  }
  const status = spawnSync('pg_ctl', ['-D', data, 'status'], { stdio: 'ignore' });
  if (status.status !== 0)
    run('pg_ctl', [
      '-D',
      data,
      '-l',
      resolve(root, '.local/postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k /tmp`,
      'start',
    ]);
  const present = spawnSync(
    'psql',
    [
      '-h',
      '127.0.0.1',
      '-p',
      port,
      '-U',
      'roadwatch',
      '-d',
      'postgres',
      '-tAc',
      "SELECT 1 FROM pg_database WHERE datname='roadwatch'",
    ],
    { encoding: 'utf8' },
  );
  if (present.status !== 0) throw new Error('Local database availability check failed');
  if (present.stdout.trim() !== '1')
    run('createdb', ['-h', '127.0.0.1', '-p', port, '-U', 'roadwatch', 'roadwatch']);
  console.log(`Local development database: 127.0.0.1:${port}/roadwatch (loopback only).`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) database(process.argv[2]);
