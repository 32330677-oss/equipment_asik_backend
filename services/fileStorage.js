// services/fileStorage.js — storage adapter. Only the KEY is stored in the database.
//   FILE_STORAGE_DRIVER=local  -> files under FILE_STORAGE_DIR (default ./storage, never served statically)
//   FILE_STORAGE_DRIVER=s3     -> any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2 ...)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');

function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function safeKey(key) {
  const k = String(key).replace(/\\/g, '/');
  if (!k || k.startsWith('/') || k.split('/').some((p) => p === '..' || p === '')) throw new Error(`Unsafe storage key: ${key}`);
  return k;
}

// ------------------------------------------------------------------ local
const local = {
  root() { return path.resolve(env.storage.dir); },
  async put({ key, buffer }) {
    const full = path.join(this.root(), safeKey(key));
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, buffer, { flag: 'wx' }).catch(async (e) => {
      if (e.code !== 'EEXIST') throw e; // same key = same content (key contains the hash)
    });
  },
  async getBuffer(key) {
    try { return await fs.promises.readFile(path.join(this.root(), safeKey(key))); } catch (e) {
      if (e.code === 'ENOENT') throw AppError.notFound('File');
      throw e;
    }
  },
  async exists(key) { try { await fs.promises.access(path.join(this.root(), safeKey(key))); return true; } catch (_) { return false; } },
};

// ------------------------------------------------------------------ s3
let s3Client = null;
function s3() {
  if (!s3Client) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: env.storage.s3.region,
      endpoint: env.storage.s3.endpoint || undefined,
      credentials: env.storage.s3.accessKeyId ? { accessKeyId: env.storage.s3.accessKeyId, secretAccessKey: env.storage.s3.secretAccessKey } : undefined,
      forcePathStyle: Boolean(env.storage.s3.endpoint),
    });
  }
  return s3Client;
}
const s3Driver = {
  async put({ key, buffer, contentType }) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3().send(new PutObjectCommand({ Bucket: env.storage.s3.bucket, Key: safeKey(key), Body: buffer, ContentType: contentType }));
  },
  async getBuffer(key) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const out = await s3().send(new GetObjectCommand({ Bucket: env.storage.s3.bucket, Key: safeKey(key) }));
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e) {
      if (e.name === 'NoSuchKey' || (e.$metadata && e.$metadata.httpStatusCode === 404)) throw AppError.notFound('File');
      throw e;
    }
  },
  async exists(key) {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    try { await s3().send(new HeadObjectCommand({ Bucket: env.storage.s3.bucket, Key: safeKey(key) })); return true; } catch (_) { return false; }
  },
};

function driver() { return env.storage.driver === 's3' ? s3Driver : local; }

/** Store a buffer; returns { key, size, sha256 }. */
async function put({ key, buffer, contentType }) {
  await driver().put({ key, buffer, contentType });
  return { key, size: buffer.length, sha256: sha256(buffer) };
}
async function getBuffer(key) { return driver().getBuffer(key); }
async function exists(key) { return driver().exists(key); }

/** Send a stored file to the client (inline by default). */
async function send(res, key, { contentType = 'application/octet-stream', fileName = 'file', inline = true } = {}) {
  const buf = await getBuffer(key);
  res.set('Content-Type', contentType);
  res.set('Content-Length', String(buf.length));
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(fileName).replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.send(buf);
}

module.exports = { put, getBuffer, exists, send, sha256 };
