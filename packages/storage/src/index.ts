import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, unlink, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const MAX_BYTES = 32 * 1024 * 1024;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const KEY = new RegExp(`^${UUID}/${UUID}$`, 'i');
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function assertKey(key: string) {
  if (!KEY.test(key)) throw new Error('Evidence storage key must be tenant UUID/object UUID');
}
function assertSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES)
    throw new Error('Evidence must be between 1 byte and 32 MiB');
}
export interface EvidenceStore {
  put(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  close?(): void;
}

export class LocalEvidenceStore implements EvidenceStore {
  readonly root: string;
  constructor(directory: string) {
    this.root = resolve(directory);
  }
  private path(key: string) {
    assertKey(key);
    return resolve(this.root, key);
  }
  async put(key: string, bytes: Buffer) {
    const path = this.path(key);
    assertSize(bytes.length);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if ((await lstat(dirname(path))).isSymbolicLink())
      throw new Error('Evidence directory cannot be a symbolic link');
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await file.close();
    }
    // Persist the directory entry as well as file bytes before acknowledging upload.
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async read(key: string) {
    const path = this.path(key);
    if ((await lstat(dirname(path))).isSymbolicLink())
      throw new Error('Evidence directory cannot be a symbolic link');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Evidence is not a file');
      assertSize(stat.size);
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  async remove(key: string) {
    await unlink(this.path(key)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export class S3EvidenceStore implements EvidenceStore {
  constructor(
    private client: S3Client,
    private bucket: string,
    private kmsKey?: string,
  ) {
    if (!bucket) throw new Error('S3_BUCKET is required');
  }
  async put(key: string, bytes: Buffer) {
    assertKey(key);
    assertSize(bytes.length);
    const hash = sha256(bytes);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: 'application/octet-stream',
        IfNoneMatch: '*',
        ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64'),
        Metadata: { sha256: hash },
        ServerSideEncryption: this.kmsKey ? 'aws:kms' : 'AES256',
        SSEKMSKeyId: this.kmsKey,
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
  }
  async read(key: string) {
    assertKey(key);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    if (!result.Body) throw new Error('Evidence object has no body');
    if (result.ContentLength !== undefined) assertSize(result.ContentLength);
    // Stream into a bounded buffer, even if the upstream omits/misreports length.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const piece of result.Body as AsyncIterable<Uint8Array>) {
      const bytes = Buffer.from(piece);
      size += bytes.length;
      if (size > MAX_BYTES) {
        (result.Body as { destroy?: () => void }).destroy?.();
        throw new Error('Evidence object exceeds size limit');
      }
      chunks.push(bytes);
    }
    assertSize(size);
    const bytes = Buffer.concat(chunks);
    if (result.Metadata?.sha256 && sha256(bytes) !== result.Metadata.sha256)
      throw new Error('Evidence object checksum mismatch');
    return bytes;
  }
  async remove(key: string) {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(30000),
    });
  }
  close() {
    this.client.destroy();
  }
}

export function createEvidenceStore(): EvidenceStore {
  const driver = process.env.STORAGE_DRIVER || 'local';
  if (driver === 'local') return new LocalEvidenceStore(process.env.STORAGE_DIR || '.local/media');
  if (driver !== 's3') throw new Error('STORAGE_DRIVER must be local or s3');
  const endpoint = process.env.S3_ENDPOINT;
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(
          process.env.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost'].includes(url.hostname)
        ))
    )
      throw new Error('S3 endpoint requires HTTPS; credentials use the SDK provider chain');
  }
  const client = new S3Client({
    region: process.env.S3_REGION || process.env.AWS_REGION,
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    maxAttempts: 3,
  });
  return new S3EvidenceStore(client, process.env.S3_BUCKET || '', process.env.S3_KMS_KEY_ID);
}
