import { Torrent, UnprocessedTorrent, DebridFile } from '../debrid/index.js';
import {
  extractInfoHashFromMagnet,
  validateInfoHash,
  extractTrackersFromMagnet,
} from '../builtins/utils/debrid.js';
import { createLogger } from '../logging/logger.js';
import { GrabCache } from './grab-cache.js';
import { makeRequest, makeUrlLogSafe } from './http.js';
import parseTorrent, { Instance } from 'parse-torrent';
import { config as appConfig } from '../config/index.js';
import { getTimeTakenSincePoint } from './index.js';
import pLimit from 'p-limit';

const logger = createLogger('torrent');

// Recently failed grabs, keyed like the cache. A dead or rate-limited
// download URL must not be re-fetched on every click and failover attempt.
const failedGrabs = new Map<string, number>();
const FAILED_GRAB_TTL_MS = 60_000;

// Small per-host concurrency cap for .torrent grabs, separate from the
// shared background fetch limiter so a resolve never queues behind it.
const hostGrabLimits = new Map<string, ReturnType<typeof pLimit>>();
const HOST_GRAB_CONCURRENCY = 2;

function hostGrabLimit(url: string): ReturnType<typeof pLimit> {
  const host = new URL(url).host;
  let limit = hostGrabLimits.get(host);
  if (!limit) {
    limit = pLimit(HOST_GRAB_CONCURRENCY);
    hostGrabLimits.set(host, limit);
  }
  return limit;
}

interface TorrentMetadata {
  hash: string;
  files: DebridFile[];
  sources: string[];
  private?: boolean;
  /** The raw .torrent bytes (base64), when the grab downloaded the file
   * itself. Lets callers hand qBittorrent the bytes instead of having it
   * fetch the passkey'd URL a second time. */
  torrentB64?: string;
}

/**
 * Grabs torrent metadata (info hash + file list) from a download URL, on the
 * shared {@link GrabCache} primitive — the torrent counterpart of the NZB
 * grabbing in {@link DownloadManager}. Both single-flight + disk-cache by URL;
 * the difference is that torrents are parsed at grab time here (magnet-redirect
 * handling, `parse-torrent`), whereas NZB bodies are parsed later by the usenet
 * engine. This module stays out of the `utils` barrel because that torrent
 * parsing pulls in `debrid`/`builtins` helpers.
 */
export class TorrentGrabber {
  // Grabbed-torrent metadata cache (shares the `<data>/cache` root + dashboard
  // cache page with the NZB grabber). Built lazily so class-init doesn't read config.
  static #cacheImpl: GrabCache<TorrentMetadata> | null = null;
  static get #cache(): GrabCache<TorrentMetadata> {
    if (!this.#cacheImpl) {
      const g = appConfig.builtins.grab;
      this.#cacheImpl = new GrabCache<TorrentMetadata>({
        name: 'grab-torrent',
        maxMemBytes: g.torrentCacheBytes,
        maxDiskBytes: g.torrentDiskCacheBytes,
        serialize: (v) => Buffer.from(JSON.stringify(v), 'utf8'),
        deserialize: (b) => JSON.parse(b.toString('utf8')) as TorrentMetadata,
        sizeOf: (v) => Buffer.byteLength(JSON.stringify(v), 'utf8'),
      });
    }
    return this.#cacheImpl;
  }

  // Limit concurrent requests. Constructed lazily on first use so the
  // module-load class-init doesn't read runtime config.
  static #fetchLimitImpl: ReturnType<typeof pLimit> | null = null;
  static get #fetchLimit(): ReturnType<typeof pLimit> {
    if (!this.#fetchLimitImpl) {
      this.#fetchLimitImpl = pLimit(appConfig.builtins.getTorrent.concurrency);
    }
    return this.#fetchLimitImpl;
  }

  private constructor() {}

  static async getMetadata(
    torrent: UnprocessedTorrent
  ): Promise<TorrentMetadata | undefined> {
    // If we have hash and don't need full metadata, return early
    if (torrent.hash) {
      return {
        hash: torrent.hash,
        files: [], // Empty files array since we don't need metadata
        sources: torrent.sources || [],
      };
    }

    // If we don't have a download URL, we can't proceed
    if (!torrent.downloadUrl) {
      logger.debug(
        `No download URL available for torrent with hash ${torrent.hash}`
      );
      return undefined;
    }

    const cache = this.#cache;
    const url = torrent.downloadUrl;
    const key =
      torrent.guid && torrent.indexer
        ? `${torrent.indexer}:${torrent.guid}`
        : url;
    const lazy = appConfig.builtins.getTorrent.lazily;

    // Cache hit — done.
    const cached = await cache.cached(key);
    if (cached) return cached;

    // Already fetching this URL: lazy callers bail, eager callers join.
    const inFlight = cache.inFlight(key);
    if (inFlight) return lazy ? undefined : inFlight.catch(() => undefined);

    // Kick off a single-flighted, concurrency-limited grab+parse.
    const fetchPromise = cache.fetch(key, () =>
      this.#fetchLimit(() => this.#fetchMetadata(torrent))
    );

    if (lazy) {
      // Queue the fetch but don't wait for it.
      fetchPromise.catch(() => {});
      return undefined;
    }

    try {
      return await fetchPromise;
    } catch (error: any) {
      logger.warn(
        `Failed to fetch metadata for ${makeUrlLogSafe(url)}: ${error.message}`
      );
      if (torrent.hash) {
        // If we have a hash but metadata fetch failed, return basic info
        return {
          hash: torrent.hash,
          files: [],
          sources: torrent.sources || [],
        };
      }
      return undefined;
    }
  }

  /**
   * Eager variant for resolve time: waits for the (single-flighted) fetch
   * instead of returning undefined on a cold lazy cache. Deliberately NOT
   * run through the shared fetch limiter, a resolve must not queue behind
   * the background search-time warm grabs. `timeoutMs` bounds the grab to
   * the caller's remaining budget.
   */
  static async getMetadataEager(
    torrent: UnprocessedTorrent,
    timeoutMs?: number
  ): Promise<TorrentMetadata | undefined> {
    const url = torrent.downloadUrl;
    if (!url) return undefined;
    const key =
      torrent.guid && torrent.indexer
        ? `${torrent.indexer}:${torrent.guid}`
        : url;
    const blockedUntil = failedGrabs.get(key);
    if (blockedUntil !== undefined && blockedUntil > Date.now()) {
      logger.debug(
        `Skipping metadata fetch for ${makeUrlLogSafe(url)}, it failed recently`
      );
      return undefined;
    }
    try {
      return await this.#cache.fetch(key, () =>
        this.#fetchMetadata(torrent, 0, timeoutMs)
      );
    } catch (error: any) {
      logger.warn(
        `Failed to fetch metadata for ${makeUrlLogSafe(url)}: ${error.message}`
      );
      failedGrabs.set(key, Date.now() + FAILED_GRAB_TTL_MS);
      if (failedGrabs.size > 500) {
        const now = Date.now();
        for (const [k, until] of failedGrabs) {
          if (until <= now) failedGrabs.delete(k);
        }
      }
      return undefined;
    }
  }

  static async #fetchMetadata(
    torrent: UnprocessedTorrent,
    redirectCount: number = 0,
    timeoutMs?: number
  ): Promise<TorrentMetadata> {
    const { downloadUrl } = torrent;
    if (!downloadUrl) throw new Error('Download URL must be provided.');

    const configuredTimeout = appConfig.builtins.getTorrent.lazily
      ? 30000
      : appConfig.builtins.getTorrent.timeout;
    const timeout =
      timeoutMs !== undefined
        ? Math.min(timeoutMs, configuredTimeout)
        : configuredTimeout;
    const start = Date.now();

    const response = await hostGrabLimit(downloadUrl)(() =>
      makeRequest(downloadUrl, {
        timeout,
        // User-agent comes from a `[torrent_grabs]` (or per-host) entry in
        // REQUEST_HEADER_OVERRIDES, applied inside makeRequest.
        context: 'torrent_grabs',
        rawOptions: { redirect: 'manual' },
      })
    );

    let metadata: TorrentMetadata;

    if (response.status >= 300 && response.status < 400) {
      const redirectUrl = response.headers.get('Location');
      if (!redirectUrl) throw new Error('Redirect location not found');

      const hash = validateInfoHash(
        extractInfoHashFromMagnet(redirectUrl.toLowerCase())
      );
      if (!hash) {
        if (redirectCount >= 3) {
          throw new Error(`Too many redirects: ${makeUrlLogSafe(redirectUrl)}`);
        }
        // Follow the redirect target, some indexers answer with the
        // tracker's own .torrent URL instead of the file.
        const nextUrl = new URL(redirectUrl, downloadUrl).toString();
        logger.debug(
          `Following torrent download redirect to ${makeUrlLogSafe(nextUrl)}`
        );
        return this.#fetchMetadata(
          { ...torrent, downloadUrl: nextUrl },
          redirectCount + 1,
          timeoutMs
        );
      }

      const sources = extractTrackersFromMagnet(redirectUrl);
      logger.debug(
        `Got info for ${makeUrlLogSafe(downloadUrl)} from magnet redirect in ${getTimeTakenSincePoint(start)}`,
        {
          hash,
        }
      );
      metadata = { hash, files: [], sources };
    } else if (response.ok) {
      const bytes = await response.arrayBuffer();

      const parsedTorrent = await (parseTorrent(
        new Uint8Array(bytes)
      ) as unknown as Promise<Instance>);

      const sources = Array.from(
        new Set([...(parsedTorrent.announce || []), ...(torrent.sources || [])])
      );

      if (!validateInfoHash(parsedTorrent.infoHash)) {
        logger.debug(
          `No info hash found in torrent: ${JSON.stringify(parsedTorrent)}`
        );
        metadata = { hash: downloadUrl, files: [], sources, private: false };
        throw new Error('No info hash found in torrent');
      }

      logger.debug(
        `Got info for ${makeUrlLogSafe(downloadUrl)} from downloaded torrent in ${getTimeTakenSincePoint(start)}`,
        {
          hash: parsedTorrent.infoHash,
        }
      );
      metadata = {
        hash: parsedTorrent.infoHash,
        files: ('files' in parsedTorrent ? parsedTorrent.files || [] : []).map(
          (file, index) => ({
            size: file.length,
            id: index,
            name: file.name,
          })
        ),
        sources,
        private: !!parsedTorrent.info?.private,
        torrentB64: Buffer.from(bytes).toString('base64'),
      };
    } else {
      throw new Error(
        `Failed to fetch metadata: ${response.status} ${response.statusText}`
      );
    }

    // Caching is handled by the GrabCache wrapper on success.
    return metadata;
  }
}
