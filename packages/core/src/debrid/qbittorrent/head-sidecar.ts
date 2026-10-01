import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../utils/index.js';
import { validQbittorrentRoots } from './roots.js';

const logger = createLogger('debrid:qbittorrent');

/**
 * How long a finished sidecar is kept after its last use, once playback
 * moves past the opening bytes it is dead weight.
 */
const SIDECAR_IDLE_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;

/** The head fetcher command, overridable for another interpreter or tests. */
const FETCHER_COMMAND = process.env.QBITTORRENT_HEAD_FETCHER || 'python3';

let fetcherProbe: Promise<boolean> | undefined;

/**
 * Whether the head fetcher can run here, probed once so a missing
 * python3/libtorrent quietly disables the accelerator instead of burning
 * a spawn on every resolve.
 */
export function headFetcherAvailable(): Promise<boolean> {
  fetcherProbe ??= new Promise((resolve) => {
    const child = spawn(FETCHER_COMMAND, ['-c', 'import libtorrent'], {
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
  return fetcherProbe;
}

export interface HeadSidecar {
  /** Torrent infohash the bytes belong to. */
  hash: string;
  /** File index within the torrent the verified bytes belong to. */
  fileIndex: number;
  /** Directory owned by this module (the fetcher's save path). */
  dir: string;
  /** Absolute path of the selected file inside `dir`. */
  file: string;
  /** Verified playable extent `[0, bytes)` of the selected file. */
  bytes: number;
  /** Full size of the file the extents describe (a mismatched size means
   * the indices disagree and the entry must not be used). */
  fileSize: number;
  /**
   * Verified extent of the file's END, Matroska players read the seek
   * index there before the first frame.
   */
  tailBytes: number;
  child: ChildProcess;
  lastUsedAt: number;
  expiresAfterMs: number;
}

/**
 * Registered by resolve, consumed by the stream opener, reaped by the
 * sweeper. Keyed by hash AND file index, one episode's fetch must not
 * replace another's live overlay.
 */
const sidecars = new Map<string, HeadSidecar>();

function sidecarKey(hash: string, fileIndex: number): string {
  return `${hash}:${fileIndex}`;
}

const inflightHeadFetches = new Map<string, Promise<unknown>>();

/** One head fetch per torrent+file at a time, the rest await the running one. */
export function singleflightHeadFetch<T>(
  key: string,
  fetch: () => Promise<T>
): Promise<T> {
  const existing = inflightHeadFetches.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fetch().finally(() => {
    inflightHeadFetches.delete(key);
  });
  inflightHeadFetches.set(key, promise);
  return promise;
}

let sweeper: ReturnType<typeof setInterval> | undefined;

function ensureSweeper(): void {
  sweeper ??= setInterval(sweepHeadSidecars, SWEEP_INTERVAL_MS);
  // The sweeper must not hold the process open (tests, CLI scripts).
  sweeper.unref?.();
}

/** Reap sidecars idle past their TTL, exported for tests. */
export function sweepHeadSidecars(): void {
  const now = Date.now();
  for (const [key, sidecar] of sidecars) {
    if (now - sidecar.lastUsedAt >= sidecar.expiresAfterMs) {
      sidecars.delete(key);
      reapSidecar(sidecar, 'idle');
    }
  }
}

/** rm that never throws: these run inside event handlers. */
function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Age-based pruning picks it up later.
  }
}

function reapSidecar(sidecar: HeadSidecar, reason: string): void {
  logger.debug({ hash: sidecar.hash, reason }, 'reaping head sidecar');
  sidecar.child.kill('SIGTERM');
  // The fetcher exits on SIGTERM but the directory removal is owned here,
  // SIGKILL a wedged child after a beat so verified bytes cannot leak.
  const killer = setTimeout(() => sidecar.child.kill('SIGKILL'), 5_000);
  killer.unref?.();
  const cleanup = () => {
    clearTimeout(killer);
    removeDir(sidecar.dir);
  };
  // A child that already exited never fires 'exit' again.
  if (sidecar.child.exitCode !== null || sidecar.child.signalCode !== null) {
    cleanup();
  } else {
    sidecar.child.once('exit', cleanup);
  }
}

export function registerHeadSidecar(params: {
  hash: string;
  fileIndex: number;
  file: string;
  bytes: number;
  fileSize: number;
  tailBytes?: number;
  child: ChildProcess;
  ttlMs?: number;
}): HeadSidecar {
  const key = sidecarKey(params.hash, params.fileIndex);
  const existing = sidecars.get(key);
  if (existing) {
    sidecars.delete(key);
    reapSidecar(existing, 'replaced');
  }
  const sidecar: HeadSidecar = {
    hash: params.hash,
    fileIndex: params.fileIndex,
    dir: dirOf(params.file),
    file: params.file,
    bytes: params.bytes,
    fileSize: params.fileSize,
    tailBytes: params.tailBytes ?? 0,
    child: params.child,
    lastUsedAt: Date.now(),
    expiresAfterMs: params.ttlMs ?? SIDECAR_IDLE_MS,
  };
  sidecars.set(key, sidecar);
  ensureSweeper();
  // A fetcher that dies on its own must not leave a stale entry, the
  // opener falls back to qBittorrent's copy either way.
  params.child.once('exit', () => {
    const current = sidecars.get(key);
    if (current === sidecar) sidecars.delete(key);
    removeDir(sidecar.dir);
  });
  return sidecar;
}

function dirOf(file: string): string {
  const separator = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return separator > 0 ? file.slice(0, separator) : file;
}

/**
 * The sidecar for a torrent's file, if alive. The fileSize guard rejects
 * entries whose file table disagreed (pad-file skew would serve another
 * file's bytes).
 */
export function getHeadSidecar(
  hash: string,
  fileIndex: number,
  fileSize: number
): HeadSidecar | undefined {
  const sidecar = sidecars.get(sidecarKey(hash, fileIndex));
  if (!sidecar) return undefined;
  if (sidecar.fileSize !== fileSize) return undefined;
  sidecar.lastUsedAt = Date.now();
  // Refresh the mtime too, age-based pruning must not remove the directory
  // of a sidecar kept alive by playback for over an hour.
  try {
    const now = new Date();
    utimesSync(sidecar.dir, now, now);
  } catch {
    // Best effort.
  }
  return sidecar;
}

/** Set once a sidecar directory cannot be created, disables the accelerator. */
let sidecarRootBroken = false;

/**
 * A save directory inside the first download root, so the overlay is
 * confined like any other served path. Returns undefined (once and for
 * all) when the root is not writable, a read-only mount must degrade to
 * the plain download wait. Stale siblings older than an hour are pruned
 * on the way in.
 */
export function headSidecarDir(hash: string): string | undefined {
  if (sidecarRootBroken) return undefined;
  const stamp = `${hash}-${Date.now().toString(36)}`;
  const base = join(validQbittorrentRoots()[0], '.aiostreams-head');
  try {
    mkdirSync(base, { recursive: true });
    const live = new Set([...sidecars.values()].map((s) => s.dir));
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      if (live.has(dir)) continue;
      if (Date.now() - statSync(dir).mtimeMs > 3_600_000) {
        removeDir(dir);
      }
    }
    const dir = join(base, stamp);
    mkdirSync(dir);
    return dir;
  } catch (error) {
    sidecarRootBroken = true;
    logger.warn(
      { err: error, base },
      'cannot create head sidecar directories; disabling the accelerator'
    );
    return undefined;
  }
}
