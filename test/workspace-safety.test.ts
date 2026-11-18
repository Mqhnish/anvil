import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HeadlessHost } from '../src/host/headlessHost';
import { resolveWorkspacePath } from '../src/host/paths';
import { executeCommand } from '../src/host/commands';
import { DecisionStore } from '../src/edit/decisions';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-safety-')); dirs.push(dir); return dir; }

describe('workspace boundaries', () => {
  it('rejects sibling directories sharing the workspace prefix', async () => {
    const dir = await fixture();
    const root = path.join(dir, 'repo');
    await fs.mkdir(root);
    expect(() => resolveWorkspacePath(root, '../repo-other/file')).toThrow('escapes workspace');
    expect(resolveWorkspacePath(root, 'new/sub/file')).toBe(path.join(root, 'new/sub/file'));
  });
  it('rejects reads and new files through outward symlinks', async () => {
    const dir = await fixture();
    const root = path.join(dir, 'repo');
    await fs.mkdir(root);
    await fs.writeFile(path.join(dir, 'private'), 'outside');
    await fs.symlink(dir, path.join(root, 'link'));
    const host = new HeadlessHost(root);
    await expect(host.readFile('link/private')).rejects.toThrow('symlink');
    await expect(host.writeFile('link/new/file', 'bad')).rejects.toThrow('symlink');
    expect(await fs.readFile(path.join(dir, 'private'), 'utf8')).toBe('outside');
  });
});

describe('command lifecycle', () => {
  it('does not execute a command whose signal is already aborted', async () => {
    const dir = await fixture();
    const result = await executeCommand('touch should-not-exist', dir, { signal: AbortSignal.abort() });
    expect(result.exitCode).toBeNull();
    expect(await fs.readdir(dir)).toEqual([]);
  });
  it('resolves spawn errors instead of hanging or crashing', async () => {
    const dir = await fixture();
    const result = await executeCommand('echo test', path.join(dir, 'missing'));
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toMatch(/ENOENT/);
  });
  it('kills descendants on timeout before they can write', async () => {
    const dir = await fixture();
    const result = await executeCommand('(sleep 0.4; touch late) & wait', dir, { timeoutMs: 40 });
    expect(result.timedOut).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

describe('approval lifetime', () => {
  it('binds command approval to its working directory', () => {
    const store = new DecisionStore();
    store.approveCommand('npm test', 'safe');
    expect(store.takeCommandApproval('npm test', 'other')).toBe(false);
    expect(store.takeCommandApproval('npm test', 'safe')).toBe(true);
    expect(store.takeCommandApproval('npm test', 'safe')).toBe(false);
  });
  it('revokes approvals on cancellation and starts a fresh signal for the next turn', () => {
    const store = new DecisionStore();
    store.approveCommand('npm test');
    const signal = store.signal;
    store.cancelTurn();
    expect(signal.aborted).toBe(true);
    expect(store.takeCommandApproval('npm test')).toBe(false);
    store.beginTurn();
    expect(store.signal.aborted).toBe(false);
  });
});

it('stops an active command when its turn is cancelled', async () => {
  const dir = await fixture();
  const controller = new AbortController();
  const command = executeCommand('(sleep 0.4; touch late) & wait', dir, { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  const result = await command;
  expect(result.exitCode).toBeNull();
  expect(result.timedOut).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(await fs.readdir(dir)).toEqual([]);
});
