/**
 * Headless end-to-end check of the REAL agent loop, without VS Code:
 *
 *   mock model (OpenAI-compatible) ◄── TrueForge (local) ──► workspace MCP server (HeadlessHost on a temp copy of a repo)
 *                                          ▲
 *                                    TurnRunner (the same class the extension uses)
 *
 * Scenarios:
 *   1. agent turn: assemble_context → read_file → propose_edit (approval → review → apply) → done; file on disk changed.
 *   2. per-hunk rejection: review policy rejects everything → tool reports rejection, file unchanged.
 *   3. resilience: primary model points at a dead endpoint → retries with backoff → automatic fallback → file changed,
 *      and a run with NO fallback ends with a clear error and an unchanged workspace.
 *   4. cancellation: cancel mid-turn → turn.done cancelled, workspace unchanged.
 *
 * Usage: node dist/e2e.js --root ../flask [--trueforge http://localhost:8790]
 * Requires: TrueForge started with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { HeadlessHost } from './headlessHost';
import { RepoIndex } from '../context/index';
import { WorkspaceMcpServer } from '../mcp/server';
import { DecisionStore } from '../edit/decisions';
import { TurnRunner } from '../trueforge/runner';
import { createClient, registerWorkspaceMcp, ping, describeError } from '../trueforge/client';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const TF = arg('--trueforge', 'http://localhost:8790')!;
const ROOT = path.resolve(arg('--root', '../flask')!);
const RUN_ID = 'e2e-' + Math.random().toString(36).slice(2, 10);
const PROVIDER_OK = RUN_ID + '-mock', PROVIDER_DEAD = RUN_ID + '-dead';
const MODEL_OK = PROVIDER_OK + '/mock-coder', MODEL_DEAD = PROVIDER_DEAD + '/mock-coder';
const SCRIPTS = path.resolve(__dirname, '..', 'scripts');

async function startMock(fail?: string): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(process.execPath, [path.join(SCRIPTS, 'mock-model.mjs'), '--port', '0', ...(fail ? ['--fail', fail] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Mock model did not become ready')); }, 5000);
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Mock model exited before readiness (${code})`)); });
    proc.stdout!.on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      try {
        const ready = JSON.parse(output.split('\n')[0]);
        const port = Number(new URL(ready.listening).port);
        if (!Number.isInteger(port) || port <= 0) throw new Error('Invalid mock server port');
        clearTimeout(timer);
        resolve({ proc, port });
      } catch (error) { clearTimeout(timer); proc.kill(); reject(error); }
    });
  });
}

async function registerProvider(name: string, port: number): Promise<void> {
  const res = await fetch(`${TF}/api/v1/settings/model-providers`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { type: 'custom', name, base_url: `http://127.0.0.1:${port}/v1`, auth: { api_key: 'mock-key' }, models: [{ name: 'mock-coder', model_id: 'mock-coder', properties: { context_length: 128000, max_output_tokens: 8192 } }] } }),
  });
  if (!res.ok) throw new Error(`register provider ${name}: ${res.status} ${await res.text()}`);
}

function copyRepo(src: string): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-e2e-'));
  fs.cpSync(src, dst, { recursive: true, filter: p => !/\/(\.git|node_modules|\.venv|__pycache__)(\/|$)/.test(p) });
  return dst;
}

interface Scenario { name: string; run(): Promise<void>; }
const results: { name: string; ok: boolean; detail: string; ms: number }[] = [];

async function main(): Promise<void> {
  const conn = createClient(TF);
  const p = await ping(conn);
  if (!p.ok) { console.error(p.message); process.exit(2); }
  const procs: ChildProcess[] = [];
  try {
    const ok = await startMock(); procs.push(ok.proc);
    const dead = await startMock('503'); procs.push(dead.proc);
    await registerProvider(PROVIDER_OK, ok.port);
    await registerProvider(PROVIDER_DEAD, dead.port);

    const scenarios: Scenario[] = [
      { name: 'agent turn edits a file after approval + review', run: () => scenarioAgent('accept-all', true) },
      { name: 'rejecting every hunk leaves the file untouched', run: () => scenarioAgent('reject-all', false) },
      { name: 'resilience: dead primary → retries → automatic fallback', run: () => scenarioResilience(true) },
      { name: 'resilience: dead primary, no fallback → clear error, workspace unchanged', run: () => scenarioResilience(false) },
      { name: 'cancellation mid-turn leaves workspace unchanged', run: scenarioCancel },
    ];
    for (const s of scenarios) {
      const t0 = Date.now();
      try { await s.run(); results.push({ name: s.name, ok: true, detail: '', ms: Date.now() - t0 }); }
      catch (e) { results.push({ name: s.name, ok: false, detail: describeError(e), ms: Date.now() - t0 }); }
      console.error(`${results[results.length - 1].ok ? 'PASS' : 'FAIL'}  ${s.name}  (${Date.now() - t0}ms) ${results[results.length - 1].detail}`);
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
    process.exitCode = failed ? 1 : 0;
  } finally {
    for (const proc of procs) proc.kill();
    await conn.client.settings.modelProviders.delete(PROVIDER_OK).catch(() => {});
    await conn.client.settings.modelProviders.delete(PROVIDER_DEAD).catch(() => {});
  }
}

async function setup(policy: 'accept-all' | 'reject-all', primary: string, fallback?: string) {
  const repo = copyRepo(ROOT);
  const host = new HeadlessHost(repo, { reviewPolicy: policy, log: m => process.stderr.write(m + '\n') });
  const index = new RepoIndex(host);
  const decisions = new DecisionStore();
  const toolCalls: string[] = [];
  const mcp = new WorkspaceMcpServer({ host, index, decisions, budgetTokens: () => 8000, events: { onToolCall: n => toolCalls.push(n) } });
  const conn = createClient(TF);
  const serverName = 'anvil-e2e-' + Math.random().toString(36).slice(2, 7);
  try {
    await index.ensure();
    await mcp.start();
    await registerWorkspaceMcp(conn, serverName, mcp.url, mcp.secret);
  } catch (error) {
    await mcp.stop();
    await conn.client.settings.mcpServers.delete(serverName).catch(() => {});
    fs.rmSync(repo, { recursive: true, force: true });
    throw error;
  }
  const notices: string[] = [];
  const statuses: string[] = [];
  const runner = new TurnRunner({
    conn, host, decisions, primaryModel: primary, fallbackModel: fallback, maxRetries: 1,
    spec: { mcpServerName: serverName, subagents: false, compactionTriggerTokens: 60000, iterationLimit: 20 },
    callbacks: { onNotice: (l, t) => notices.push(`${l}: ${t}`), onStatus: t => statuses.push(t), onToolCall: (_t, n) => toolCalls.push('model→' + n) },
  });
  const cleanup = async () => { await mcp.stop(); await conn.client.settings.mcpServers.delete(serverName).catch(() => {}); fs.rmSync(repo, { recursive: true, force: true }); };
  return { repo, host, runner, toolCalls, notices, statuses, cleanup };
}

const TASK = 'Add a note comment to the top of src/flask/helpers.py explaining what the module is for.';

async function scenarioAgent(policy: 'accept-all' | 'reject-all', expectChange: boolean): Promise<void> {
  const s = await setup(policy, MODEL_OK);
  try {
    const target = path.join(s.repo, 'src/flask/helpers.py');
    const before = fs.readFileSync(target, 'utf8');
    const r = await s.runner.run(TASK);
    if (r.status !== 'done') throw new Error(`turn ended ${r.status}: ${r.message}`);
    if (!s.toolCalls.includes('assemble_context')) throw new Error('assemble_context was not called: ' + s.toolCalls.join(','));
    // The model must have *requested* propose_edit; when every hunk is rejected TrueForge never executes it
    // (the approval is denied), which is exactly the point.
    if (!s.toolCalls.includes('model→propose_edit')) throw new Error('propose_edit was not requested: ' + s.toolCalls.join(','));
    if (expectChange && !s.toolCalls.includes('propose_edit')) throw new Error('propose_edit was not executed after approval');
    if (!expectChange && s.toolCalls.includes('propose_edit')) throw new Error('propose_edit executed although the review denied it');
    const after = fs.readFileSync(target, 'utf8');
    const changed = after !== before;
    if (changed !== expectChange) throw new Error(`expected changed=${expectChange}, got ${changed}`);
    if (expectChange && !after.includes('touched by mock-coder')) throw new Error('edit content missing');
    if (!s.host.reviews.length) throw new Error('review was never shown');
  } finally { await s.cleanup(); }
}

async function scenarioResilience(withFallback: boolean): Promise<void> {
  const s = await setup('accept-all', MODEL_DEAD, withFallback ? MODEL_OK : undefined);
  try {
    const target = path.join(s.repo, 'src/flask/helpers.py');
    const before = fs.readFileSync(target, 'utf8');
    const r = await s.runner.run(TASK);
    const after = fs.readFileSync(target, 'utf8');
    if (withFallback) {
      if (r.status !== 'done') throw new Error(`expected done via fallback, got ${r.status}: ${r.message}`);
      if (!r.usedFallback || r.modelUsed !== MODEL_OK) throw new Error('fallback was not used: ' + JSON.stringify({ usedFallback: r.usedFallback, model: r.modelUsed }));
      if (!s.notices.some(n => n.startsWith('warn') && /Falling back/.test(n))) throw new Error('no fallback notice: ' + s.notices.join(' | '));
      if (!s.statuses.some(t => /retry 1\/1/.test(t))) throw new Error('no retry with backoff observed: ' + s.statuses.join(' | '));
      if (after === before) throw new Error('fallback model did not edit the file');
    } else {
      if (r.status !== 'error') throw new Error(`expected error, got ${r.status}`);
      if (!/unavailable|did not apply edits/.test(r.message ?? '')) throw new Error('error message not clear: ' + r.message);
      if (after !== before) throw new Error('workspace changed despite model failure');
      if (r.attempts < 2) throw new Error('expected retries, attempts=' + r.attempts);
    }
  } finally { await s.cleanup(); }
}

async function scenarioCancel(): Promise<void> {
  const s = await setup('accept-all', MODEL_OK);
  try {
    const target = path.join(s.repo, 'src/flask/helpers.py');
    const before = fs.readFileSync(target, 'utf8');
    const run = s.runner.run(TASK);
    // cancel as soon as the first tool call shows up (before propose_edit can be approved)
    const t0 = Date.now();
    while (!s.toolCalls.length && Date.now() - t0 < 20000) await new Promise(r => setTimeout(r, 50));
    await s.runner.cancel();
    const r = await run;
    if (r.status !== 'cancelled') throw new Error(`expected cancelled, got ${r.status}: ${r.message}`);
    if (fs.readFileSync(target, 'utf8') !== before) throw new Error('workspace changed after cancel');
  } finally { await s.cleanup(); }
}

main().catch(e => { console.error(e); process.exit(1); });
