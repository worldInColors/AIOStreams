import '../../index.js';
import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { settingsStore } from '../../config/index.js';
import { SettingsRepository } from '../../db/repositories/settings.js';
import { FeatureControl } from '../../utils/feature.js';
import { makeRequest } from '../../utils/index.js';
import { TorrentGrabber } from '../../utils/torrent.js';
import { getEnvironmentServiceDetails } from '../../utils/config.js';
import { toUrlSafeBase64 } from '../../utils/general.js';
import { DebridError, PlaybackInfo } from '../base.js';
import {
  parseQbittorrentCredential,
  QBittorrentClient,
  QbittorrentFile,
  QBITTORRENT_TAG,
} from './client.js';
import { QBittorrentService } from './service.js';
import {
  decodeQbittorrentStreamToken,
  encodeQbittorrentStreamToken,
  QbittorrentStreamToken,
  registerStreamRef,
  resolveStreamRef,
} from './tokens.js';
import {
  applyPathMappings,
  computeFileAvailability,
  diskContiguousBytes,
  deriveFilePath,
  PieceReadiness,
  planFilePriorities,
} from './availability.js';

describe('applyPathMappings', () => {
  test('rewrites the longest matching prefix', () => {
    assert.equal(
      applyPathMappings('/qbit/downloads/pack/s01.mkv', [
        { from: '/qbit', to: '/local' },
        { from: '/qbit/downloads', to: '/data' },
      ]),
      '/data/pack/s01.mkv'
    );
  });

  test('leaves unmatched paths alone', () => {
    assert.equal(
      applyPathMappings('/elsewhere/file.mkv', [{ from: '/qbit', to: '/local' }]),
      '/elsewhere/file.mkv'
    );
    assert.equal(applyPathMappings('/any/file.mkv'), '/any/file.mkv');
  });
});

const WEBUI = 'http://qbit.test';

function credentialToken(
  url = WEBUI,
  username = 'user',
  password = 'pass'
): string {
  return toUrlSafeBase64(JSON.stringify({ url, username, password }));
}

function file(partial: Partial<QbittorrentFile> & { index: number; name: string; size: number; piece_range: [number, number] }): QbittorrentFile {
  return { progress: 0, priority: 1, ...partial };
}

const TOKEN: QbittorrentStreamToken = {
  ref: '0d1e2f3a-4b5c-6d7e-8f9a-0b1c2d3e4f5a',
  exp: 4102444800,
};

describe('parseQbittorrentCredential', () => {




  test('accepts skipOtherFiles as a string flag from the form', () => {
    const credential = parseQbittorrentCredential(
      toUrlSafeBase64(
        JSON.stringify({ url: WEBUI, username: 'u', password: 'p', skipOtherFiles: 'true' })
      )
    );
    assert.equal(credential.skipOtherFiles, true);
  });

  test('treats the string "false" as off', () => {
    const credential = parseQbittorrentCredential(
      toUrlSafeBase64(
        JSON.stringify({ url: WEBUI, username: 'u', password: 'p', skipOtherFiles: 'false' })
      )
    );
    assert.equal(credential.skipOtherFiles, false);
  });

  test('accepts an explicit null as off', () => {
    const credential = parseQbittorrentCredential(
      toUrlSafeBase64(
        JSON.stringify({ url: WEBUI, username: 'u', password: 'p', skipOtherFiles: null })
      )
    );
    assert.equal(credential.skipOtherFiles, false);
  });

});

describe('stream tokens', () => {

  test('rejects tampered ciphertext', () => {
    const encoded = encodeQbittorrentStreamToken(TOKEN);
    const tampered = encoded.slice(0, -4) + (encoded.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    assert.equal(decodeQbittorrentStreamToken(tampered), undefined);
  });


  test('stream references round-trip every credential field', async (t) => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
    t.after(() => mock.restoreAll());
    const credential = parseQbittorrentCredential(
      toUrlSafeBase64(
        JSON.stringify({
          url: WEBUI,
          username: 'u',
          password: 'p',
          skipOtherFiles: 'true',
          pathMappings: '/qbit/downloads=/data',
        })
      )
    );
    const ref = await registerStreamRef({
      credential,
      hash: 'a'.repeat(40),
      fileIndex: 2,
      filePath: '/data/pack/s01e02.mkv',
      fileSize: 12345,
      filename: 's01e02.mkv',
      addedAt: 1700000000,
    });
    const entry = await resolveStreamRef(ref);
    assert.ok(entry, 'reference resolves');
    assert.deepEqual(entry?.credential, credential);
    assert.equal(entry?.filePath, '/data/pack/s01e02.mkv');
    assert.equal(entry?.fileSize, 12345);
    // The common live configuration, no optional fields set at all.
    const bare = parseQbittorrentCredential(
      toUrlSafeBase64(
        JSON.stringify({ url: WEBUI, username: 'u', password: 'p' })
      )
    );
    const bareRef = await registerStreamRef({
      credential: bare,
      hash: 'b'.repeat(40),
      fileIndex: 0,
      filePath: '/x/a.mkv',
      fileSize: 1,
      filename: 'a.mkv',
      addedAt: 1,
    });
    assert.ok(await resolveStreamRef(bareRef), 'bare credential round-trips');
  });
});

describe('planFilePriorities', () => {
  const pack = [
    file({ index: 0, name: 's01e01.mkv', size: 500, piece_range: [0, 1], priority: 1 }),
    file({ index: 1, name: 's01e02.mkv', size: 500, piece_range: [2, 3], priority: 1 }),
    file({ index: 2, name: 's01e03.mkv', size: 500, piece_range: [4, 5], priority: 1 }),
  ];

  test('own torrent without skip raises only the selected file', () => {
    const plan = planFilePriorities({
      files: pack,
      selectedIndex: 1,
      skipOthers: false,
      ownTorrent: true,
    });
    assert.deepEqual(plan, { skip: [], raise: [1], restore: [] });
  });

  test('own torrent with skip raises the selected file and skips the rest', () => {
    const plan = planFilePriorities({
      files: pack,
      selectedIndex: 1,
      skipOthers: true,
      ownTorrent: true,
    });
    assert.deepEqual(plan.skip.sort(), [0, 2]);
    assert.deepEqual(plan.raise, [1]);
    assert.deepEqual(plan.restore, []);
  });

  test('adopted torrents are only restored, never re-arranged', () => {
    const skipped = pack.map((f) =>
      f.index === 2 ? { ...f, priority: 0 } : f
    );
    const plan = planFilePriorities({
      files: skipped,
      selectedIndex: 2,
      skipOthers: true,
      ownTorrent: false,
    });
    assert.deepEqual(plan, { skip: [], raise: [], restore: [2] });
  });

  test('adopted torrents with a downloadable selected file are untouched', () => {
    const plan = planFilePriorities({
      files: pack,
      selectedIndex: 0,
      skipOthers: true,
      ownTorrent: false,
    });
    assert.deepEqual(plan, { skip: [], raise: [], restore: [] });
  });

  test('complete torrents are never touched, even with skip on', () => {
    const complete = pack.map((f) => ({ ...f, progress: 1 }));
    const plan = planFilePriorities({
      files: complete,
      selectedIndex: 1,
      skipOthers: true,
      ownTorrent: true,
    });
    assert.deepEqual(plan, { skip: [], raise: [], restore: [] });
  });

  test('already-downloaded files are not skipped again', () => {
    const partiallyDone = pack.map((f) =>
      f.index === 0 ? { ...f, progress: 1 } : f
    );
    const plan = planFilePriorities({
      files: partiallyDone,
      selectedIndex: 1,
      skipOthers: true,
      ownTorrent: true,
    });
    assert.deepEqual(plan.skip, [2]);
    assert.deepEqual(plan.raise, [1]);
  });

  test('files with an active stream are never skipped', () => {
    const plan = planFilePriorities({
      files: pack,
      selectedIndex: 1,
      skipOthers: true,
      ownTorrent: true,
      liveFiles: new Set([0]),
    });
    assert.deepEqual(plan.skip, [2]);
    assert.deepEqual(plan.raise, [1]);
  });

  test('a complete selected file is not raised', () => {
    const selectedDone = pack.map((f) =>
      f.index === 1 ? { ...f, progress: 1 } : f
    );
    const plan = planFilePriorities({
      files: selectedDone,
      selectedIndex: 1,
      skipOthers: false,
      ownTorrent: true,
    });
    assert.deepEqual(plan, { skip: [], raise: [], restore: [] });
  });
});

describe('deriveFilePath', () => {
  const pack = [
    file({ index: 0, name: 'pack/s01e01.mkv', size: 100, piece_range: [0, 1] }),
    file({ index: 1, name: 'pack/s01e02.mkv', size: 100, piece_range: [2, 3] }),
  ];
  const rootless = [
    file({ index: 0, name: 'a.mkv', size: 100, piece_range: [0, 1] }),
    file({ index: 1, name: 'b.mkv', size: 100, piece_range: [2, 3] }),
  ];
  const showPack = [
    file({ index: 0, name: 'Show/e01.mkv', size: 100, piece_range: [0, 1] }),
    file({ index: 1, name: 'Show/e02.mkv', size: 100, piece_range: [2, 3] }),
  ];

  test('folder pack kept: names join under the content path parent', () => {
    assert.equal(
      deriveFilePath(
        { content_path: '/dl/final/pack', save_path: '/dl/final' },
        pack,
        1
      ),
      '/dl/final/pack/s01e02.mkv'
    );
  });

  test('folder pack follows the content path into the temp dir', () => {
    assert.equal(
      deriveFilePath(
        { content_path: '/dl/incomplete/pack', save_path: '/dl/final' },
        pack,
        0
      ),
      '/dl/incomplete/pack/s01e01.mkv'
    );
  });

  test('save dir named like the pack root does not collide', () => {
    assert.equal(
      deriveFilePath(
        { content_path: '/dl/Show/Show', save_path: '/dl/Show' },
        showPack,
        0
      ),
      '/dl/Show/Show/e01.mkv'
    );
  });

  test('stripped root layout drops the shared first segment', () => {
    assert.equal(
      deriveFilePath(
        { content_path: '/dl', save_path: '/dl' },
        showPack,
        1
      ),
      '/dl/e02.mkv'
    );
  });

  test('rootless layouts join names onto the content path', () => {
    assert.equal(
      deriveFilePath({ content_path: '/dl/rel', save_path: '/dl/rel' }, rootless, 1),
      '/dl/rel/b.mkv'
    );
  });

  test('rootless layouts in a temp dir still use the content path', () => {
    assert.equal(
      deriveFilePath({ content_path: '/tmp/inc', save_path: '/dl' }, rootless, 0),
      '/tmp/inc/a.mkv'
    );
  });

  test('single-file torrents use the content path directly', () => {
    const single = [file({ index: 0, name: 'movie.mkv', size: 1, piece_range: [0, 1] })];
    assert.equal(
      deriveFilePath(
        { content_path: '/dl/pack/movie.mkv', save_path: '/dl/pack' },
        single,
        0
      ),
      '/dl/pack/movie.mkv'
    );
  });

  test('windows separators are normalised', () => {
    assert.equal(
      deriveFilePath(
        { content_path: 'C:\\dl\\pack', save_path: 'C:\\dl' },
        pack,
        0
      ),
      'C:/dl/pack/s01e01.mkv'
    );
  });

});

describe('diskContiguousBytes', () => {
  test('counts written bytes and stops at the first zero chunk', async (t) => {
    mock.method(SettingsRepository, 'getAll', async () => []);
    mock.method(SettingsRepository, 'getVersion', async () => 0);
    await settingsStore.initialise();
    t.after(() => mock.restoreAll());
    const dir = mkdtempSync(join(tmpdir(), 'aiostreams-qbit-'));
    const path = join(dir, 'video.mkv');
    // 192KiB of content, then 128KiB of zeros (unwritten pre-allocation).
    writeFileSync(path, Buffer.concat([Buffer.alloc(192 * 1024, 1), Buffer.alloc(128 * 1024)]));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(await diskContiguousBytes(path, 0, 16 * 1024 * 1024), 192 * 1024);
    assert.equal(await diskContiguousBytes(path, 64 * 1024, 16 * 1024 * 1024), 128 * 1024);
    assert.equal(await diskContiguousBytes(path, 200 * 1024, 16 * 1024 * 1024), 0);
  });

  test('a fully pre-allocated zero file reports nothing', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aiostreams-qbit-'));
    const path = join(dir, 'video.mkv');
    writeFileSync(path, Buffer.alloc(1024 * 1024));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(await diskContiguousBytes(path, 0, 16 * 1024 * 1024), 0);
  });

  test('slices align to the torrent block grid, not the file start', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aiostreams-qbit-'));
    const path = join(dir, 'video.mkv');
    // File sits at torrent offset 8KiB: [0,8KiB) is the tail of a block
    // straddling the file start, whole blocks run [8,24), [24,40) KiB.
    // An unwritten block must stop the scan even though file-local 16KiB
    // slices around it would both contain non-zero bytes.
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.alloc(24 * 1024, 1),
        Buffer.alloc(16 * 1024),
        Buffer.alloc(8 * 1024, 1),
      ])
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const phase = 8 * 1024;
    assert.equal(
      await diskContiguousBytes(path, 0, 16 * 1024 * 1024, phase),
      24 * 1024
    );
    // A resume point mid-file stays on the block grid.
    assert.equal(
      await diskContiguousBytes(path, 20 * 1024, 16 * 1024 * 1024, phase),
      4 * 1024
    );
  });

  test('a zero head region of a straddling block reports nothing', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aiostreams-qbit-'));
    const path = join(dir, 'video.mkv');
    // The straddling first block is unwritten, its whole file-portion
    // is zeros even though the first full block after it is written.
    writeFileSync(
      path,
      Buffer.concat([Buffer.alloc(8 * 1024), Buffer.alloc(32 * 1024, 1)])
    );
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(
      await diskContiguousBytes(path, 0, 16 * 1024 * 1024, 8 * 1024),
      0
    );
  });
});

describe('PieceReadiness', () => {
  const files = [
    file({ index: 0, name: 'video.mkv', size: 1000, piece_range: [0, 3] }),
  ];

  test('withholds pieces until they are seen in an earlier observation', () => {
    const readiness = new PieceReadiness(4);
    readiness.observe([2, 2, 0, 0]);
    const fresh = computeFileAvailability({
      files,
      fileIndex: 0,
      pieceStates: [2, 2, 0, 0],
      pieceSize: 250,
      isReadable: readiness.readable,
    });
    assert.equal(fresh.contiguousFrom(0), 500);
    assert.equal(fresh.readableFrom(0), 0);
    // One observation later both downloaded pieces have aged.
    readiness.observe([2, 2, 0, 0]);
    const aged = computeFileAvailability({
      files,
      fileIndex: 0,
      pieceStates: [2, 2, 0, 0],
      pieceSize: 250,
      isReadable: readiness.readable,
    });
    assert.equal(aged.readableFrom(0), 500);
  });

  test('serves the file tail once the last piece has aged', () => {
    const readiness = new PieceReadiness(4);
    // firstLastPiecePrio pulled the tail piece in early.
    readiness.observe([2, 0, 0, 2]);
    readiness.observe([2, 0, 0, 2]);
    const availability = computeFileAvailability({
      files,
      fileIndex: 0,
      pieceStates: [2, 0, 0, 2],
      pieceSize: 250,
      isReadable: readiness.readable,
    });
    assert.equal(availability.readableFrom(750), 1000);
    assert.equal(availability.contiguousFrom(0), 250);
  });

  test('a piece lost to a recheck must age again', () => {
    const readiness = new PieceReadiness(2);
    readiness.observe([2, 2]);
    readiness.observe([2, 0]);
    readiness.observe([2, 2]);
    const availability = computeFileAvailability({
      files: [file({ index: 0, name: 'v.mkv', size: 500, piece_range: [0, 1] })],
      fileIndex: 0,
      pieceStates: [2, 2],
      pieceSize: 250,
      isReadable: readiness.readable,
    });
    // Piece 1 re-appeared in the same observation, not readable yet.
    assert.equal(availability.readableFrom(0), 250);
  });
});

describe('computeFileAvailability', () => {
  // Layout: pieceSize 250. File 0 = [0, 500) = pieces 0-1.
  // File 1 = [500, 1500) = pieces 2-5, 1000 bytes.
  const files = [
    file({ index: 0, name: 'first.bin', size: 500, piece_range: [0, 1], progress: 1 }),
    file({ index: 1, name: 'video.mkv', size: 1000, piece_range: [2, 5] }),
  ];

  test('reports complete when every file piece is downloaded', () => {
    const availability = computeFileAvailability({
      files,
      fileIndex: 1,
      pieceStates: [2, 2, 2, 2, 2, 2],
      pieceSize: 250,
    });
    assert.equal(availability.complete, true);
    assert.equal(availability.rangeAvailable(0, 1000), true);
  });

  test('serves a range only when all its pieces are downloaded', () => {
    // Piece 4 missing, global [1000, 1250) = file bytes [500, 750).
    const availability = computeFileAvailability({
      files,
      fileIndex: 1,
      pieceStates: [2, 2, 2, 2, 0, 2],
      pieceSize: 250,
    });
    assert.equal(availability.complete, false);
    assert.equal(availability.rangeAvailable(0, 500), true);
    assert.equal(availability.rangeAvailable(0, 501), false);
    assert.equal(availability.rangeAvailable(750, 1000), true);
  });

  test('clamps contiguous reads at the first hole', () => {
    const availability = computeFileAvailability({
      files,
      fileIndex: 1,
      pieceStates: [2, 2, 2, 2, 0, 2],
      pieceSize: 250,
    });
    assert.equal(availability.contiguousFrom(0), 500);
    assert.equal(availability.contiguousFrom(500), 500);
    assert.equal(availability.contiguousFrom(750), 1000);
  });

  test('handles a piece shared with the previous file', () => {
    // File 0 = [0, 600) (pieces 0-2), file 1 = [600, 1500) (pieces 2-5):
    // piece 2 spans the end of file 0 and the start of file 1.
    const shared = [
      file({ index: 0, name: 'first.bin', size: 600, piece_range: [0, 2], progress: 1 }),
      file({ index: 1, name: 'video.mkv', size: 900, piece_range: [2, 5] }),
    ];
    const availability = computeFileAvailability({
      files: shared,
      fileIndex: 1,
      pieceStates: [0, 0, 2, 0, 0, 0],
      pieceSize: 250,
    });
    // Piece 2 covers global [500, 750): file 1 bytes [0, 150).
    assert.equal(availability.contiguousFrom(0), 150);
  });

  test('claims nothing from partial progress when piece states are unavailable', () => {
    // Progress is not a prefix map (first/last-piece priority, non-sequential
    // downloads), so a progress-length prefix could hand a player zeros.
    const partial = [
      file({ index: 0, name: 'first.bin', size: 500, piece_range: [0, 1], progress: 1 }),
      file({ index: 1, name: 'video.mkv', size: 1000, piece_range: [2, 5], progress: 0.5 }),
    ];
    const availability = computeFileAvailability({
      files: partial,
      fileIndex: 1,
      pieceSize: 250,
    });
    assert.equal(availability.complete, false);
    assert.equal(availability.contiguousFrom(0), 0);
    assert.equal(availability.rangeAvailable(0, 500), false);
  });

  test('a complete file is playable without piece states', () => {
    const complete = [
      file({ index: 0, name: 'first.bin', size: 500, piece_range: [0, 1], progress: 1 }),
      file({ index: 1, name: 'video.mkv', size: 1000, piece_range: [2, 5], progress: 1 }),
    ];
    const availability = computeFileAvailability({
      files: complete,
      fileIndex: 1,
      pieceSize: 250,
    });
    assert.equal(availability.complete, true);
    assert.equal(availability.contiguousFrom(0), 1000);
  });

  test('corrects offsets when pad files are hidden from the list', () => {
    // True layout: file 0 = [0, 500) (pieces 0-1), a hidden 250-byte pad file
    // = [500, 750) (piece 2), file 1 = [750, 1750) (pieces 3-6). The files
    // list omits the pad file, so summed offsets land one piece short, the
    // file's own piece range pins the true offset.
    const withPad = [
      file({ index: 0, name: 'first.bin', size: 500, piece_range: [0, 1], progress: 1 }),
      file({ index: 1, name: 'video.mkv', size: 1000, piece_range: [3, 6] }),
    ];
    const availability = computeFileAvailability({
      files: withPad,
      fileIndex: 1,
      pieceStates: [2, 2, 2, 2, 0, 0, 0],
      pieceSize: 250,
    });
    // File 1 starts at global 750 (piece 3), its first 250 bytes are in
    // piece 3 = global [750, 1000).
    assert.equal(availability.contiguousFrom(0), 250);
    assert.equal(availability.rangeAvailable(0, 250), true);
    assert.equal(availability.rangeAvailable(0, 251), false);
  });

  test('resolves files by index regardless of array order', () => {
    const reordered = [
      file({ index: 1, name: 'video.mkv', size: 1000, piece_range: [2, 5] }),
      file({ index: 0, name: 'first.bin', size: 500, piece_range: [0, 1], progress: 1 }),
    ];
    const availability = computeFileAvailability({
      files: reordered,
      fileIndex: 1,
      pieceStates: [2, 2, 2, 2, 2, 2],
      pieceSize: 250,
    });
    assert.equal(availability.complete, true);
  });

  test('treats zero-length files as complete', () => {
    const withEmpty = [
      file({ index: 0, name: 'first.bin', size: 500, piece_range: [0, 1], progress: 1 }),
      file({ index: 1, name: 'empty.txt', size: 0, piece_range: [2, 1] }),
    ];
    const availability = computeFileAvailability({
      files: withEmpty,
      fileIndex: 1,
      pieceStates: [2, 2],
      pieceSize: 250,
    });
    assert.equal(availability.complete, true);
    assert.equal(availability.rangeAvailable(0, 0), true);
  });
});

// Each test gets its own credential so the client's shared session and
// login-failure caches cannot leak state between tests.
let credentialCounter = 0;

function service() {
  return new QBittorrentService(
    { token: credentialToken(WEBUI, 'user', `pass-${++credentialCounter}`) },
    { pollInterval: 10, maxWaitTime: 100 }
  );
}

function serviceWithSkip() {
  return new QBittorrentService(
    {
      token: toUrlSafeBase64(
        JSON.stringify({
          url: WEBUI,
          username: 'user',
          password: `skip-${++credentialCounter}`,
          skipOtherFiles: 'true',
        })
      ),
    },
    { pollInterval: 10, maxWaitTime: 100 }
  );
}

describe('QBittorrentService', () => {
  test('maps torrent states onto download statuses', async (t) => {
    await withMockedWebUi(t, {
      login: true,
      intercepts: [
        {
          path: `/api/v2/torrents/info?hashes=${'b'.repeat(40)}%7C${'c'.repeat(40)}%7C${'d'.repeat(40)}%7C${'9'.repeat(40)}`,
          body: [
            { ...torrentFixture('b'.repeat(40), 'stalledUP'), progress: 1 },
            torrentFixture('c'.repeat(40), 'error'),
            torrentFixture('9'.repeat(40), 'downloading'),
          ],
        },
        {
          path: `/api/v2/torrents/files?hash=${'b'.repeat(40)}`,
          body: [fileFixture(0, 'video.mkv', 2000)],
        },
        {
          path: `/api/v2/torrents/files?hash=${'9'.repeat(40)}`,
          body: [fileFixture(0, 'video.mkv', 2000)],
        },
      ],
    });
    const [seeded, errored, absent, downloading] = await service().checkMagnets([
      `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
      `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
      `magnet:?xt=urn:btih:${'d'.repeat(40)}`,
      `magnet:?xt=urn:btih:${'9'.repeat(40)}`,
    ]);
    assert.equal(seeded.status, 'cached');
    assert.equal(seeded.library, true);
    assert.ok(seeded.files?.length);
    assert.equal(errored.status, 'failed');
    assert.equal(absent.status, 'unknown');
    assert.equal(absent.library, false);
    // Present but incomplete, playable only after more download.
    assert.equal(downloading.status, 'downloading');
    assert.equal(downloading.library, true);
  });

  test('adds torrents with the aiostreams tag and streaming flags', async (t) => {
    let addBody = '';
    await withMockedWebUi(t, {
      login: true,
      intercepts: [],
      onAdd: (body) => (addBody = body),
    });
    await service().addMagnet(`magnet:?xt=urn:btih:${'e'.repeat(40)}`);
    assert.match(addBody, /urls=magnet%3A/);
    assert.match(addBody, new RegExp(`tags=${QBITTORRENT_TAG}`));
    assert.match(addBody, /sequentialDownload=true/);
    assert.match(addBody, /firstLastPiecePrio=true/);
  });

  test('maps a rejected add to STORE_MAGNET_INVALID', async (t) => {
    await withMockedWebUi(t, { login: true, intercepts: [], addStatus: 415 });
    await assert.rejects(
      () => service().addMagnet(`magnet:?xt=urn:btih:${'f'.repeat(40)}`),
      (err: unknown) =>
        err instanceof DebridError && err.code === 'STORE_MAGNET_INVALID'
    );
  });

  test('reports bad credentials as UNAUTHORIZED', async (t) => {
    await withMockedWebUi(t, { login: false });
    await assert.rejects(
      () => service().listMagnets(),
      (err: unknown) =>
        err instanceof DebridError && err.code === 'UNAUTHORIZED'
    );
  });

  test('re-logins once when the session goes stale', async (t) => {
    let logins = 0;
    let dataHits = 0;
    await withMockedWebUi(t, {
      login: true,
      intercepts: [],
      onLogin: () => logins++,
      dataIntercept: () => {
        dataHits++;
        // First data call pretends the SID is stale, then succeeds.
        if (dataHits === 1) {
          return { statusCode: 401 };
        }
        return {
          statusCode: 200,
          data: JSON.stringify([]),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      },
    });
    const result = await service().listMagnets();
    assert.deepEqual(result, []);
    assert.equal(logins, 2);
    assert.equal(dataHits, 2);
  });
});

function torrentFixture(hash: string, state: string) {
  return {
    hash,
    name: 'release',
    state,
    progress: 0,
    size: 2000,
    completed: 0,
    amount_left: 2000,
    content_path: '/downloads/release',
    save_path: '/downloads',
    category: '',
    tags: '',
    added_on: 1700000000,
  };
}

function fileFixture(index: number, name: string, size: number) {
  return { index, name, size, progress: 0, priority: 1, piece_range: [0, 1], availability: 1 };
}

describe('qbittorrent service availability', () => {
  test('hidden until download roots are configured', () => {
    const previous = process.env.QBITTORRENT_ALLOWED_ROOTS;
    delete process.env.QBITTORRENT_ALLOWED_ROOTS;
    try {
      assert.ok(
        FeatureControl.disabledServices.has('qbittorrent'),
        'qBittorrent is disabled without roots'
      );
      const details = getEnvironmentServiceDetails();
      assert.ok(!('qbittorrent' in details), 'qBittorrent absent from the service list');
      process.env.QBITTORRENT_ALLOWED_ROOTS = '/downloads';
      assert.ok(
        !FeatureControl.disabledServices.has('qbittorrent'),
        'qBittorrent enabled with roots configured'
      );
      assert.ok('qbittorrent' in getEnvironmentServiceDetails());
    } finally {
      if (previous === undefined) {
        delete process.env.QBITTORRENT_ALLOWED_ROOTS;
      } else {
        process.env.QBITTORRENT_ALLOWED_ROOTS = previous;
      }
    }
  });
});

describe('QBittorrentService resolve', () => {
  // The confinement check fails closed without configured roots, these
  // tests build their content under the system temp directory.
  const previousRoots = process.env.QBITTORRENT_ALLOWED_ROOTS;
  const previousFetcher = process.env.QBITTORRENT_HEAD_FETCHER_SCRIPT;
  before(() => {
    process.env.QBITTORRENT_ALLOWED_ROOTS = tmpdir();
    // Resolve tests must not spawn real head fetchers, the override is
    // the SCRIPT the fetcher interpreter runs, /bin/false makes python
    // fail parsing it immediately so the magnet-first and fallback
    // paths both bail into the mocked WebUI flow.
    process.env.QBITTORRENT_HEAD_FETCHER_SCRIPT = '/bin/false';
  });
  after(() => {
    if (previousRoots === undefined) {
      delete process.env.QBITTORRENT_ALLOWED_ROOTS;
    } else {
      process.env.QBITTORRENT_ALLOWED_ROOTS = previousRoots;
    }
    if (previousFetcher === undefined) {
      delete process.env.QBITTORRENT_HEAD_FETCHER_SCRIPT;
    } else {
      process.env.QBITTORRENT_HEAD_FETCHER_SCRIPT = previousFetcher;
    }
  });

  // One unique infohash per test, the live-file registry is module-global
  // with a 15-minute TTL, so reusing a hash would leak liveness between
  // tests (and correctly suppress skips of a "live" file). Forty hex
  // chars, the length qBittorrent itself reports.
  const hashOf = (seed: string) =>
    (Array.from(seed, (c) => (c.charCodeAt(0) % 16).toString(16)).join('') +
      '0'.repeat(40)).slice(0, 40);

  function playback(hash: string, fileIndex: number): PlaybackInfo {
    return { type: 'torrent', hash, sources: [], fileIndex };
  }

  /**
   * A directory on the real filesystem holding one non-zero file per entry,
   * so the resolve wait's flushed-to-disk check passes. For a single file
   * the torrent's content_path is the file itself, for several it is the
   * directory.
   */
  function makeContent(
    t: { after: (fn: () => void) => void },
    files: { name: string; size: number }[]
  ): string {
    const dir = mkdtempSync(join(tmpdir(), 'aiostreams-qbit-'));
    for (const file of files) {
      writeFileSync(join(dir, file.name), Buffer.alloc(file.size, 1));
    }
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return files.length === 1 ? join(dir, files[0].name) : dir;
  }

  function dataIntercepts(
    hash: string,
    torrent: Record<string, unknown>,
    files: Record<string, unknown>[],
    pieceStates: number[]
  ) {
    return [
      { path: `/api/v2/torrents/info?hashes=${hash}`, body: [torrent] },
      { path: `/api/v2/torrents/files?hash=${hash}`, body: files },
      { path: `/api/v2/torrents/properties?hash=${hash}`, body: { piece_size: 250 } },
      {
        path: `/api/v2/torrents/pieceStates?hash=${hash}`,
        body: pieceStates,
      },
    ];
  }

  test('resolves a ready file and raises its priority', async (t) => {
    const hash = hashOf('1');
    const contentPath = makeContent(t, [{ name: 'video.mkv', size: 2000 }]);
    const prioBodies: string[] = [];
    await withMockedWebUi(t, {
      login: true,
      onFilePrio: (body) => prioBodies.push(body),
      intercepts: dataIntercepts(
        hash,
        { ...torrentFixture(hash, 'downloading'), content_path: contentPath, tags: QBITTORRENT_TAG },
        [{ ...fileFixture(0, 'video.mkv', 2000), piece_range: [0, 7] }],
        [2, 2, 2, 2, 2, 2, 2, 2]
      ),
    });
    const link = await service().resolve(playback(hash, 0), 'video.mkv', true);
    assert.match(link ?? '', /\/api\/v1\/qbittorrent\/stream\//);
    assert.equal(prioBodies.length, 1);
    assert.match(prioBodies[0], /id=0/);
    assert.match(prioBodies[0], /priority=7/);
  });

  test('a provisional hash resolves through the grabbed torrent hash', async (t) => {
    const realHash = hashOf('11');
    const pseudoHash = hashOf('p');
    const contentPath = makeContent(t, [{ name: 'video.mkv', size: 2000 }]);
    const original = TorrentGrabber.getMetadataEager;
    TorrentGrabber.getMetadataEager = async () => ({
      hash: realHash,
      files: [],
      sources: [],
    });
    t.after(() => {
      TorrentGrabber.getMetadataEager = original;
    });
    await withMockedWebUi(t, {
      login: true,
      intercepts: dataIntercepts(
        realHash,
        { ...torrentFixture(realHash, 'downloading'), content_path: contentPath, tags: QBITTORRENT_TAG },
        [{ ...fileFixture(0, 'video.mkv', 2000), piece_range: [0, 7] }],
        [2, 2, 2, 2, 2, 2, 2, 2]
      ),
    });
    const link = await service().resolve(
      {
        type: 'torrent',
        hash: pseudoHash,
        hashProvisional: true,
        downloadUrl: 'http://indexer.example/download?key=pass',
        title: 'Some Release 1080p',
        sources: [],
        fileIndex: 0,
      },
      'video.mkv',
      true
    );
    assert.match(link ?? '', /\/api\/v1\/qbittorrent\/stream\//);
  });

  test('a provisional hash with no file index selects from the pack', async (t) => {
    // Production shape: hashless results carry no file list, so the
    // playback info arrives without a fileIndex and the file is picked
    // from qBittorrent's real file list after the add.
    const realHash = hashOf('14');
    const contentPath = makeContent(t, [
      { name: 'show.s01e01.mkv', size: 2000 },
      { name: 'show.s01e02.mkv', size: 2000 },
    ]);
    const original = TorrentGrabber.getMetadataEager;
    TorrentGrabber.getMetadataEager = async () => ({
      hash: realHash,
      files: [],
      sources: [],
    });
    t.after(() => {
      TorrentGrabber.getMetadataEager = original;
    });
    await withMockedWebUi(t, {
      login: true,
      intercepts: dataIntercepts(
        realHash,
        { ...torrentFixture(realHash, 'downloading'), content_path: contentPath, tags: QBITTORRENT_TAG },
        [
          { ...fileFixture(0, 'show.s01e01.mkv', 2000), piece_range: [0, 3] },
          { ...fileFixture(1, 'show.s01e02.mkv', 2000), piece_range: [4, 7] },
        ],
        [2, 2, 2, 2, 2, 2, 2, 2]
      ),
    });
    const link = await service().resolve(
      {
        type: 'torrent',
        hash: hashOf('q'),
        hashProvisional: true,
        downloadUrl: 'http://indexer.example/download?key=pass',
        title: 'Show S01 1080p',
        sources: [],
      },
      'show.s01e02.mkv',
      true
    );
    assert.match(link ?? '', /\/api\/v1\/qbittorrent\/stream\//);
  });

  test('a provisional hash missing from qBittorrent adds by URL, never a magnet', async (t) => {
    const realHash = hashOf('12');
    let addBody = '';
    const original = TorrentGrabber.getMetadataEager;
    TorrentGrabber.getMetadataEager = async () => ({
      hash: realHash,
      files: [],
      sources: [],
    });
    t.after(() => {
      TorrentGrabber.getMetadataEager = original;
    });
    await withMockedWebUi(t, {
      login: true,
      onAdd: (body) => (addBody = body),
      intercepts: [
        { path: `/api/v2/torrents/info?hashes=${realHash}`, body: [] },
      ],
    });
    // cacheAndPlay off returns after the add, no readable wait needed.
    const link = await service().resolve(
      {
        type: 'torrent',
        hash: hashOf('p'),
        hashProvisional: true,
        downloadUrl: 'http://indexer.example/download?key=pass',
        title: 'Some Release 1080p',
        sources: [],
        fileIndex: 0,
      },
      'video.mkv',
      false
    );
    assert.equal(link, undefined);
    assert.match(addBody, /urls=http%3A%2F%2Findexer\.example/);
    assert.doesNotMatch(addBody, /magnet/);
  });

  test('a grabbed torrent with bytes is added by upload, not by URL', async (t) => {
    const realHash = hashOf('15');
    let addBody = '';
    const original = TorrentGrabber.getMetadataEager;
    TorrentGrabber.getMetadataEager = async () => ({
      hash: realHash,
      files: [],
      sources: [],
      torrentB64: Buffer.from('d4:infod4:name4:testee').toString('base64'),
    });
    t.after(() => {
      TorrentGrabber.getMetadataEager = original;
    });
    await withMockedWebUi(t, {
      login: true,
      onAdd: (body) => (addBody = body),
      intercepts: [
        { path: `/api/v2/torrents/info?hashes=${realHash}`, body: [] },
      ],
    });
    // cacheAndPlay off returns after the add, no readable wait needed.
    const link = await service().resolve(
      {
        type: 'torrent',
        hash: hashOf('r'),
        hashProvisional: true,
        downloadUrl: 'http://indexer.example/download?key=pass',
        title: 'Some Release 1080p',
        sources: [],
        fileIndex: 0,
      },
      'video.mkv',
      false
    );
    assert.equal(link, undefined);
    assert.notEqual(addBody, '', 'the add endpoint was called');
    assert.doesNotMatch(addBody, /urls=/);
    assert.doesNotMatch(addBody, /magnet/);
  });

  test('an aborted resolve never reaches any add', async (t) => {
    let addBody = '';
    const original = TorrentGrabber.getMetadataEager;
    TorrentGrabber.getMetadataEager = async () => ({
      hash: hashOf('16'),
      files: [],
      sources: [],
    });
    t.after(() => {
      TorrentGrabber.getMetadataEager = original;
    });
    await withMockedWebUi(t, {
      login: true,
      onAdd: (body) => (addBody = body),
      intercepts: [],
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      service().resolve(
        {
          type: 'torrent',
          hash: hashOf('s'),
          hashProvisional: true,
          downloadUrl: 'http://indexer.example/download?key=pass',
          title: 'Some Release 1080p',
          sources: [],
          fileIndex: 0,
        },
        'video.mkv',
        true,
        undefined,
        controller.signal
      ),
      (error: unknown) =>
        error instanceof DebridError &&
        error.message === 'resolve aborted (failover lost)'
    );
    assert.equal(addBody, '', 'no add request was made');
  });

  test('an enriched private torrent is added by URL, never as a magnet', async (t) => {
    const realHash = hashOf('17');
    let addBody = '';
    const original = TorrentGrabber.getMetadataEager;
    TorrentGrabber.getMetadataEager = async () => undefined;
    t.after(() => {
      TorrentGrabber.getMetadataEager = original;
    });
    await withMockedWebUi(t, {
      login: true,
      onAdd: (body) => (addBody = body),
      intercepts: [
        { path: `/api/v2/torrents/info?hashes=${realHash}`, body: [] },
      ],
    });
    const link = await service().resolve(
      {
        type: 'torrent',
        hash: realHash,
        private: true,
        downloadUrl: 'http://indexer.example/download?key=pass',
        title: 'Some Release 1080p',
        sources: [],
        fileIndex: 0,
      },
      'video.mkv',
      false
    );
    assert.equal(link, undefined);
    assert.match(addBody, /urls=http%3A%2F%2Findexer\.example/);
    assert.doesNotMatch(addBody, /magnet/);
  });

  test('an enriched private torrent without a URL is refused, never magneted', async (t) => {
    const realHash = hashOf('18');
    let addBody = '';
    await withMockedWebUi(t, {
      login: true,
      onAdd: (body) => (addBody = body),
      intercepts: [
        { path: `/api/v2/torrents/info?hashes=${realHash}`, body: [] },
      ],
    });
    await assert.rejects(
      service().resolve(
        {
          type: 'torrent',
          hash: realHash,
          private: true,
          title: 'Some Release 1080p',
          sources: [],
          fileIndex: 0,
        },
        'video.mkv',
        false
      ),
      (error: unknown) =>
        error instanceof DebridError && error.code === 'STORE_MAGNET_INVALID'
    );
    assert.equal(addBody, '', 'no add request was made');
  });

  test('a resolve joining a stuck grab fetches independently within budget', async (t) => {
    // The first request to this server takes 10s, the second redirects
    // to a magnet. Without the capped join window the second eager call
    // would burn its whole budget waiting and return nothing. MockAgent
    // cannot fake a hung reply, so this runs against a real socket.
    const magnetHash = 'a'.repeat(40);
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      if (hits === 1) {
        setTimeout(() => {
          res.writeHead(200);
          res.end('late');
        }, 10_000);
        return;
      }
      res.writeHead(302, {
        location: `magnet:?xt=urn:btih:${magnetHash}&dn=x`,
      });
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const torrent = {
      type: 'torrent' as const,
      title: 'Some Release 1080p',
      size: 0,
      downloadUrl: `http://127.0.0.1:${port}/download?key=pass&run=${Date.now()}`,
      sources: [],
    };
    void TorrentGrabber.getMetadataEager(torrent).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    const startedAt = Date.now();
    const metadata = await TorrentGrabber.getMetadataEager(torrent, 3_000);
    const elapsed = Date.now() - startedAt;
    assert.equal(metadata?.hash, magnetHash);
    assert.ok(
      elapsed < 2_900,
      `independent fetch ran within budget (${elapsed}ms)`
    );
  });

  test('a torrent already in qBittorrent never spawns the fetcher', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aiostreams-nospawn-'));
    const marker = join(dir, 'spawned');
    const script = join(dir, 'marker.py');
    writeFileSync(script, `with open(${JSON.stringify(marker)}, 'w'): pass\nraise SystemExit(1)\n`);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const previous = process.env.QBITTORRENT_HEAD_FETCHER_SCRIPT;
    process.env.QBITTORRENT_HEAD_FETCHER_SCRIPT = script;
    const realHash = hashOf('19');
    const contentPath = makeContent(t, [{ name: 'video.mkv', size: 2000 }]);
    try {
      await withMockedWebUi(t, {
        login: true,
        intercepts: dataIntercepts(
          realHash,
          { ...torrentFixture(realHash, 'downloading'), content_path: contentPath, tags: QBITTORRENT_TAG },
          [{ ...fileFixture(0, 'video.mkv', 2000), piece_range: [0, 7] }],
          [2, 2, 2, 2, 2, 2, 2, 2]
        ),
      });
      const link = await service().resolve(
        {
          type: 'torrent',
          hash: realHash,
          title: 'Some Release 1080p',
          sources: [],
          fileIndex: 0,
        },
        'video.mkv',
        true
      );
      assert.match(link ?? '', /\/api\/v1\/qbittorrent\/stream\//);
      assert.ok(
        !existsSync(marker),
        'the head fetcher was never spawned for a torrent qB already has'
      );
    } finally {
      if (previous === undefined) {
        delete process.env.QBITTORRENT_HEAD_FETCHER_SCRIPT;
      } else {
        process.env.QBITTORRENT_HEAD_FETCHER_SCRIPT = previous;
      }
    }
  });

  test('a provisional hash whose grab fails refuses instead of magneting', async (t) => {
    const original = TorrentGrabber.getMetadataEager;
    TorrentGrabber.getMetadataEager = async () => undefined;
    t.after(() => {
      TorrentGrabber.getMetadataEager = original;
    });
    await withMockedWebUi(t, { login: true, intercepts: [] });
    await assert.rejects(
      service().resolve(
        {
          type: 'torrent',
          hash: hashOf('p'),
          hashProvisional: true,
          downloadUrl: 'http://indexer.example/download?key=pass',
          title: 'Some Release 1080p',
          sources: [],
          fileIndex: 0,
        },
        'video.mkv',
        true
      ),
      (error: unknown) =>
        error instanceof DebridError && error.code === 'STORE_MAGNET_INVALID'
    );
  });

  test('restores a skipped selected file in an adopted torrent', async (t) => {
    const hash = hashOf('2');
    const contentPath = makeContent(t, [{ name: 'video.mkv', size: 2000 }]);
    const prioBodies: string[] = [];
    await withMockedWebUi(t, {
      login: true,
      onFilePrio: (body) => prioBodies.push(body),
      intercepts: dataIntercepts(
        hash,
        { ...torrentFixture(hash, 'downloading'), content_path: contentPath },
        [{ ...fileFixture(0, 'video.mkv', 2000), priority: 0, piece_range: [0, 7] }],
        [2, 2, 2, 2, 2, 2, 2, 2]
      ),
    });
    const link = await service().resolve(playback(hash, 0), 'video.mkv', true);
    assert.match(link ?? '', /\/api\/v1\/qbittorrent\/stream\//);
    assert.equal(prioBodies.length, 1);
    assert.match(prioBodies[0], /id=0/);
    assert.match(prioBodies[0], /priority=1/);
  });

  test('resumes a stopped own torrent', async (t) => {
    const hash = hashOf('3');
    const contentPath = makeContent(t, [{ name: 'video.mkv', size: 2000 }]);
    const starts: string[] = [];
    await withMockedWebUi(t, {
      login: true,
      onTorrentStart: (body) => starts.push(body),
      intercepts: dataIntercepts(
        hash,
        { ...torrentFixture(hash, 'stoppedDL'), content_path: contentPath, tags: QBITTORRENT_TAG },
        [{ ...fileFixture(0, 'video.mkv', 2000), piece_range: [0, 7] }],
        [2, 2, 2, 2, 2, 2, 2, 2]
      ),
    });
    const link = await service().resolve(playback(hash, 0), 'video.mkv', true);
    assert.match(link ?? '', /\/api\/v1\/qbittorrent\/stream\//);
    assert.equal(starts.length, 1);
    assert.match(starts[0], new RegExp(`hashes=${hash}`));
  });

  test('leaves a complete torrent untouched', async (t) => {
    const hash = hashOf('4');
    const contentPath = makeContent(t, [{ name: 'video.mkv', size: 2000 }]);
    const prioBodies: string[] = [];
    await withMockedWebUi(t, {
      login: true,
      onFilePrio: (body) => prioBodies.push(body),
      intercepts: dataIntercepts(
        hash,
        { ...torrentFixture(hash, 'stalledUP'), content_path: contentPath, progress: 1, tags: QBITTORRENT_TAG },
        [{ ...fileFixture(0, 'video.mkv', 2000), progress: 1, piece_range: [0, 7] }],
        [2, 2, 2, 2, 2, 2, 2, 2]
      ),
    });
    const link = await service().resolve(playback(hash, 0), 'video.mkv', true);
    assert.match(link ?? '', /\/api\/v1\/qbittorrent\/stream\//);
    assert.equal(prioBodies.length, 0);
  });

  test('selects versioned episode files in folder packs', async (t) => {
    // qBittorrent reports folder-prefixed paths, "01v2" in a full path loses
    // its episode number in the title parser, so selection must see base names.
    const hash = hashOf('7');
    const dir = mkdtempSync(join(tmpdir(), 'aiostreams-qbit-'));
    // deriveFilePath treats content_path === save_path with a shared first
    // name segment as a stripped root, so the files live directly in the dir.
    writeFileSync(join(dir, '[Group] Show - 01v2 (BD 1080p) [ABCDEF01].mkv'), Buffer.alloc(1000, 1));
    writeFileSync(join(dir, '[Group] Show - 02v2 (BD 1080p) [ABCDEF02].mkv'), Buffer.alloc(1000, 1));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const contentPath = dir;
    const prioBodies: string[] = [];
    await withMockedWebUi(t, {
      login: true,
      onFilePrio: (body) => prioBodies.push(body),
      intercepts: dataIntercepts(
        hash,
        {
          ...torrentFixture(hash, 'downloading'),
          content_path: contentPath,
          save_path: contentPath,
          tags: QBITTORRENT_TAG,
        },
        [
          {
            ...fileFixture(0, 'Show S1/[Group] Show - 01v2 (BD 1080p) [ABCDEF01].mkv', 1000),
            piece_range: [0, 3],
          },
          {
            ...fileFixture(1, 'Show S1/[Group] Show - 02v2 (BD 1080p) [ABCDEF02].mkv', 1000),
            piece_range: [4, 7],
          },
        ],
        [2, 2, 2, 2, 2, 2, 2, 2]
      ),
    });
    const link = await serviceWithSkip().resolve(playback(hash, 1), '[Group] Show - 02v2.mkv', true);
    assert.match(link ?? '', /s01e02|02v2/, 'a file was selected and resolved');
    assert.ok(
      prioBodies.some((body) => /id=1/.test(body) && /priority=7/.test(body)),
      'the versioned episode 02v2 was raised'
    );
  });

  test('skips other files and raises the selected one when opted in', async (t) => {
    const hash = hashOf('5');
    const contentPath = makeContent(t, [
      { name: 's01e01.mkv', size: 1000 },
      { name: 's01e02.mkv', size: 1000 },
    ]);
    const prioBodies: string[] = [];
    await withMockedWebUi(t, {
      login: true,
      onFilePrio: (body) => prioBodies.push(body),
      intercepts: dataIntercepts(
        hash,
        {
          ...torrentFixture(hash, 'downloading'),
          content_path: contentPath,
          save_path: contentPath,
          tags: QBITTORRENT_TAG,
        },
        [
          { ...fileFixture(0, 's01e01.mkv', 1000), piece_range: [0, 3] },
          { ...fileFixture(1, 's01e02.mkv', 1000), piece_range: [4, 7] },
        ],
        [2, 2, 2, 2, 2, 2, 2, 2]
      ),
    });
    const link = await serviceWithSkip().resolve(playback(hash, 1), 's01e02.mkv', true);
    assert.match(link ?? '', /\/api\/v1\/qbittorrent\/stream\//);
    assert.match(
      link ?? '',
      /\/s01e02\.mkv$/,
      'the url ends with the file name players sniff the format from'
    );
    // The token segment must round-trip through a real URL: base64 contains
    // path-unsafe characters that would otherwise truncate it at the router.
    const tokenInUrl = link!.split('/stream/')[1].split('/')[0];
    assert.ok(!/[+/]/.test(tokenInUrl), 'token carries no raw path-unsafe characters');
    const decoded = decodeQbittorrentStreamToken(decodeURIComponent(tokenInUrl));
    assert.ok(decoded && decoded.exp > 0, 'the url token decodes to a valid stream token');
    assert.equal(prioBodies.length, 2);
    assert.ok(
      prioBodies.some((body) => /id=1/.test(body) && /priority=7/.test(body))
    );
    assert.ok(
      prioBodies.some((body) => /id=0/.test(body) && /priority=0/.test(body))
    );
  });
});

interface MockWebUiOptions {
  login: boolean;
  intercepts?: { path: string; body: unknown }[];
  addStatus?: number;
  onAdd?: (body: string) => void;
  onLogin?: () => void;
  onFilePrio?: (body: string) => void;
  onTorrentStart?: (body: string) => void;
  /** Reply callback for `/api/v2/torrents/info?tag=aiostreams` (listMagnets). */
  dataIntercept?: () => {
    statusCode: number;
    data?: string;
    responseOptions?: { headers: Record<string, string> };
  };
}

/**
 * Point the undici dispatcher at a fake WebUI: one login intercept, one
 * add intercept, and per-path JSON bodies for the data endpoints. All
 * intercepts are registered here because undici matches the earliest
 * registered intercept for a path, so a test cannot shadow these later.
 */
async function withMockedWebUi(
  t: { after: (fn: () => void) => void },
  options: MockWebUiOptions
) {
  options.intercepts ??= [];
  mock.method(SettingsRepository, 'getAll', async () => []);
  mock.method(SettingsRepository, 'getVersion', async () => 0);
  await settingsStore.initialise();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(agent);
  t.after(() => setGlobalDispatcher(previous));

  agent
    .get(WEBUI)
    .intercept({ path: '/api/v2/auth/login', method: 'POST' })
    .reply(() => {
      options.onLogin?.();
      if (!options.login) {
        return { statusCode: 200, data: 'Fails.' };
      }
      return {
        statusCode: 200,
        data: 'Ok.',
        responseOptions: { headers: { 'set-cookie': 'SID=test; Path=/' } },
      };
    })
    .persist();
  agent
    .get(WEBUI)
    .intercept({ path: '/api/v2/torrents/add', method: 'POST' })
    .reply(({ body }) => {
      options.onAdd?.(String(body));
      return { statusCode: options.addStatus ?? 200, data: '' };
    })
    .persist();
  if (options.dataIntercept) {
    agent
      .get(WEBUI)
      .intercept({ path: '/api/v2/torrents/info?tag=aiostreams' })
      .reply(options.dataIntercept)
      .persist();
  }
  agent
    .get(WEBUI)
    .intercept({ path: '/api/v2/torrents/filePrio', method: 'POST' })
    .reply(({ body }) => {
      options.onFilePrio?.(String(body));
      return { statusCode: 200, data: '' };
    })
    .persist();
  agent
    .get(WEBUI)
    .intercept({ path: '/api/v2/torrents/start', method: 'POST' })
    .reply(({ body }) => {
      options.onTorrentStart?.(String(body));
      return { statusCode: 200, data: '' };
    })
    .persist();
  for (const { path, body } of options.intercepts) {
    agent
      .get(WEBUI)
      .intercept({ path })
      .reply(() => ({
        statusCode: 200,
        data: JSON.stringify(body),
        responseOptions: { headers: { 'content-type': 'application/json' } },
      }))
      .persist();
  }
  return agent;
}

describe('multipart adds over a real socket', () => {
  // The mock WebUI never inspects request bodies, so the class-realm bug
  // (a global FormData posted through the package undici fetch arrives
  // malformed and qB answers 400) was invisible to every mocked test.
  // These run against a real listener and assert the wire format.
  interface Captured {
    path: string | undefined;
    contentType: string | string[] | undefined;
    body: Buffer;
  }

  async function captureServer(
    t: { after: (fn: () => void) => void },
    addStatus: number
  ): Promise<{ url: string; requests: Captured[] }> {
    const requests: Captured[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          path: req.url,
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks),
        });
        if (req.url === '/api/v2/auth/login') {
          res.writeHead(204, { 'set-cookie': 'SID=sock' });
          res.end();
          return;
        }
        res.writeHead(addStatus, { 'content-type': 'text/plain' });
        res.end(addStatus === 200 ? 'Ok.' : '');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    return { url: `http://127.0.0.1:${port}`, requests };
  }

  test('addTorrentFile posts a parseable multipart body', async (t) => {
    const { url, requests } = await captureServer(t, 200);
    const client = new QBittorrentClient(
      parseQbittorrentCredential(credentialToken(url))
    );
    const dir = mkdtempSync(join(tmpdir(), 'aiostreams-mp-'));
    const torrentPath = join(dir, 'grab.torrent');
    const bytes = Buffer.from('d4:infod4:name4:testee');
    writeFileSync(torrentPath, bytes);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const ok = await client.addTorrentFile(torrentPath);
    assert.equal(ok, true);
    const add = requests.find((r) => r.path === '/api/v2/torrents/add');
    assert.ok(add, 'torrents/add was called');
    assert.match(
      String(add.contentType),
      /^multipart\/form-data; boundary=/
    );
    const body = add.body.toString('latin1');
    assert.ok(body.includes('name="torrents"'));
    assert.ok(body.includes('filename="head.torrent"'));
    assert.ok(add.body.includes(bytes), 'body carries the torrent bytes');
  });

  test('makeRequest serializes a global FormData as multipart', async (t) => {
    const { url, requests } = await captureServer(t, 200);
    const form = new FormData();
    form.append('openai_base_url', 'http://provider.example');
    form.append('model_name', 'test-model');
    const response = await makeRequest(`${url}/api/v2/torrents/add`, {
      method: 'POST',
      timeout: 5_000,
      body: form as unknown as Parameters<typeof makeRequest>[1]['body'],
    });
    assert.equal(response.status, 200);
    const add = requests.find((r) => r.path === '/api/v2/torrents/add');
    assert.ok(add, 'the add endpoint was called');
    assert.match(
      String(add.contentType),
      /^multipart\/form-data; boundary=/
    );
    const body = add.body.toString('utf8');
    assert.ok(body.includes('openai_base_url'));
    assert.ok(body.includes('test-model'));
  });
});
