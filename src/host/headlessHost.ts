/**
 * HeadlessHost — the WorkspaceHost over a plain directory. Used by:
 *   - scripts/headless-e2e.mjs  (TrueForge ⇄ MCP ⇄ mock model, no VS Code)
 *   - unit tests for the retriever on the real pallets/flask checkout
 *   - `node dist/headless.js assemble "<task>"` to print a context pack while writing the write-up
 *
 * Review policy is configurable: auto-accept everything, reject everything, or accept the first N hunks.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ignore from 'ignore';
import type { WorkspaceHost, FileStat, DirEntry, SymbolInfo, Diagnostic, CommandResult, ProposeEditRequest, ReviewOutcome } from './types';
import { outlineFile } from '../context/outline';
import { computeHunks, applyHunks } from '../edit/hunks';
import { decisionKey } from '../edit/decisions';
import { isProbablyBinary, toPosix } from '../util/text';

const DEFAULT_IGNORES = ['.git', 'node_modules', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.idea', '.vscode-test', 'coverage', '.DS_Store', '*.pyc', '*.min.js', '*.map', '*.lock', 'package-lock.json', 'pnpm-lock.yaml'];

export interface HeadlessHostOptions {
  reviewPolicy?: 'accept-all' | 'reject-all' | ((req: ProposeEditRequest, hunkCount: number) => Set<number>);
  commandPolicy?: 'allow' | 'deny';
  log?: (m: string) => void;
}

export class HeadlessHost implements WorkspaceHost {
  readonly kind = 'headless' as const;
  readonly rootPath: string;
  private ig = ignore();
  private igLoaded = false;
  readonly reviews: { path: string; accepted: number[]; total: number }[] = [];
  readonly commands: string[] = [];

  constructor(rootPath: string, private readonly opts: HeadlessHostOptions = {}) {
    this.rootPath = path.resolve(rootPath);
  }

  private abs(rel: string): string {
    const p = path.resolve(this.rootPath, rel);
    if (!p.startsWith(this.rootPath)) throw new Error(`path escapes workspace: ${rel}`);
    return p;
  }

  private async loadIgnore(): Promise<void> {
    if (this.igLoaded) return;
    this.ig = ignore().add(DEFAULT_IGNORES);
    try { this.ig.add(await fs.readFile(path.join(this.rootPath, '.gitignore'), 'utf8')); } catch { /* none */ }
    this.igLoaded = true;
  }

  async listFiles(): Promise<string[]> {
    await this.loadIgnore();
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fssync.Dirent[];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = toPosix(path.relative(this.rootPath, abs));
        if (this.ig.ignores(e.isDirectory() ? rel + '/' : rel)) continue;
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) out.push(rel);
      }
    };
    await walk(this.rootPath);
    return out.sort();
  }

  async readFile(rel: string): Promise<string> {
    const buf = await fs.readFile(this.abs(rel));
    if (isProbablyBinary(buf)) throw new Error(`${rel} is binary`);
    return buf.toString('utf8');
  }
  async writeFile(rel: string, content: string): Promise<void> {
    const p = this.abs(rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }
  async fileExists(rel: string): Promise<boolean> { try { return (await fs.stat(this.abs(rel))).isFile(); } catch { return false; } }
  async stat(rel: string): Promise<FileStat> { const s = await fs.stat(this.abs(rel)); return { size: s.size, isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }; }
  async listDir(rel: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(this.abs(rel || '.'), { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
  }
  async documentSymbols(rel: string): Promise<SymbolInfo[]> { return outlineFile(rel, await this.readFile(rel)); }
  async diagnostics(): Promise<Diagnostic[]> { return []; }
  async openFiles(): Promise<{ path: string; active: boolean }[]> { return []; }

  runCommand(command: string, opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    this.commands.push(command);
    const t0 = Date.now();
    return new Promise(resolve => {
      const child = spawn(command, { shell: true, cwd: opts.cwd ? this.abs(opts.cwd) : this.rootPath, env: { ...process.env } });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs ?? 120000);
      child.stdout.on('data', d => { stdout += d; if (stdout.length > 200000) stdout = stdout.slice(-200000); });
      child.stderr.on('data', d => { stderr += d; if (stderr.length > 100000) stderr = stderr.slice(-100000); });
      opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'));
      child.on('close', code => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - t0 }); });
    });
  }

  async reviewEdit(req: ProposeEditRequest, prev: { oldContent: string; newContent: string }): Promise<ReviewOutcome> {
    const set = computeHunks(prev.oldContent, prev.newContent);
    const policy = this.opts.reviewPolicy ?? 'accept-all';
    let accepted: Set<number>;
    if (policy === 'accept-all') accepted = new Set(set.hunks.map(h => h.index));
    else if (policy === 'reject-all') accepted = new Set();
    else accepted = policy(req, set.hunks.length);
    this.reviews.push({ path: req.path, accepted: [...accepted], total: set.hunks.length });
    const decisions = set.hunks.map(h => ({ index: h.index, accepted: accepted.has(h.index) }));
    const key = decisionKey(req.path, prev.oldContent, prev.newContent);
    if (!accepted.size) return { decision: 'deny', decisions, key, reason: 'headless policy rejected all hunks' };
    return { decision: 'allow', decisions, key, resultingContent: applyHunks(set, accepted) };
  }

  async applyEdit(rel: string, _old: string, resulting: string): Promise<void> { await this.writeFile(rel, resulting); }

  async confirmCommand(): Promise<{ allow: boolean; reason?: string }> {
    return (this.opts.commandPolicy ?? 'allow') === 'allow' ? { allow: true } : { allow: false, reason: 'headless policy' };
  }

  async askQuestion(_q: string, options: string[]): Promise<string> { return options[0] ?? 'yes'; }

  log(m: string): void { (this.opts.log ?? ((s: string) => console.error(s)))(m); }
}
