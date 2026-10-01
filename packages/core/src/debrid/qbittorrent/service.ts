import { open } from 'fs/promises';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DebridDownload,
  DebridError,
  DebridFailureCache,
  DebridServiceConfig,
  PlaybackInfo,
  TorrentDebridService,
  TorrentInfo,
} from '../base.js';
import {
  Torrent,
  parseFileNames,
  selectFileInTorrentOrNZB,
  selectableFileNames,
} from '../utils.js';
import {
  appConfig,
  ServiceId,
  constants,
  createLogger,
  makeUrlLogSafe,
} from '../../utils/index.js';
import {
  FILE_PRIORITY,
  qbError,
  QBITTORRENT_TAG,
  isOwnTorrent,
  QBittorrentClient,
  QbittorrentCredential,
  QbittorrentTorrent,
  parseQbittorrentCredential,
} from './client.js';
import {
  STREAM_THRESHOLD_BYTES,
  applyPathMappings,
  diskContiguousBytes,
  computeFileAvailability,
  deriveFilePath,
  openRegularFile,
  planFilePriorities,
  resolveAllowedPath,
} from './availability.js';
import {
  getHeadSidecar,
  headFetcherAvailable,
  headSidecarDir,
  registerHeadSidecar,
  singleflightHeadFetch,
} from './head-sidecar.js';
import {
  STREAM_REF_TTL_SECONDS,
  encodeQbittorrentStreamToken,
  liveFileIndices,
  markFileLive,
  registerStreamRef,
} from './tokens.js';

const logger = createLogger('debrid:qbittorrent');

const FAILED_STATES = new Set(['error', 'missingFiles']);
/** Paused/stopped across both qBittorrent generations (4.x paused*, 5.x stopped*). */
const STOPPED_STATES = new Set([
  'pausedDL',
  'pausedUP',
  'stoppedDL',
  'stoppedUP',
]);
const SEEDED_STATES = new Set([
  'uploading',
  'pausedUP',
  'stoppedUP',
  'queuedUP',
  'stalledUP',
  'forcedUP',
  'checkingUP',
]);

const MAGNET_HASH = /urn:btih:([a-f0-9]{40})/i;

function hashFromMagnet(magnet: string): string | undefined {
  return MAGNET_HASH.exec(magnet)?.[1]?.toLowerCase();
}

function buildMagnet(
  playbackInfo: PlaybackInfo & { type: 'torrent' },
  hash: string
): string {
  let magnet = `magnet:?xt=urn:btih:${hash}`;

  const displayName = playbackInfo.filename ?? playbackInfo.title;
  if (displayName) {
    magnet += `&dn=${encodeURIComponent(displayName)}`;
  }
  if (playbackInfo.sources.length > 0) {
    magnet += `&tr=${playbackInfo.sources
      .map((source) => encodeURIComponent(source))
      .join('&tr=')}`;
  }
  return magnet;
}

function downloadStatus(torrent: QbittorrentTorrent): DebridDownload['status'] {
  if (FAILED_STATES.has(torrent.state)) return 'failed';
  if (SEEDED_STATES.has(torrent.state) || torrent.progress >= 1) return 'downloaded';
  return 'downloading';
}

/** The one torrent-to-download mapping every list/get/check shares. */
function toDownload(
  torrent: QbittorrentTorrent,
  status: DebridDownload['status']
): DebridDownload {
  return {
    id: torrent.hash,
    hash: torrent.hash,
    name: torrent.name,
    size: torrent.size ?? 0,
    addedAt: new Date(torrent.added_on * 1000).toISOString(),
    status,
    library: true,
  };
}

/** Resolves torrents through the user's own qBittorrent client. */
export class QBittorrentService implements TorrentDebridService {
  readonly serviceName: ServiceId = constants.QBITTORRENT_SERVICE;
  readonly capabilities = { torrents: true, usenet: false } as const;

  private readonly credential: QbittorrentCredential;
  private readonly client: QBittorrentClient;

  constructor(
    config: DebridServiceConfig,
    private readonly options: { pollInterval: number; maxWaitTime: number }
  ) {
    this.credential = parseQbittorrentCredential(config.token);
    this.client = new QBittorrentClient(this.credential);
  }

  async checkMagnets(
    magnets: string[],
    _sid?: string,
    _checkOwned?: boolean
  ): Promise<DebridDownload[]> {
    const hashes = magnets
      .map((magnet) => hashFromMagnet(magnet))
      .filter((hash): hash is string => hash !== undefined);
    const torrents = await this.client.getTorrents(hashes);
    const byHash = new Map(torrents.map((torrent) => [torrent.hash, torrent]));

    const result: DebridDownload[] = [];
    const foundWithFiles: { download: DebridDownload; hash: string }[] = [];
    for (const magnet of magnets) {
      const hash = hashFromMagnet(magnet);
      const torrent = hash ? byHash.get(hash) : undefined;
      if (!torrent) {
        result.push({ id: magnet, hash, status: 'unknown', library: false });
        continue;
      }
      const failed = FAILED_STATES.has(torrent.state);
      const complete =
        SEEDED_STATES.has(torrent.state) || torrent.progress >= 1;

      const download: DebridDownload = toDownload(
        torrent,
        failed ? 'failed' : complete ? 'cached' : 'downloading'
      );
      result.push(download);
      if (!failed && foundWithFiles.length < 25) {
        foundWithFiles.push({ download, hash: torrent.hash });
      }
    }

    // File lists for pre-selection, capped and failure-tolerant.
    await Promise.all(
      foundWithFiles.map(async ({ download, hash }) => {
        try {
          const files = await this.client.getFiles(hash);
          download.files = files.map((file) => ({
            id: file.index,
            name: file.name,
            size: file.size,
            index: file.index,
          }));
        } catch (error) {
          logger.debug(
            { hash, err: error },
            'could not list files for checkMagnets entry'
          );
        }
      })
    );
    return result;
  }

  async listMagnets(): Promise<DebridDownload[]> {
    const torrents = await this.client.getTaggedTorrents();
    return torrents.map((torrent) =>
      toDownload(torrent, downloadStatus(torrent))
    );
  }

  async addMagnet(magnet: string): Promise<DebridDownload> {
    const hash = hashFromMagnet(magnet);
    await this.client.addTorrentUrl(magnet);
    return { id: hash ?? magnet, hash, status: 'downloading' };
  }

  async addTorrent(torrent: string): Promise<DebridDownload> {
    // A .torrent URL's infohash is only known once qBittorrent has fetched
    // it, resolve re-discovers the torrent by hash on its next poll.
    await this.client.addTorrentUrl(torrent);
    return { id: torrent, status: 'downloading' };
  }

  async getMagnet(magnetId: string): Promise<DebridDownload> {
    const torrent = await this.client.getTorrent(magnetId);
    if (!torrent) {
      throw new DebridError(`No qBittorrent torrent with hash ${magnetId}`, {
        statusCode: 404,
        statusText: 'Not Found',
        code: 'NOT_FOUND',
        type: 'api_error',
        headers: {},
      });
    }
    const files = await this.client.getFiles(magnetId);
    return {
      ...toDownload(torrent, downloadStatus(torrent)),
      files: files.map((file) => ({
        id: file.index,
        name: file.name,
        size: file.size,
        index: file.index,
      })),
    };
  }

  async generateTorrentLink(link: string): Promise<string> {
    // Links minted by resolve are already this instance's byte URLs, there is
    // nothing to regenerate.
    return link;
  }

  async removeMagnet(): Promise<void> {
    // Never remove, the torrent must keep seeding.
    logger.debug(
      'removeMagnet ignored: qBittorrent torrents keep seeding by design'
    );
  }

  async refreshLibraryCache(): Promise<void> {}

  async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean,
    autoRemoveDownloads?: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (playbackInfo.type !== 'torrent') {
      throw qbError('BAD_REQUEST', 'qBittorrent can only resolve torrents');
    }
    if (autoRemoveDownloads) {
      logger.debug(
        'autoRemoveDownloads is ignored for qbittorrent; torrents keep seeding'
      );
    }
    return this.resolveTorrent(
      playbackInfo,
      filename,
      cacheAndPlay,
      signal
    );
  }

  private async resolveTorrent(
    playbackInfo: PlaybackInfo & { type: 'torrent' },
    filename: string,
    cacheAndPlay: boolean,
    signal?: AbortSignal
  ): Promise<string | undefined> {

    const hash = playbackInfo.hash.toLowerCase();
    // One wall-clock budget shared by both wait loops.
    const deadline = Date.now() + this.options.maxWaitTime;

    await DebridFailureCache.check(this.serviceName, 'torrent', hash);

    let freshAdd = false;
    let magnetFirstAttempted = false;
    let torrent =
      (playbackInfo.serviceItemId
        ? await this.client.getTorrent(playbackInfo.serviceItemId.toLowerCase())
        : undefined) ?? (await this.client.getTorrent(hash));

    if (
      !torrent &&
      cacheAndPlay &&
      // Magnet-first never touches private torrents, DHT-announcing a
      // private infohash breaks tracker rules and the metadata never arrives
      // without the passkey announce anyway. Anything with a downloadUrl
      // takes that branch below instead.
      playbackInfo.private !== true &&
      !(
        playbackInfo.downloadUrl &&
        appConfig.builtins.debrid.useTorrentDownloadUrl
      ) &&
      (await headFetcherAvailable())
    ) {
      // The sidecar fetcher resolves the metadata itself (the slowest part
      // of a cold play on weak swarms) and writes the .torrent back, so
      // qBittorrent starts with metadata and is never stopped.
      magnetFirstAttempted = true;
      const fetchedTorrent = await this.fetchHeadFromMagnet(
        playbackInfo,
        hash,
        deadline,
        signal
      );
      if (fetchedTorrent && (await this.client.addTorrentFile(fetchedTorrent, signal))) {
        torrent = await this.waitForTorrent(hash, signal, deadline);
        freshAdd = true;
      }
    }

    if (!torrent) {
      const addTorrent = async (url: string) => {
        try {
          await this.client.addTorrentUrl(url);
        } catch (error) {
          // 4.x answers a duplicate add with 200 "Fails."
          if (
            error instanceof DebridError &&
            error.code === 'STORE_MAGNET_INVALID' &&
            (await this.client.getTorrent(hash, signal))
          ) {
            return;
          }
          throw error;
        }
      };
      if (
        playbackInfo.private !== undefined &&
        playbackInfo.downloadUrl &&
        appConfig.builtins.debrid.useTorrentDownloadUrl
      ) {
        logger.debug(
          `Adding torrent from ${makeUrlLogSafe(playbackInfo.downloadUrl)}`
        );
        await addTorrent(playbackInfo.downloadUrl);
      } else {
        await addTorrent(buildMagnet(playbackInfo, hash));
      }

      if (!cacheAndPlay) return undefined;
      torrent = await this.waitForTorrent(hash, signal, deadline);
      freshAdd = true;
    }


    const readiness = await this.waitForReadable(
      torrent,
      playbackInfo,
      cacheAndPlay,
      signal,
      deadline,
      // A failed magnet-first attempt already spent its fetch budget, no
      // second fetcher on top.
      freshAdd && !magnetFirstAttempted
    );
    if (!readiness) return undefined;
    const { file, filePath } = readiness;

    // Players sniff the format from the url's last segment, use the real
    // file's base name (pack members report as relative paths).
    const displayName = file.name.split('/').pop() || filename || file.name;

    const token = encodeQbittorrentStreamToken({
      ref: registerStreamRef({
        credential: this.credential,
        hash: torrent.hash,
        fileIndex: file.index,
        filePath,
        fileSize: file.size,
        filename: displayName,
        addedAt: torrent.added_on,
      }),
      exp: Math.floor(Date.now() / 1000) + STREAM_REF_TTL_SECONDS,
    });


    return `${appConfig.bootstrap.baseUrl}/api/v1/qbittorrent/stream/${encodeURIComponent(
      token
    )}/${encodeURIComponent(displayName)}`;
  }

  private async waitForTorrent(
    hash: string,
    signal: AbortSignal | undefined,
    deadline: number
  ): Promise<QbittorrentTorrent> {
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      const torrent = await this.client.getTorrent(hash, signal);
      if (torrent) return torrent;
      await sleep(this.options.pollInterval, undefined, { signal }).catch(
        () => {}
      );
    }
    throw qbError('TIMEOUT', 'Timed out waiting for qBittorrent to accept the torrent');
  }

  /** Wait until the selected file has a playable prefix. */
  private async waitForReadable(
    torrent: QbittorrentTorrent,
    playbackInfo: PlaybackInfo & TorrentInfo,
    cacheAndPlay: boolean,
    signal: AbortSignal | undefined,
    deadline: number,
    fetchHead = false
  ): Promise<
    | {
        file: { index: number; name: string; size: number };
        filePath: string;
      }
    | undefined
  > {
    let dataReadyButNotOnDisk = 0;
    let priorityFailures = 0;
    let prioritiesAbandoned = false;
    let resumeAttempted = false;
    let headFetched = false;
    let torrentMisses = 0;
    let lastState = torrent.state;
    let attempt = 0;
    while (Date.now() < deadline) {
      this.throwIfAborted(signal);
      attempt++;

      const fetched = await this.client.getTorrent(torrent.hash, signal);
      if (!fetched) {
        // When the torrent vanishes mid-resolve, fail fast after 3 misses.
        torrentMisses++;
        if (torrentMisses >= 3) {
          throw new DebridError(
            'The torrent was removed from qBittorrent while waiting for it',
            {
              statusCode: 404,
              statusText: 'Not Found',
              code: 'NOT_FOUND',
              type: 'api_error',
              headers: {},
            }
          );
        }
      } else {
        torrentMisses = 0;
      }
      const current = fetched ?? torrent;
      lastState = current.state;
      if (FAILED_STATES.has(current.state)) {
        const err = new DebridError(`qBittorrent torrent is ${current.state}`, {
          statusCode: 400,
          statusText: `Torrent ${current.state}`,
          code: 'DOWNLOAD_FAILED',
          type: 'api_error',
          headers: {},
          body: current,
        });
        await DebridFailureCache.mark(this.serviceName, 'torrent', torrent.hash, err).catch(
          () => {}
        );
        throw err;
      }

      const files = await this.client.getFiles(torrent.hash, signal);
      const file = await this.selectFile(current, files, playbackInfo);
      if (file) {
        // Resume our own stopped torrents, adopted ones stay as the user left them.
        if (
          !resumeAttempted &&
          isOwnTorrent(current) &&
          STOPPED_STATES.has(current.state) &&
          (files.find((f) => f.index === file.index)?.progress ?? 0) < 1
        ) {
          resumeAttempted = true;
          const started = await this.client.startTorrent(current.hash, signal);
          if (!started) {
            logger.warn(
              { hash: current.hash, state: current.state },
              'could not resume stopped torrent for playback'
            );
          }
        }
        // Protect against concurrent skips mid-play.
        markFileLive(this.credential, torrent.hash, file.index);
        if (!prioritiesAbandoned) {
          const applied = await this.applyFilePriorities(
            current,
            files,
            file.index,
            signal
          );
          if (!applied) {
            priorityFailures++;
            if (priorityFailures >= 3) {
              prioritiesAbandoned = true;

              const stillSkipped =
                files.find((f) => f.index === file.index)?.priority ===
                FILE_PRIORITY.skip;
              if (stillSkipped) {
                throw new DebridError(
                  'qBittorrent refused to raise the skipped file selected for playback',
                  {
                    statusCode: 502,
                    statusText: 'Bad Gateway',
                    code: 'BAD_GATEWAY',
                    type: 'upstream_error',
                    headers: {},
                  }
                );
              }
              logger.warn(
                { hash: torrent.hash, fileIndex: file.index },
                'giving up on file priority adjustments for this resolve'
              );
            }
          }
        }
        const derived = deriveFilePath(current, files, file.index);
        const filePath = derived
          ? applyPathMappings(derived, this.credential.pathMappings)
          : undefined;
        if (filePath) {
          const allowed = (await resolveAllowedPath(filePath)).status;
          if (allowed === 'outside') {
            throw new DebridError(
              'qBittorrent reported a file path outside the configured download roots',
              {
                statusCode: 403,
                statusText: 'Forbidden',
                code: 'FORBIDDEN',
                type: 'api_error',
                headers: {},
              }
            );
          }
          if (allowed === 'invalid') {
            throw new DebridError(
              'qBittorrent reported a file path that is not a regular file',
              {
                statusCode: 403,
                statusText: 'Forbidden',
                code: 'FORBIDDEN',
                type: 'api_error',
                headers: {},
              }
            );
          }
          // A sidecar for this file makes the head playable regardless of
          // qBittorrent's own progress.
          const sidecar = getHeadSidecar(torrent.hash, file.index, file.size);
          if (
            sidecar &&
            sidecar.bytes >= Math.min(file.size, STREAM_THRESHOLD_BYTES)
          ) {
            return { file, filePath };
          }
          // Just pre-allocation lag, nothing flushed yet.
          const pieceSize = await this.client.getPieceSize(torrent.hash, signal);
          const pieceStates = await this.client.getPieceStates(torrent.hash, signal);
          const availability = computeFileAvailability({
            files,
            fileIndex: file.index,
            pieceStates,
            pieceSize,
          });
          const threshold = Math.min(file.size, STREAM_THRESHOLD_BYTES);
          let dataReady =
            availability.complete ||
            availability.contiguousFrom(0) >= threshold;
          // Piece states flip before flush, verify bytes are readable.
          const flushed = await this.hasFlushedHead(filePath, file.size);
          // The export-mode fetch announces the torrent from a second
          // peer, never do that for private torrents (whitelists and
          // double-announce rules punish exactly that).
          if (
            !dataReady &&
            !flushed &&
            fetchHead &&
            !headFetched &&
            playbackInfo.private !== true &&
            (await headFetcherAvailable())
          ) {
            headFetched = true;
            // One fetcher per torrent+file, two concurrent resolves of the
            // same pack must not race each other's qBittorrent stop/start.
            const fetched = await singleflightHeadFetch(
              `${torrent.hash}:${file.index}`,
              () => this.fetchHeadPieces(current, files, file.index, signal)
            );
            if (fetched) {
              // The sidecar serves the verified head directly, qBittorrent's
              // own copy follows in the background.
              return { file, filePath };
            }
          }
          if (!dataReady && flushed) {
            // pieceStates lags on busy clients, trust the bytes.
            dataReady =
              (await diskContiguousBytes(filePath, 0, threshold + 64 * 1024)) >=
              threshold;
          }
          if (dataReady && flushed) {
            return { file, filePath };
          }
          if (dataReady && !flushed) {

            dataReadyButNotOnDisk++;
            if (dataReadyButNotOnDisk >= 5) {
              throw new DebridError(
                'qBittorrent download directory is not reachable from AIOStreams; both must run on the same machine (or share the directory through a mount)',
                {
                  statusCode: 503,
                  statusText: 'Service Unavailable',
                  code: 'SERVICE_UNAVAILABLE',
                  type: 'api_error',
                  headers: {},
                }
              );
            }
          } else {
            dataReadyButNotOnDisk = 0;
          }
          logger.debug(
            {
              hash: torrent.hash,
              state: current.state,
              downloaded: Math.round(current.progress * current.size),
              contiguous: availability.contiguousFrom(0),
              threshold,
              flushed,
              attempt,
            },
            'qBittorrent file not yet readable'
          );
        }
      }

      if (!cacheAndPlay) return undefined;
      await sleep(this.options.pollInterval, undefined, { signal }).catch(
        () => {}
      );
    }

    if (STOPPED_STATES.has(lastState) && !isOwnTorrent(torrent)) {
      throw new DebridError(
        'The torrent is paused in your qBittorrent client; resume it to play it through AIOStreams',
        {
          statusCode: 408,
          statusText: 'Request Timeout',
          code: 'TIMEOUT',
          type: 'api_error',
          headers: {},
        }
      );
    }
    throw new DebridError(
      `Timed out waiting for the download to become playable (qBittorrent last reported "${lastState}")`,
      {
        statusCode: 408,
        statusText: 'Request Timeout',
        code: 'TIMEOUT',
        type: 'api_error',
        headers: {},
      }
    );
  }

  /**
   * Apply the file-priority plan. Only files whose current
   * priority differs are sent, so transient failures retry on the next poll.
   */
  private async applyFilePriorities(
    torrent: QbittorrentTorrent,
    files: Awaited<ReturnType<QBittorrentClient['getFiles']>>,
    selectedIndex: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const plan = planFilePriorities({
      files,
      selectedIndex,
      skipOthers: this.credential.skipOtherFiles === true,
      ownTorrent: isOwnTorrent(torrent),
      liveFiles: liveFileIndices(this.credential, torrent.hash),
    });
    const currentPriority = new Map(
      files.map((file) => [file.index, file.priority])
    );
    const targets: { ids: number[]; priority: number }[] = [];
    const skip = plan.skip.filter(
      (index) => currentPriority.get(index) !== FILE_PRIORITY.skip
    );
    if (skip.length > 0) targets.push({ ids: skip, priority: FILE_PRIORITY.skip });
    const raise = plan.raise.filter(
      (index) => currentPriority.get(index) !== FILE_PRIORITY.max
    );
    if (raise.length > 0) targets.push({ ids: raise, priority: FILE_PRIORITY.max });
    const restore = plan.restore.filter(
      (index) => currentPriority.get(index) === FILE_PRIORITY.skip
    );
    if (restore.length > 0)
      targets.push({ ids: restore, priority: FILE_PRIORITY.normal });
    const results = await Promise.all(
      targets.map((target) =>
        this.client.setFilePriority(
          torrent.hash,
          target.ids,
          target.priority,
          signal
        )
      )
    );
    return results.every((ok) => ok);
  }

  private async selectFile(
    torrent: { hash: string; name: string; size?: number },
    files: readonly { index: number; name: string; size: number }[],
    playbackInfo: PlaybackInfo & TorrentInfo
  ): Promise<{ index: number; name: string; size: number } | undefined> {
    if (playbackInfo.fileIndex !== undefined) {
      return files.find((file) => file.index === playbackInfo.fileIndex);
    }
    if (files.length === 0) return undefined;
    const torrentForSelection: Torrent = {
      title: torrent.name || playbackInfo.title || '',
      type: 'torrent',
      hash: torrent.hash,
      size: torrent.size ?? 0,
      sources: playbackInfo.sources,
      private: playbackInfo.private,
    };
    const debridDownload: DebridDownload = {
      id: torrent.hash,
      hash: torrent.hash,
      name: torrent.name,
      size: torrent.size ?? 0,
      status: 'downloading',
      // The title parser misreads "01v2" in folder-prefixed paths, so
      // selection sees base names and the index maps back to the real file.
      files: files.map((file) => ({
        id: file.index,
        name: file.name.split('/').pop() ?? file.name,
        size: file.size,
        index: file.index,
      })),
    };
    const parsedFiles = await parseFileNames(
      selectableFileNames(torrent.name ?? '', debridDownload.files ?? [])
    );
    const selected = await selectFileInTorrentOrNZB(
      torrentForSelection,
      debridDownload,
      parsedFiles,
      playbackInfo.metadata,
      {
        chosenFilename: playbackInfo.filename,
        chosenIndex: playbackInfo.index,
      }
    );
    if (selected?.index === undefined) return undefined;
    return files.find((file) => file.index === selected.index);
  }

  /**
   * Head fetch for a torrent qBittorrent does not have yet, the fetcher
   * resolves the metadata, we pick the file over stdin, and the .torrent it
   * writes back is added to qBittorrent with metadata in place. Returns
   * that path, or undefined to fall back to a plain magnet add.
   */
  private async fetchHeadFromMagnet(
    playbackInfo: PlaybackInfo & { type: 'torrent' },
    hash: string,
    deadline: number,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(hash)) return undefined;
    return singleflightHeadFetch(`magnet:${hash}`, async () => {
      const saveDir = headSidecarDir(hash);
      if (!saveDir) return undefined;
      const scriptPath =
        process.env.AIOSTREAMS_QBIT_HEAD_FETCHER ||
        fileURLToPath(new URL('head-fetcher.py', import.meta.url));
      const endpoint = await this.client
        .getPeerEndpoint(signal)
        .catch(() => undefined);
      // The fetcher shares the resolve's wall-clock budget rather than a
      // fixed allowance, so a slow add cannot push the total past it.
      const budgetMs = Math.max(5_000, Math.min(40_000, deadline - Date.now()));
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn('python3', [
          scriptPath,
          buildMagnet(playbackInfo, hash),
          '',
          '0',
          String(Math.round(budgetMs / 1000)),
          endpoint ? `${endpoint.host}:${endpoint.port}` : '',
          saveDir,
        ]);
      } catch (error) {
        logger.debug({ err: error, hash }, 'head fetcher spawn failed');
        rmSync(saveDir, { recursive: true, force: true });
        return undefined;
      }
      // A child exiting before our stdin write raises EPIPE, without a
      // listener that would crash the process.
      child.stdin?.on('error', () => {});
      const fail = (reason: string) => {
        child.kill('SIGKILL');
        rmSync(saveDir, { recursive: true, force: true });
        logger.debug({ hash, reason }, 'magnet-first head fetch abandoned');
        return undefined;
      };
      const state: {
        exited: boolean;
        files?: {
          index: number;
          name: string;
          size: number;
        }[];
        selectedIndex?: number;
        selectedSize?: number;
        headReady?: number;
        tailBytes?: number;
        hashOk?: boolean;
        registered?: boolean;
      } = { exited: false };
      child.on('error', () => {
        state.exited = true;
      });
      child.on('exit', () => {
        state.exited = true;
      });
      // JSON lines can straddle pipe chunks, a per-line parse without a
      // carry buffer silently drops the biggest one (a pack's file list).
      let carry = '';
      const onLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const evt = JSON.parse(line);
          if (evt.event === 'serving' || evt.event === 'head_piece') {
            logger.debug({ evt, hash }, 'head fetcher event');
          } else {
            logger.info({ evt, hash }, 'head fetcher event');
          }
          if (evt.event === 'metadata' && Array.isArray(evt.files)) {
            state.files = evt.files.map(
              (file: { name: string; size: number }, index: number) => ({
                index,
                name: file.name,
                size: file.size,
              })
            );
            if (typeof evt.info_hash === 'string') {
              state.hashOk = evt.info_hash === hash;
            }
          }
          if (evt.event === 'head_ready' && typeof evt.bytes === 'number') {
            state.headReady = evt.bytes;
          }
          if (
            evt.event === 'tail_ready' &&
            typeof evt.tail_bytes === 'number'
          ) {
            state.tailBytes = evt.tail_bytes;
            const registered = state.registered
              ? getHeadSidecar(
                  hash,
                  state.selectedIndex ?? -1,
                  state.selectedSize ?? 0
                )
              : undefined;
            if (registered) registered.tailBytes = evt.tail_bytes;
          }
          if (evt.event === 'torrent_hash_mismatch') {
            state.hashOk = false;
          }
        } catch {}
      };
      child.stdout!.setEncoding('utf-8');
      child.stdout!.on('data', (chunk: string) => {
        carry += chunk;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      });
      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk: string) => {
        logger.warn(
          { chunk: chunk.slice(0, 200), hash },
          'head fetcher stderr'
        );
      });
      const waitDone = Date.now() + budgetMs;
      try {
        // Phase 1: the fetcher emits the de-padded file list once its own
        // metadata fetch completes.
        while (!state.files && !state.exited && Date.now() < waitDone) {
          await sleep(100);
        }
        if (!state.files) return fail('no metadata');
        // Phase 2: select the file the same way the wait loop will, so the
        // sidecar and the eventual stream reference agree.
        const selected = await this.selectFile(
          {
            hash,
            name: playbackInfo.filename ?? playbackInfo.title ?? '',
          },
          state.files,
          playbackInfo
        );
        if (!selected) return fail('no file selection');
        state.selectedIndex = selected.index;
        state.selectedSize = selected.size;
        child.stdin!.write(
          `${JSON.stringify({
            index: selected.index,
            want: Math.min(selected.size, STREAM_THRESHOLD_BYTES),
          })}\n`
        );
        // Phase 3: the verified head. The tail piece keeps downloading
        // behind it and attaches to the registration when it lands.
        while (
          state.headReady === undefined &&
          !state.exited &&
          Date.now() < waitDone
        ) {
          await sleep(100);
        }
        if (state.headReady === undefined) return fail('head never completed');
        const overlayFile = join(saveDir, ...selected.name.split(/[\\/]/));
        if (!(await this.hasFlushedHead(overlayFile, selected.size))) {
          return fail('overlay not readable');
        }
        state.registered = true;
        registerHeadSidecar({
          hash,
          fileIndex: selected.index,
          file: overlayFile,
          bytes: Math.min(state.headReady, selected.size),
          fileSize: selected.size,
          tailBytes: state.tailBytes ?? 0,
          child,
        });
        logger.info(
          {
            hash,
            overlayBytes: state.headReady,
            tailBytes: state.tailBytes,
            file: selected.name,
          },
          'magnet-first head sidecar registered'
        );
        // The .torrent is only usable when its regenerated info dict
        // hashes to the infohash the magnet promised, otherwise the caller
        // falls back to the magnet add (the sidecar stays valid either way).
        const torrentPath = join(saveDir, 'head.torrent');
        if (!existsSync(torrentPath) || state.hashOk === false) {
          return undefined;
        }
        return torrentPath;
      } catch (error) {
        logger.warn(
          { err: error, hash },
          'magnet-first head fetch failed; falling back'
        );
        return fail('exception');
      }
    });
  }

  /**
   * Fetch the head pieces out-of-band with a short-lived libtorrent
   * sidecar, qBittorrent's picker starves a new file's opening pieces on
   * some swarms (measured live) while a sidecar finishes them in seconds
   * and backs playback until qBittorrent catches up. qBittorrent is
   * stopped for the fetch (one IP = one peer per remote client).
   */
  private async fetchHeadPieces(
    torrent: QbittorrentTorrent,
    files: Awaited<ReturnType<QBittorrentClient['getFiles']>>,
    selectedIndex: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    const selected = files.find((f) => f.index === selectedIndex);
    if (!selected) return false;
    // The hash names the sidecar directory, anything that is not an
    // infohash must never reach a path join.
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(torrent.hash)) return false;
    // A directory we cannot create (a read-only downloads mount) means the
    // accelerator is off, decided BEFORE anything is stopped.
    const saveDir = headSidecarDir(torrent.hash);
    if (!saveDir) return false;
    // Stopping qBittorrent for the fetch would stall any stream that is
    // already playing another file of this pack.
    let otherFileLive = false;
    for (const index of liveFileIndices(this.credential, torrent.hash)) {
      if (index !== selectedIndex) otherFileLive = true;
    }
    if (otherFileLive) {
      logger.debug(
        { hash: torrent.hash, selectedIndex },
        'skipping head fetch: another file of this torrent is live'
      );
      return false;
    }

    const workDir = mkdtempSync(join(tmpdir(), 'aiostreams-head-'));
    const torrentPath = join(workDir, 'head.torrent');
    let stopped = false;
    try {
      // Stop qB so the fetcher holds the per-IP slots. Assume the stop
      // worked, an extra restore is harmless but a missed one parks the
      // torrent stopped forever.
      stopped = true;
      const stopApplied = await this.client
        .stopTorrent(torrent.hash, signal)
        .catch(() => false);
      if (!stopApplied && !signal?.aborted) stopped = false;
      const torrentData = await this.client
        .exportTorrent(torrent.hash, signal)
        .catch(() => undefined);
      if (!torrentData || signal?.aborted) {
        return false;
      }
      writeFileSync(torrentPath, Buffer.from(torrentData));
      const scriptPath =
        process.env.AIOSTREAMS_QBIT_HEAD_FETCHER ||
        fileURLToPath(new URL('head-fetcher.py', import.meta.url));
      // The fetcher locates the file by its de-padded index (qBittorrent's
      // own numbering) and computes the exact piece span from the torrent.
      const endpoint = await this.client
        .getPeerEndpoint(signal)
        .catch(() => undefined);
      const child = spawn('python3', [
        scriptPath,
        torrentPath,
        String(selected.index),
        String(Math.min(selected.size, STREAM_THRESHOLD_BYTES)),
        '30',
        endpoint ? `${endpoint.host}:${endpoint.port}` : '',
        saveDir,
      ]);
      child.stdin?.on('error', () => {});
      const state: {
        exited: boolean;
        headReady?: number;
        tailBytes?: number;
      } = { exited: false };
      let carry = '';
      const onLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const evt = JSON.parse(line);
          // Serving heartbeats arrive once a second for the sidecar's
          // whole life, they keep the pipe drained but would drown the
          // log at info level.
          if (evt.event === 'serving' || evt.event === 'head_piece') {
            logger.debug({ evt, hash: torrent.hash }, 'head fetcher event');
          } else {
            logger.info({ evt, hash: torrent.hash }, 'head fetcher event');
          }
          if (evt.event === 'head_ready' && typeof evt.bytes === 'number') {
            state.headReady = evt.bytes;
          }
          if (
            evt.event === 'tail_ready' &&
            typeof evt.tail_bytes === 'number'
          ) {
            state.tailBytes = evt.tail_bytes;
            const registered = getHeadSidecar(
              torrent.hash,
              selected.index,
              selected.size
            );
            if (registered) registered.tailBytes = evt.tail_bytes;
          }
        } catch {}
      };
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        carry += chunk;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      });
      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk: string) => {
        logger.warn(
          { chunk: chunk.slice(0, 200), hash: torrent.hash },
          'head fetcher stderr'
        );
      });
      child.on('error', (err) => {
        state.exited = true;
        logger.warn(
          { err: String(err), hash: torrent.hash },
          'head fetcher spawn error'
        );
      });
      child.on('exit', (code) => {
        state.exited = true;
        logger.info({ code, hash: torrent.hash }, 'head fetcher exited');
      });
      const deadline = Date.now() + 40_000;
      while (
        state.headReady === undefined &&
        !state.exited &&
        Date.now() < deadline
      ) {
        await sleep(100);
      }
      if (state.headReady === undefined) {
        child.kill('SIGKILL');
        rmSync(saveDir, { recursive: true, force: true });
        return false;
      }
      const overlayFile = join(saveDir, ...selected.name.split(/[\\/]/));
      if (!(await this.hasFlushedHead(overlayFile, selected.size))) {
        child.kill('SIGKILL');
        rmSync(saveDir, { recursive: true, force: true });
        return false;
      }
      registerHeadSidecar({
        hash: torrent.hash,
        fileIndex: selected.index,
        file: overlayFile,
        bytes: Math.min(state.headReady, selected.size),
        fileSize: selected.size,
        tailBytes: state.tailBytes ?? 0,
        child,
      });
      logger.info(
        {
          hash: torrent.hash,
          overlayBytes: state.headReady,
          tailBytes: state.tailBytes,
        },
        'head sidecar registered; playback can start'
      );
      return true;
    } catch (error) {
      logger.warn(
        { err: error, hash: torrent.hash },
        'head fetcher failed; falling back to qBittorrent download'
      );
      rmSync(saveDir, { recursive: true, force: true });
      return false;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      // The restore must outlive the caller (no signal).
      if (stopped) {
        await this.client.startTorrent(torrent.hash).catch(() => {});
        await this.client.reannounce(torrent.hash).catch(() => {});
      }
    }
  }

  /**
   * Whether the file's head is readable and non-zero, proof the pieces
   * were flushed (a container header is never all zeros).
   */
  private async hasFlushedHead(
    filePath: string,
    fileSize: number
  ): Promise<boolean> {
    if (fileSize === 0) return true;
    const length = Math.min(64 * 1024, fileSize);
    // Non-blocking regular-file opens only, on paths that pass the roots
    // check (the .!qB variant too, qBittorrent's "Append .!qB to incomplete
    // files" keeps the suffixed name on disk until the file completes).
    let handle: Awaited<ReturnType<typeof openRegularFile>> = undefined;
    for (const variant of [filePath, filePath + '.!qB']) {
      const allowed = await resolveAllowedPath(variant);
      if (allowed.status !== 'allowed') continue;
      handle = await openRegularFile(allowed.realPath!);
      if (handle) break;
    }
    if (!handle) return false;
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead).some((byte) => byte !== 0);
    } catch {
      return false;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new DebridError('resolve aborted (failover lost)', {
        statusCode: 499,
        statusText: 'Client Closed Request',
        code: 'UNKNOWN',
        headers: {},
        body: null,
      });
    }
  }
}
