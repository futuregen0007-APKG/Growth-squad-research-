/**
 * DocumentStorageService.js
 * ===========================
 * Durable storage for downloaded BSE/NSE PDF bytes -- this backend deploys
 * to Render, whose filesystem is ephemeral, so a document that only ever
 * lives in an in-memory Buffer or a local file is lost the moment the
 * process restarts (and BSE's own "AttachLive" URLs go stale/404 within
 * days regardless, as observed on INFY re-fetch attempts this session).
 *
 * Prefers a private S3 bucket when the project has one configured
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_S3_BUCKET, plus
 * @aws-sdk/client-s3 actually installed); falls back to MongoDB GridFS
 * otherwise, since a MongoDB connection is already a hard dependency of this
 * project and the `mongodb` driver's GridFS support ships inside the
 * `mongoose` dependency already installed -- no new package required to get
 * real durability today. The S3 code path is real (not a stub) and takes
 * over automatically the moment both the env vars and the package are
 * present; until then, GridFS is not a "fallback stub", it is the actual
 * storage backend in use.
 */
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

export const isS3Configured = () => Boolean(
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET,
);

let s3ModulePromise = null;
const loadS3Module = async () => {
  if (!isS3Configured()) return null;
  if (!s3ModulePromise) {
    s3ModulePromise = import('@aws-sdk/client-s3').catch((error) => {
      logger.warn(`[DocumentStorageService] S3 is configured via env vars but @aws-sdk/client-s3 is not installed -- falling back to GridFS. (${error.message})`);
      return null;
    });
  }
  return s3ModulePromise;
};

let s3ClientPromise = null;
const getS3Client = async () => {
  const s3Module = await loadS3Module();
  if (!s3Module) return null;
  if (!s3ClientPromise) {
    const { S3Client } = s3Module;
    s3ClientPromise = Promise.resolve(new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' }));
  }
  return s3ClientPromise;
};

let gridFsBucket = null;
export const getGridFsBucket = () => {
  if (!gridFsBucket) {
    if (mongoose.connection.readyState !== 1) throw new Error('MongoDB connection is not ready -- GridFS requires an active connection.');
    gridFsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'exchangeFilings' });
  }
  return gridFsBucket;
};
/** Test-only: forces a fresh GridFSBucket on the next call (e.g. after a test reconnects mongoose). */
export const resetGridFsBucketForTests = () => { gridFsBucket = null; };

export const hashBuffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * saveDocument - durably persists `buffer` exactly once. Content-addressed
 * by documentHash so re-saving the same bytes for a different URL (BSE
 * sometimes re-publishes the identical PDF under two announcement ids) never
 * duplicates storage. Returns { storageKey, storageBackend, documentHash }.
 *
 * EARNINGS_PERSIST_PDFS=false skips the copy entirely (storageKey and
 * storageBackend come back null; the hash is still returned). Callers already
 * treat a missing durable copy as "re-fetch from the exchange later". It
 * exists for bulk runs where GridFS would fill the database (a filing PDF is
 * roughly 0.9 MB); the default is unchanged.
 */
export const isPdfPersistenceEnabled = () => String(process.env.EARNINGS_PERSIST_PDFS ?? 'true').trim().toLowerCase() !== 'false';

export const saveDocument = async (buffer, { symbol, url } = {}) => {
  const documentHash = hashBuffer(buffer);
  if (!isPdfPersistenceEnabled()) return { storageKey: null, storageBackend: null, documentHash };

  const s3 = await getS3Client();
  if (s3) {
    const s3Module = await loadS3Module();
    const key = `exchange-filings/${symbol}/${documentHash}.pdf`;
    try {
      const head = await s3.send(new s3Module.HeadObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: key })).catch(() => null);
      if (!head) {
        await s3.send(new s3Module.PutObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET, Key: key, Body: buffer, ContentType: 'application/pdf',
        }));
      }
      return { storageKey: key, storageBackend: 'S3', documentHash };
    } catch (error) {
      logger.warn(`[DocumentStorageService] S3 upload failed for ${symbol} ${url}, falling back to GridFS: ${error.message}`);
    }
  }

  const bucket = getGridFsBucket();
  const existing = await bucket.find({ filename: documentHash }).limit(1).toArray();
  if (existing.length) return { storageKey: documentHash, storageBackend: 'GRIDFS', documentHash };

  await new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(documentHash, { metadata: { symbol, url } });
    uploadStream.on('error', reject);
    uploadStream.on('finish', resolve);
    uploadStream.end(buffer);
  });
  return { storageKey: documentHash, storageBackend: 'GRIDFS', documentHash };
};

/**
 * loadDocument - retrieves previously-saved document bytes. Never throws;
 * returns null so a caller can fall back to a source re-fetch when the
 * durable copy can't be resolved (e.g. GridFS bucket dropped, S3 key
 * deleted out of band).
 */
export const loadDocument = async (storageKey, storageBackend) => {
  if (!storageKey || !storageBackend) return null;
  try {
    if (storageBackend === 'S3') {
      const s3 = await getS3Client();
      if (!s3) return null;
      const s3Module = await loadS3Module();
      const response = await s3.send(new s3Module.GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: storageKey }));
      const chunks = [];
      for await (const chunk of response.Body) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
    if (storageBackend === 'GRIDFS') {
      const bucket = getGridFsBucket();
      const chunks = [];
      const downloadStream = bucket.openDownloadStreamByName(storageKey);
      return await new Promise((resolve, reject) => {
        downloadStream.on('data', (chunk) => chunks.push(chunk));
        downloadStream.on('error', reject);
        downloadStream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    }
    return null;
  } catch (error) {
    logger.warn(`[DocumentStorageService] Failed to load ${storageBackend}:${storageKey}: ${error.message}`);
    return null;
  }
};

export default {
  isS3Configured, saveDocument, loadDocument, hashBuffer, getGridFsBucket, resetGridFsBucketForTests,
};
