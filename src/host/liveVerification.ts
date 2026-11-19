/** Opt-in real Free Tier rehearsal. Uses the production runner and disposable Flask copies. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { HeadlessHost } from './headlessHost';
import { RepoIndex } from '../context/index';
import { WorkspaceMcpServer } from '../mcp/server';
import { DecisionStore } from '../edit/decisions';
import { TurnRunner } from '../trueforge/runner';
import { createClient, registerWorkspaceMcp, ping } from '../trueforge/client';

const arg = (name: string, fallback: string) => process.argv[process.argv.indexOf(name) + 1] ?? fallback;
const ROOT = path.resolve(process.argv.includes('--root') ? arg('--root', '') : '../flask');
const TF = process.env.ANVIL_TEST_TRUEFORGE_URL ?? 'http://127.0.0.1:8790';
const MODEL = 'google-gemini/gemini-3-5-flash-lite';
const OUTPUT = path.resolve('output/verification/live-' + new Date().toISOString().replace(/[:.]/g, '-'));
const PYTHON = path.resolve('tmp/flask-verification-venv/bin/python');
const conn = createClient(TF);
const results: unknown[] = [];
const taskB = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

function python(repo: string, args: string[]): string {
  return execFileSync(PYTHON, args, { cwd: repo, encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONPATH: path.join(repo, 'src') } });
}

async function scenario(name: string, primary = MODEL, fallback?: string): Promise<void> {
  const repo = path.join(OUTPUT, name);
  fs.cpSync(ROOT, repo, { recursive: true, filter: p => !/(^|\/)(\.git|\.venv|__pycache__|\.pytest_cache|\.vscode)(\/|$)/.test(p) });
  process.env.PYTHONPATH = path.join(repo, 'src');
  const host = new HeadlessHost(repo, { reviewPolicy: 'accept-all' });
  const index = new RepoIndex(host);
  const decisions = new DecisionStore();
  const tools: { name: string; args: string }[] = [];
  const notices: string[] = [];
  const events: unknown[] = [];
  const serverName = 'anvil-live-' + Math.random().toString(36).slice(2, 10);
  const mcp = new WorkspaceMcpServer({ host, index, decisions, budgetTokens: () => 4000 });
  const runner = new TurnRunner({
    conn, host, decisions, primaryModel: primary, fallbackModel: fallback, maxRetries: 0,
    spec: { mcpServerName: serverName, subagents: false, compactionTriggerTokens: 60000, iterationLimit: 20,
      extraInstructions: 'The Python environment already has the test dependencies installed. Use pytest tests/test_cli.py -q for focused verification. Do not install packages or access the network.' },
    callbacks: {
      onEvent: e => events.push(e),
      onToolCall: (_thread, tool, args) => { tools.push({ name: tool, args }); console.error(`[${name}] ${tool}`); },
      onStatus: s => console.error(`[${name}] ${s}`),
      onNotice: (_level, text) => { notices.push(text); console.error(text); },
      onCommandApproval: async command => ({ allow: /^pytest tests\/test_cli\.py(?: -q)?$/.test(command.trim()), reason: 'Live rehearsal permits only the focused CLI test command.' }),
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = Date.now();
  try {
    await index.ensure();
    await mcp.start();
    await registerWorkspaceMcp(conn, serverName, mcp.url, mcp.secret);
    const before = fs.readFileSync(path.join(repo, 'src/flask/helpers.py'), 'utf8');
    const selected = before.match(/def get_debug_flag\(\)[\s\S]*?(?=\n\ndef )/)?.[0].trimEnd();
    if (!selected) throw new Error('Flask selection not found');
    const firstLine = before.slice(0, before.indexOf(selected)).split('\n').length;
    const prompt = name === 'task-b' ? taskB : [
      'INLINE EDIT', 'file: src/flask/helpers.py', `lines: ${firstLine}-${firstLine + selected.split('\n').length - 1}`,
      "instruction: Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.",
      '', 'selected code (use this EXACT text as the `old` search block of propose_edit):', '```', selected, '```',
    ].join('\n');
    fs.writeFileSync(path.join(repo, '../' + name + '-prompt.txt'), prompt);
    timer = setTimeout(() => void runner.cancel(), name === 'task-b' ? 600000 : 240000);
    const outcome = await runner.run(prompt, { ephemeral: name !== 'task-b' });
    const record = { name, outcome, ms: Date.now() - start, tools, notices, reviews: host.reviews, commands: host.commands, verified: false };
    results.push(record);
    fs.writeFileSync(path.join(OUTPUT, name + '-events.json'), JSON.stringify(events, null, 2));
    if (outcome.status !== 'done') throw new Error(`${name}: ${outcome.status}: ${outcome.message}`);
    if (!host.reviews.length || !tools.some(t => t.name === 'propose_edit')) throw new Error('No reviewed model edit');
    let verification: string;
    if (name === 'task-b') {
      const changed = [...new Set(host.reviews.map(r => r.path))].filter(p => !fs.existsSync(path.join(ROOT, p)) || fs.readFileSync(path.join(repo, p), 'utf8') !== fs.readFileSync(path.join(ROOT, p), 'utf8'));
      if (changed.length < 3) throw new Error(`Expected at least 3 changed files, got ${changed.length}`);
      if (!tools.some(t => t.name === 'assemble_context')) throw new Error('Context assembly was not used');
      verification = python(repo, ['-m', 'pytest', 'tests/test_cli.py', '-q', '--disable-warnings', '--maxfail=1']);
      verification += '\n' + python(repo, ['-c', `import json\nfrom flask import Flask\nfrom flask.cli import cli\napp = Flask(__name__)\napp.config.update(SECRET_KEY='hidden', db_PASSWORD='hidden', access_token='hidden', api_key='hidden', VISIBLE='shown')\nrunner = app.test_cli_runner()\nhelp_result = runner.invoke(cli, args=['--help'])\nassert help_result.exit_code == 0 and 'config' in help_result.output, help_result.output\nresult = runner.invoke(cli, args=['config'])\nassert result.exit_code == 0, result.output\ndata = json.loads(result.output)\nfor key in ('SECRET_KEY', 'db_PASSWORD', 'access_token', 'api_key'):\n assert data[key] == '***', (key, data[key])\nassert data['VISIBLE'] == 'shown'\nprint('JSON, help listing, case-insensitive masking and visible values verified')`]);
    } else {
      verification = python(repo, ['-c', `import os, inspect, re\nfrom flask.helpers import get_debug_flag\nfor value in ('', '0', 'false', 'FALSE', 'no', 'No', 'off', 'OFF', 'n', 'N'):\n os.environ['FLASK_DEBUG'] = value\n assert get_debug_flag() is False, value\nfor value in ('1', 'true', 'yes'):\n os.environ['FLASK_DEBUG'] = value\n assert get_debug_flag() is True, value\nos.environ.pop('FLASK_DEBUG', None)\nassert get_debug_flag() is False\ndoc = (inspect.getdoc(get_debug_flag) or '').lower()\nfor value in ('0', 'false', 'no', 'off', 'n'):\n assert re.search(r'\\b' + value + r'\\b', doc), ('docstring missing', value)\nassert 'empty' in doc or '\"\"' in doc or "''" in doc, 'docstring must list the empty string'\nprint('14 debug-flag cases and false-value docstring verified')`]);
      if (fallback && (!outcome.usedFallback || !notices.some(n => /Falling back/.test(n)))) throw new Error('Fallback not demonstrated');
    }
    fs.writeFileSync(path.join(OUTPUT, name + '-verification.txt'), verification);
    record.verified = true;
    console.error(`PASS ${name}: ${verification.trim()}`);
  } finally {
    clearTimeout(timer);
    fs.writeFileSync(path.join(OUTPUT, 'results.json'), JSON.stringify(results, null, 2));
    await mcp.stop();
    await conn.client.settings.mcpServers.delete(serverName).catch(() => {});
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes('--free-tier-confirmed')) throw new Error('Confirm the key uses a Free Tier project with billing disabled before running this opt-in test.');
  const only = process.argv.includes('--only') ? arg('--only', '') : '';
  if (only && !['a', 'b', 'c'].includes(only)) throw new Error('--only must be a, b, or c');
  const health = await ping(conn);
  if (!health.ok) throw new Error(health.message);
  if (!fs.existsSync(PYTHON)) throw new Error('Prepare tmp/flask-verification-venv using scripts/flask-test-requirements.txt first.');
  process.env.PATH = path.dirname(PYTHON) + path.delimiter + process.env.PATH;
  fs.mkdirSync(OUTPUT, { recursive: true });
  console.error(`Evidence: ${OUTPUT}`);
  if (!only || only === 'a') await scenario('task-a');
  if (!only || only === 'b') await scenario('task-b');
  if (only && only !== 'c') return;
  const provider = 'anvil-live-dead-' + Math.random().toString(36).slice(2, 10);
  const mock = spawn(process.execPath, [path.resolve('scripts/mock-model.mjs'), '--port', '0', '--fail', '503'], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Failing provider did not start')), 5000);
      mock.once('error', error => { clearTimeout(timeout); reject(error); });
      mock.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('\n')) { clearTimeout(timeout); resolve(Number(new URL(JSON.parse(output.split('\n')[0]).listening).port)); }
      });
    });
    const response = await fetch(TF + '/api/v1/settings/model-providers', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { type: 'custom', name: provider, base_url: `http://127.0.0.1:${port}/v1`, auth: { api_key: 'mock-key' }, models: [{ name: 'dead', model_id: 'dead', properties: { context_length: 128000, max_output_tokens: 8192 } }] } }),
    });
    if (!response.ok) throw new Error('Could not register failing provider: ' + response.status);
    await scenario('task-c', provider + '/dead', MODEL);
  } finally { mock.kill(); await conn.client.settings.modelProviders.delete(provider).catch(() => {}); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
