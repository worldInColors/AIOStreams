import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  getHeadSidecar,
  registerHeadSidecar,
  sweepHeadSidecars,
} from './head-sidecar.js';

function fakeChild(): ChildProcess & { killedWith: string[] } {
  const child = new EventEmitter() as unknown as ChildProcess & {
    killedWith: string[];
  };
  child.killedWith = [];
  child.exitCode = null;
  child.signalCode = null;
  // A fetcher that dies the moment it is signalled, the reaper must handle
  // a child that is already gone by the time it attaches its exit handler.
  child.kill = ((signal?: string) => {
    child.killedWith.push(signal ?? 'SIGTERM');
    child.exitCode = 0;
    child.signalCode = signal ?? null;
    child.emit('exit', 0, signal ?? null);
    return true;
  }) as ChildProcess['kill'];
  return child;
}

function sidecarFile(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `head-sidecar-test-${tag}-`));
  const file = join(dir, 'episode.mkv');
  writeFileSync(file, Buffer.from([1, 2, 3]));
  return file;
}

test('head sidecar registry serves and refreshes an entry', () => {
  const child = fakeChild();
  const file = sidecarFile('get');
  registerHeadSidecar({ hash: 'a'.repeat(40), fileIndex: 0, file, bytes: 42, child });
  const sidecar = getHeadSidecar('a'.repeat(40), 0);
  assert.equal(sidecar?.file, file);
  assert.equal(sidecar?.bytes, 42);
  child.kill('SIGKILL');
});

test('replacing a sidecar reaps the previous child and directory', () => {
  const first = fakeChild();
  const firstFile = sidecarFile('first');
  registerHeadSidecar({
    hash: 'b'.repeat(40),
    fileIndex: 0,
    file: firstFile,
    bytes: 10,
    child: first,
  });
  const second = fakeChild();
  const secondFile = sidecarFile('second');
  registerHeadSidecar({
    hash: 'b'.repeat(40),
    fileIndex: 0,
    file: secondFile,
    bytes: 20,
    child: second,
  });
  assert.ok(first.killedWith.includes('SIGTERM'));
  assert.ok(!existsSync(firstFile), 'replaced sidecar dir removed');
  assert.equal(getHeadSidecar('b'.repeat(40), 0)?.file, secondFile);
  second.kill('SIGKILL');
});

test('the sweeper reaps idle sidescars and their directories', () => {
  const child = fakeChild();
  const file = sidecarFile('sweep');
  registerHeadSidecar({
    hash: 'c'.repeat(40),
    fileIndex: 0,
    file,
    bytes: 5,
    child,
    ttlMs: 0,
  });
  sweepHeadSidecars();
  assert.ok(child.killedWith.includes('SIGTERM'));
  assert.ok(!existsSync(file), 'expired sidecar dir removed');
  assert.equal(getHeadSidecar('c'.repeat(40), 0), undefined);
});
