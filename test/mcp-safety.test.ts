import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HeadlessHost } from '../src/host/headlessHost';
import { RepoIndex } from '../src/context/index';
import { DecisionStore } from '../src/edit/decisions';
import { WorkspaceMcpServer, globToRegex } from '../src/mcp/server';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-mcp-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const host = new HeadlessHost(root, { log: () => {} });
  const decisions = new DecisionStore();
  const server = new WorkspaceMcpServer({ host, decisions, index: new RepoIndex(host), budgetTokens: () => 1000 });
  await server.start();
  cleanups.push(() => server.stop());
  const client = new Client({ name: 'safety-test', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { 'x-anvil-token': server.secret } } }));
  cleanups.push(() => client.close());
  return { root, host, decisions, client };
}

it('does not overwrite user changes made while reviewing', async () => {
  const { host, client } = await fixture();
  await host.writeFile('file.txt', 'before\n');
  const review = host.reviewEdit.bind(host);
  host.reviewEdit = async (req, preview) => {
    const result = await review(req, preview);
    await host.writeFile('file.txt', 'user typed this\n');
    return result;
  };
  const result = await client.callTool({ name: 'propose_edit', arguments: { path: 'file.txt', summary: 'change', new_content: 'after\n' } });
  expect(result.isError).toBe(true);
  expect(await host.readFile('file.txt')).toBe('user typed this\n');
});

it('applies only accepted hunks even when the host returns no resultingContent', async () => {
  const { host, client } = await fixture();
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const proposed = before.replace('line 1\n', 'first change\n').replace('line 28\n', 'second change\n');
  await host.writeFile('file.txt', before);
  host.reviewEdit = async () => ({ decision: 'allow', key: '', decisions: [{ index: 0, accepted: true }, { index: 1, accepted: false }] });
  const result = await client.callTool({ name: 'propose_edit', arguments: { path: 'file.txt', summary: 'two changes', new_content: proposed } });
  expect(result.isError).not.toBe(true);
  expect(await host.readFile('file.txt')).toBe(before.replace('line 1\n', 'first change\n'));
});

it('does not apply a review accepted after cancellation', async () => {
  const { host, decisions, client } = await fixture();
  await host.writeFile('file.txt', 'before\n');
  const review = host.reviewEdit.bind(host);
  host.reviewEdit = async (req, preview) => { decisions.cancelTurn(); return review(req, preview); };
  const result = await client.callTool({ name: 'propose_edit', arguments: { path: 'file.txt', summary: 'change', new_content: 'after\n' } });
  expect(result.isError).toBe(true);
  expect(await host.readFile('file.txt')).toBe('before\n');
});

it('matches globstar against both root and nested paths', () => {
  expect(globToRegex('src/**/*.py').test('src/cli.py')).toBe(true);
  expect(globToRegex('src/**/*.py').test('src/flask/cli.py')).toBe(true);
  expect(globToRegex('src/*.py').test('src/flask/cli.py')).toBe(false);
});

it('collapses an identical repeated search within a turn, but not a changed result or a new turn', async () => {
  const { host, client, decisions } = await fixture();
  await host.writeFile('a.py', Array.from({ length: 40 }, (_, i) => `def handler_${i}(): return "json dumps ${i}"`).join('\n') + '\n');
  decisions.beginTurn();
  const call = async () => ((await client.callTool({ name: 'search_workspace', arguments: { query: 'json' } })).content as { text: string }[])[0].text;
  const first = await call();
  expect(first).toContain('a.py');
  const repeat = await call();
  expect(repeat).toContain('Same result as your earlier identical search_workspace call');
  expect(repeat.length).toBeLessThan(first.length);
  await host.writeFile('a.py', 'def handler(): return "json"\n'.repeat(30) + '# changed\n');
  expect(await call()).not.toContain('Same result');   // result changed → returned in full
  decisions.beginTurn();
  const nextTurn = await call();
  expect(nextTurn).not.toContain('Same result');        // new turn → full result again
});

it('prepares a context pack up front, announcing it like the tool does', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-pack-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/config_loader.py'), 'def load_config(path):\n    return open(path).read()\n');
  await fs.writeFile(path.join(root, 'src/unrelated.py'), 'def add(a, b):\n    return a + b\n');
  const host = new HeadlessHost(root, { log: () => {} });
  const seen: string[][] = [];
  const server = new WorkspaceMcpServer({ host, decisions: new DecisionStore(), index: new RepoIndex(host), budgetTokens: () => 1000,
    events: { onContextPack: p => seen.push(p.chosen.map(c => c.path)) } });
  const text = await server.prepareContext('change load_config so it reads the config file');
  expect(seen).toHaveLength(1);
  expect(seen[0][0]).toBe('src/config_loader.py');
  expect(text).toContain('src/config_loader.py');
  expect(server.lastPack?.chosen[0].path).toBe('src/config_loader.py');
  const previous = server.lastPack;
  const token = { isCancellationRequested: false };
  const pending = server.prepareContext('unrelated', token);
  token.isCancellationRequested = true;
  expect(await pending).toBe('');
  expect(server.lastPack).toBe(previous);
  expect(seen).toHaveLength(1);
});
