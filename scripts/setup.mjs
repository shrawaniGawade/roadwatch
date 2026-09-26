import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { database } from './database.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
const run = (command, args) => {
  const r = spawnSync(command, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${command} failed`);
};
mkdirSync('.local', { recursive: true });
if (!existsSync('.env')) {
  const password = randomBytes(18).toString('base64url');
  const teamPassword = randomBytes(18).toString('base64url');
  const template = readFileSync('.env.example', 'utf8')
    .replace('replace-with-a-generated-local-password', password)
    .replace('replace-with-a-generated-team-password', teamPassword)
    .replace('replace-with-at-least-32-random-bytes', randomBytes(32).toString('hex'))
    .replace('replace-with-a-generated-service-key', randomBytes(32).toString('hex'));
  writeFileSync('.env', template, { mode: 0o600 });
  writeFileSync(
    '.local/credentials.txt',
    `LOCAL DEVELOPMENT ONLY\nURL: http://localhost:3000\nAdministrator: operator@roadwatch.local\nPassword: ${password}\n\nTeam accounts: reviewer@roadwatch.local, planner@roadwatch.local, crew@roadwatch.local, viewer@roadwatch.local\nTeam password: ${teamPassword}\n\nPasswords are generated once and seeded on first startup. Editing .env does not rotate existing accounts.\n`,
    { mode: 0o600 },
  );
  chmodSync('.env', 0o600);
  console.log('Generated local secrets. Credentials saved to .local/credentials.txt.');
}
process.loadEnvFile('.env');
if (process.env.DATABASE_URL === 'postgresql://roadwatch@127.0.0.1:55432/roadwatch')
  database('start');
if (!process.argv.includes('--env-only')) {
  run('npm', ['ci']);
  if (!existsSync('.venv/bin/python')) run('uv', ['venv', '--python', '3.12', '.venv']);
  run('uv', [
    'pip',
    'install',
    '--python',
    '.venv/bin/python',
    '--require-hashes',
    '-r',
    'requirements-dev.lock',
  ]);
  run('uv', [
    'pip',
    'install',
    '--python',
    '.venv/bin/python',
    '--no-deps',
    '-e',
    'services/vision',
    '-e',
    'services/edge',
  ]);
  run('npm', ['run', 'build', '-w', '@roadwatch/domain']);
  run('npm', ['run', 'build', '-w', '@roadwatch/storage']);
  run('npm', ['run', 'build', '-w', '@roadwatch/api']);
  console.log(
    'Setup complete. Run npm run dev. Install browser tests with npx playwright install chromium.',
  );
}
