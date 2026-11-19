#!/usr/bin/env node
// Drive Anvil's real Extension Host against a disposable workspace and scripted model.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = process.env.ANVIL_TEST_TRUEFORGE_URL ?? 'http://127.0.0.1:8790';
// On Windows `code` is a .cmd wrapper that spawn() cannot start; launch Code.exe directly, as VS Code's own test runner does.
const defaultCode = process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
  : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe') : 'code';
const code = process.env.ANVIL_CODE_BIN ?? defaultCode;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'anvil-editor-'));
const workspace = path.join(temp, 'workspace');
const provider = 'editor-test-' + path.basename(temp).slice(-6).toLowerCase();
let mock, editor;
let succeeded = false;

try {
  const health = await fetch(base + '/api/v1/capabilities', { signal: AbortSignal.timeout(4000) });
  if (!health.ok) throw new Error('TrueForge is not ready at ' + base);
  mock = spawn(process.execPath, [path.join(root, 'scripts/mock-model.mjs'), '--port', '0', '--multi-hunk'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const freePort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mock model did not start')), 5000);
    const lines = readline.createInterface({ input: mock.stdout });
    lines.on('line', line => { if (line.includes('"listening"')) { clearTimeout(timer); lines.close(); resolve(Number(new URL(JSON.parse(line).listening).port)); } });
    mock.once('error', reject);
    mock.once('exit', code => { clearTimeout(timer); reject(new Error('Mock model exited: ' + code)); });
  });
  const registered = await fetch(base + '/api/v1/settings/model-providers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: { type: 'custom', name: provider, base_url: `http://127.0.0.1:${freePort}/v1`, auth: { api_key: 'mock-key' }, models: [{ name: 'mock-coder', model_id: 'mock-coder', properties: { context_length: 128000, max_output_tokens: 8192 } }] } }) });
  if (!registered.ok) throw new Error('Could not register the test model: ' + registered.status);
  await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await fs.mkdir(path.join(temp, 'userdata/User'), { recursive: true });
  await fs.writeFile(path.join(temp, 'userdata/User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'diffEditor.codeLens': true }));
  await fs.writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'anvil.trueforge.baseUrl': base, 'anvil.model.primary': provider + '/mock-coder', 'anvil.mcp.serverName': provider, 'anvil.agent.subagents': false }));
  await fs.writeFile(path.join(workspace, 'sample.py'), Array.from({ length: 60 }, (_, i) => '# sample line ' + String(i).padStart(2, '0')).join('\n') + '\n');
  console.log('Disposable editor workspace: ' + workspace);
  const exitCode = await new Promise((resolve, reject) => {
    editor = spawn(code, ['--wait', '--new-window', '--disable-extensions', '--user-data-dir', path.join(temp, 'userdata'), '--extensions-dir', path.join(temp, 'extensions'), '--extensionDevelopmentPath=' + root, '--extensionTestsPath=' + path.join(root, 'dist/editorTests.js'), workspace], { stdio: 'inherit' });
    const timer = setTimeout(() => { editor.kill(); reject(new Error('Editor tests exceeded 120 seconds')); }, 120000);
    editor.once('error', e => { clearTimeout(timer); reject(e); });
    editor.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const report = JSON.parse(await fs.readFile(path.join(workspace, 'editor-test-results.json'), 'utf8'));
  console.log(JSON.stringify(report, null, 2));
  if (exitCode !== 0 || report.passed !== 5) throw new Error('Editor tests failed; inspect logs in ' + temp);
  const evidence = path.join(root, 'output/verification');
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, 'editor-results.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), ...report }, null, 2));
  succeeded = true;
} finally {
  mock?.kill();
  await fetch(base + '/api/v1/settings/mcp-servers/' + provider, { method: 'DELETE' }).catch(() => {});
  await fetch(base + '/api/v1/settings/model-providers/' + provider, { method: 'DELETE' }).catch(() => {});
  if (succeeded) await fs.rm(temp, { recursive: true, force: true });
}
