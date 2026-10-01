import { randomUUID } from 'crypto';
import z from 'zod';
import { decryptString, encryptString } from '../../utils/index.js';
import { QbittorrentCredentialSchema } from './client.js';

/** How long a stream reference stays resolvable after a resolve. */
export const STREAM_REF_TTL_SECONDS = 12 * 60 * 60;


export interface QbittorrentStreamRefEntry {
  credential: z.infer<typeof QbittorrentCredentialSchema>;

  hash: string;

  fileIndex: number;

  filePath: string;

  fileSize: number;

  filename: string;

  addedAt: number;
}

/** In-process ref store, a restart expires all links. */
const streamRefs = new Map<
  string,
  { entry: QbittorrentStreamRefEntry; expiresAt: number }
>();
const MAX_STREAM_REFS = 10_000;
const refSweeper = setInterval(() => {
  const now = Date.now();
  for (const [ref, entry] of streamRefs) {
    if (entry.expiresAt <= now) streamRefs.delete(ref);
  }
}, 60_000);
refSweeper.unref();

/** Register a stream entry behind a fresh opaque ref. */
export function registerStreamRef(
  entry: QbittorrentStreamRefEntry
): string {
  const ref = randomUUID();
  if (streamRefs.size >= MAX_STREAM_REFS) {
    const oldest = streamRefs.keys().next().value;
    if (oldest !== undefined) streamRefs.delete(oldest);
  }
  streamRefs.set(ref, {
    entry,
    expiresAt: Date.now() + STREAM_REF_TTL_SECONDS * 1000,
  });
  return ref;
}

/** Look up a ref, undefined means expired. */
export function resolveStreamRef(
  ref: string
): QbittorrentStreamRefEntry | undefined {
  const stored = streamRefs.get(ref);
  if (!stored || stored.expiresAt <= Date.now()) {
    if (stored) streamRefs.delete(ref);
    return undefined;
  }
  return stored.entry;
}

/** How long a file stays live after its last consumer touch. */
export const LIVE_FILE_TTL_MS = 15 * 60_000;

const MAX_LIVE_TORRENTS = 512;

/** hash -> fileIndex -> expiry (epoch ms) of the last touch. */
const liveFiles = new Map<string, Map<number, number>>();

function pruneLiveFiles(now: number): void {
  for (const [hash, perTorrent] of liveFiles) {
    for (const [fileIndex, expiresAt] of perTorrent) {
      if (expiresAt <= now) perTorrent.delete(fileIndex);
    }
    if (perTorrent.size === 0) liveFiles.delete(hash);
  }
}


let lastLivePrune = 0;

function liveKey(
  credential: z.infer<typeof QbittorrentCredentialSchema>,
  hash: string
): string {

  const url = credential.url.replace(/\/+$/, '');
  return `${url}|${credential.username}|${hash}`;
}

export function markFileLive(
  credential: z.infer<typeof QbittorrentCredentialSchema>,
  hash: string,
  fileIndex: number,
  ttlMs: number = LIVE_FILE_TTL_MS
): void {
  const now = Date.now();

  if (now - lastLivePrune >= 1_000) {
    lastLivePrune = now;
    pruneLiveFiles(now);
  }
  const key = liveKey(credential, hash);
  let perTorrent = liveFiles.get(key);
  if (!perTorrent) {
    if (liveFiles.size >= MAX_LIVE_TORRENTS) {
      liveFiles.delete(liveFiles.keys().next().value as string);
    }
    perTorrent = new Map();
    liveFiles.set(key, perTorrent);
  }
  perTorrent.set(fileIndex, now + ttlMs);
}

/** The torrent's currently-live file indices (expired touches pruned). */
export function liveFileIndices(
  credential: z.infer<typeof QbittorrentCredentialSchema>,
  hash: string
): Set<number> {
  const key = liveKey(credential, hash);
  const perTorrent = liveFiles.get(key);
  if (!perTorrent) return new Set();
  const now = Date.now();
  for (const [fileIndex, expiresAt] of perTorrent) {
    if (expiresAt <= now) perTorrent.delete(fileIndex);
  }
  if (perTorrent.size === 0) liveFiles.delete(key);
  return new Set(perTorrent.keys());
}

/** Opaque token for byte URLs, carries only a ref id and expiry. */
export const QbittorrentStreamTokenSchema = z.object({
  ref: z.string().min(1),

  exp: z.number().int().positive(),
});

export type QbittorrentStreamToken = z.infer<
  typeof QbittorrentStreamTokenSchema
>;

/** Encrypt a stream token for a URL. */
export function encodeQbittorrentStreamToken(
  token: QbittorrentStreamToken
): string {
  const enc = encryptString(JSON.stringify(token));
  if (!enc.success) {
    throw new Error('failed to encrypt qbittorrent stream token');
  }
  return enc.data;
}

/** Decrypt a stream token, undefined on failure. */
export function decodeQbittorrentStreamToken(
  token: string
): QbittorrentStreamToken | undefined {
  const dec = decryptString(token);
  if (!dec.success || dec.data == null) return undefined;
  try {
    return QbittorrentStreamTokenSchema.parse(JSON.parse(dec.data));
  } catch {
    return undefined;
  }
}
