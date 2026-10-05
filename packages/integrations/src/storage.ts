import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export interface Storage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

/** Development driver: files under a local directory. */
export class LocalStorage implements Storage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return p;
  }

  async put(key: string, body: Uint8Array, _contentType?: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { flag: 'wx' }); // never overwrite an existing object
  }

  async get(key: string): Promise<Uint8Array> {
    return readFile(this.path(key));
  }
}

/** Production driver: S3 in ap-south-1 with SSE-KMS (bucket default encryption). */
export class S3Storage implements Storage {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.client = new S3Client({ region });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'aws:kms',
        IfNoneMatch: '*',
      }),
    );
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty object: ${key}`);
    return res.Body.transformToByteArray();
  }
}

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): Storage {
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
    return new S3Storage(env.S3_BUCKET, env.S3_REGION ?? 'ap-south-1');
  }
  return new LocalStorage(env.STORAGE_LOCAL_DIR ?? './storage');
}

export function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}
