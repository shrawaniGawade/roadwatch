import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalEvidenceStore, S3EvidenceStore, assertKey, sha256 } from './index';

test('local evidence persists across instances, refuses overwrite and blocks traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roadwatch-evidence-'));
  try {
    const store = new LocalEvidenceStore(root);
    const key = `${randomUUID()}/${randomUUID()}`;
    const bytes = Buffer.from('durable evidence');
    await store.put(key, bytes);
    assert.deepEqual(await new LocalEvidenceStore(root).read(key), bytes);
    await assert.rejects(store.put(key, bytes), /EEXIST/);
    for (const bad of ['../secret', '/etc/passwd', key + '/..', key.replace('/', '/../../')])
      assert.throws(() => assertKey(bad));
    await store.remove(key);
    await store.remove(key);
    await assert.rejects(store.read(key), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local evidence refuses a symlink as the object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roadwatch-symlink-'));
  try {
    const store = new LocalEvidenceStore(root);
    const key = `${randomUUID()}/${randomUUID()}`;
    await store.put(key, Buffer.from('original'));
    await store.remove(key);
    await writeFile(join(root, 'sensitive'), 'do not read');
    await symlink(join(root, 'sensitive'), join(root, key));
    await assert.rejects(store.read(key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('S3 adapter sends immutable encrypted uploads and validates received checksum', async () => {
  const key = `${randomUUID()}/${randomUUID()}`,
    bytes = Buffer.from('private evidence');
  let put: any;
  const client = {
    async send(command: any) {
      if (command.constructor.name === 'PutObjectCommand') {
        put = command.input;
        return {};
      }
      return {
        Body: Readable.from([bytes]),
        ContentLength: bytes.length,
        Metadata: { sha256: sha256(bytes) },
      };
    },
  };
  const store = new S3EvidenceStore(client as any, 'private-bucket', 'test-kms-key');
  await store.put(key, bytes);
  assert.equal(put.IfNoneMatch, '*');
  assert.equal(put.ServerSideEncryption, 'aws:kms');
  assert.equal(put.Metadata.sha256, sha256(bytes));
  assert.equal(put.ACL, undefined);
  assert.deepEqual(await store.read(key), bytes);
  const corrupt = new S3EvidenceStore(
    {
      send: async () => ({ Body: Readable.from([bytes]), Metadata: { sha256: '0'.repeat(64) } }),
    } as any,
    'private-bucket',
  );
  await assert.rejects(corrupt.read(key), /checksum mismatch/);
});
