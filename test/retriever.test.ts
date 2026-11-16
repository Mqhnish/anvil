/**
 * Retrieval tests against a small synthetic repo (always) and, when available, the pinned pallets/flask
 * checkout at ../flask (the competition repository) — so we can assert Task B finds cli.py, test_cli.py
 * and docs/cli.rst without the user naming them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HeadlessHost } from '../src/host/headlessHost';
import { RepoIndex } from '../src/context/index';
import { Retriever } from '../src/context/retriever';
import { parseMentions, resolveMentions } from '../src/context/mentions';
import { outlineFile } from '../src/context/outline';

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-repo-'));
  const w = (p: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); };
  w('.gitignore', 'build/\n*.log\n');
  w('src/app/cli.py', `import click\nfrom app.config import load_config\n\n@click.command("routes")\ndef routes_command():\n    """Show the routes."""\n    print("routes")\n\n\ndef register_commands(group):\n    group.add_command(routes_command)\n`);
  w('src/app/config.py', `import json\n\n\ndef load_config(path):\n    with open(path) as f:\n        return json.load(f)\n\n\nclass Config(dict):\n    def mask(self):\n        return {k: "***" if "SECRET" in k else v for k, v in self.items()}\n`);
  w('src/app/helpers.py', `import os\n\n\ndef get_debug_flag() -> bool:\n    val = os.environ.get("APP_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n`);
  w('tests/test_cli.py', `from app.cli import routes_command\n\n\ndef test_routes(runner):\n    assert runner.invoke(routes_command).exit_code == 0\n`);
  w('docs/cli.rst', 'Command Line Interface\n======================\n\nBuilt-in commands\n-----------------\n\n``routes`` shows the routes.\n');
  w('README.md', '# app\n');
  w('build/out.txt', 'ignored');
  w('debug.log', 'ignored');
  return dir;
}

describe('retriever on a synthetic repo', () => {
  let dir: string; let index: RepoIndex; let host: HeadlessHost;
  beforeAll(async () => { dir = mkRepo(); host = new HeadlessHost(dir, { log: () => {} }); index = new RepoIndex(host); await index.ensure(); });

  it('respects .gitignore', async () => {
    const files = await host.listFiles();
    expect(files).toContain('src/app/cli.py');
    expect(files).not.toContain('build/out.txt');
    expect(files).not.toContain('debug.log');
  });

  it('outlines python symbols', () => {
    const o = outlineFile('x.py', fs.readFileSync(path.join(dir, 'src/app/config.py'), 'utf8'));
    expect(o.map(s => s.name)).toEqual(['load_config', 'Config', 'mask']);
    expect(o[2].container).toBe('Config');
  });

  it('finds the CLI registration, its tests and docs for an unnamed multi-file task', async () => {
    const pack = await new Retriever(index, host).assemble('Add a new built-in CLI command `app config` that prints the loaded configuration as JSON masking SECRET keys. It must appear in --help, be covered by a test, and be documented alongside the other built-in commands.', 6000);
    const paths = pack.chosen.map(c => c.path);
    expect(paths).toContain('src/app/cli.py');
    expect(paths).toContain('src/app/config.py');
    expect(paths).toContain('tests/test_cli.py');
    expect(paths).toContain('docs/cli.rst');
    expect(pack.usedTokens).toBeLessThanOrEqual(6000);
    for (const c of pack.chosen) expect(c.reason.length).toBeGreaterThan(5);
  });

  it('honours the token budget and reports skipped files', async () => {
    const pack = await new Retriever(index, host).assemble('config cli routes helpers debug flag docs tests', 300);
    expect(pack.usedTokens).toBeLessThanOrEqual(300);
    expect(pack.chosen.length).toBeGreaterThan(0);
    expect(pack.skipped.length).toBeGreaterThan(0);
  });

  it('resolves @file and @symbol mentions', () => {
    expect(parseMentions('look at @src/app/cli.py and @get_debug_flag plus @config.py:1-3')).toEqual(['src/app/cli.py', 'get_debug_flag', 'config.py:1-3']);
    const r = resolveMentions(index, ['cli.py', 'get_debug_flag', 'Config.mask', 'config.py:1-3', 'nope']);
    expect(r[0].path).toBe('src/app/cli.py');
    expect(r[1].path).toBe('src/app/helpers.py');
    expect(r[1].symbol).toBe('get_debug_flag');
    expect(r[2].symbol).toBe('Config.mask');
    expect(r[3].range).toEqual({ startLine: 1, endLine: 3 });
    expect(r[4].note).toBe('unresolved');
  });

  it('puts mentioned files first with full content', async () => {
    const pack = await new Retriever(index, host).assemble('Explain @helpers.py', 4000);
    expect(pack.chosen[0].path).toBe('src/app/helpers.py');
    expect(pack.chosen[0].mode).toBe('full');
  });
});

const FLASK = path.resolve(__dirname, '..', '..', 'flask');
const hasFlask = fs.existsSync(path.join(FLASK, 'src', 'flask', 'cli.py'));

describe.skipIf(!hasFlask)('retriever on pallets/flask 3.1.3 (Task B)', () => {
  let index: RepoIndex; let host: HeadlessHost;
  beforeAll(async () => { host = new HeadlessHost(FLASK, { log: () => {} }); index = new RepoIndex(host); await index.ensure(); }, 60000);

  it('indexes the repo quickly', () => {
    expect(index.files.size).toBeGreaterThan(80);
  });

  it('Task B: discovers cli.py, test_cli.py and docs/cli.rst without being told', async () => {
    const task = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
    const pack = await new Retriever(index, host).assemble(task, 12000);
    const paths = pack.chosen.map(c => c.path);
    expect(paths).toContain('src/flask/cli.py');
    expect(paths).toContain('tests/test_cli.py');
    expect(paths).toContain('docs/cli.rst');
    expect(pack.usedTokens).toBeLessThanOrEqual(12000);
    // the registration pattern (routes_command / add_command) should be inside the chosen cli.py ranges
    const cli = pack.chosen.find(c => c.path === 'src/flask/cli.py')!;
    expect(cli.text).toMatch(/routes_command|add_command/);
  });

  it('Task A: resolves @get_debug_flag to helpers.py', () => {
    const r = resolveMentions(index, ['get_debug_flag']);
    expect(r[0].path).toBe('src/flask/helpers.py');
    expect(r[0].range?.startLine).toBe(28);
  });
});
