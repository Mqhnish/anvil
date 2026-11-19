/**
 * The workspace MCP server.
 *
 * TrueForge only connects to *remote* MCP servers (HTTP), so the extension hosts one on 127.0.0.1 and
 * registers it with TrueForge under Settings → Connectors. Every editor capability the agent needs —
 * read, search, symbols, context assembly, propose an edit, run a command — is a tool here, which means
 * the *agent* (running inside TrueForge) decides what to read and change; the extension only renders,
 * reviews and applies.
 *
 * Tool annotations matter: TrueForge gates `@write`/`@destructive` tools behind human approval by default.
 *   - propose_edit  → readOnlyHint:false, destructiveHint:false  (= @write)       → approval → diff review
 *   - run_command   → destructiveHint:true                       (= @destructive) → approval → allow/deny card
 *   - everything else is readOnlyHint:true and runs without pausing.
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { WorkspaceHost } from '../host/types';
import { RepoIndex } from '../context/index';
import { Retriever, renderPack, numbered, type ContextPack } from '../context/retriever';
import { outlineToText } from '../context/outline';
import { computeHunks, applyHunks, unifiedDiff, hunkStats } from '../edit/hunks';
import { applyEditBlocks, EditBlockError } from '../edit/editBlocks';
import { DecisionStore, decisionKey } from '../edit/decisions';
import { estimateTokens, truncateToTokens } from '../util/text';

export interface McpServerEvents {
  onToolCall?(name: string, args: unknown): void;
  onToolResult?(name: string, result: string, durationMs: number): void;
  onContextPack?(pack: ContextPack): void;
}

export interface WorkspaceMcpOptions {
  host: WorkspaceHost;
  index: RepoIndex;
  decisions: DecisionStore;
  port?: number;
  budgetTokens: () => number;
  events?: McpServerEvents;
  /** Shared secret header TrueForge must send (registered as header auth). */
  secret?: string;
}

export const TOOL_NAMES = {
  readFile: 'read_file',
  listDir: 'list_dir',
  search: 'search_workspace',
  symbols: 'find_symbols',
  assemble: 'assemble_context',
  diagnostics: 'get_diagnostics',
  openEditors: 'open_editors',
  proposeEdit: 'propose_edit',
  runCommand: 'run_command',
  gitStatus: 'git_status',
} as const;

/** Read-only tools whose identical repeats within a turn are collapsed (see WorkspaceMcpServer.dedupe). */
const DEDUPE_TOOLS = new Set<string>([TOOL_NAMES.readFile, TOOL_NAMES.listDir, TOOL_NAMES.search, TOOL_NAMES.symbols, TOOL_NAMES.assemble]);
const DEDUPE_MIN_CHARS = 400;

export class WorkspaceMcpServer {
  private httpServer?: http.Server;
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private _port = 0;
  readonly secret: string;
  private readonly retriever: Retriever;
  lastPack?: ContextPack;

  constructor(private readonly opts: WorkspaceMcpOptions) {
    this.secret = opts.secret ?? randomUUID();
    this.retriever = new Retriever(opts.index, opts.host);
  }

  get port(): number { return this._port; }
  get url(): string { return `http://127.0.0.1:${this._port}/mcp`; }

  /**
   * Run the same retrieval as `assemble_context` before the first turn of an agent task, so every task starts from a
   * budgeted, explained context pack whether or not the model chooses to call the tool. Shows the pack card and
   * returns the rendered pack for the request.
   */
  async prepareContext(task: string, token?: { readonly isCancellationRequested: boolean }): Promise<string> {
    const pack = await this.retriever.assemble(task, this.opts.budgetTokens());
    if (token?.isCancellationRequested) return '';
    this.lastPack = pack;
    this.opts.events?.onContextPack?.(pack);
    return renderPack(pack);
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    this.httpServer = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.opts.port ?? 0, '127.0.0.1', () => resolve());
    });
    const addr = this.httpServer.address();
    this._port = typeof addr === 'object' && addr ? addr.port : (this.opts.port ?? 0);
    this.opts.host.log(`[mcp] workspace MCP server listening on ${this.url}`);
  }

  async stop(): Promise<void> {
    for (const t of this.transports.values()) await t.close().catch(() => {});
    this.transports.clear();
    await new Promise<void>(resolve => (this.httpServer ? this.httpServer.close(() => resolve()) : resolve()));
    this.httpServer = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, files: this.opts.index.files.size })); return; }
      if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return; }
      const auth = req.headers['x-anvil-token'];
      if (auth !== this.secret) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad token' })); return; }

      const sid = req.headers['mcp-session-id'];
      let transport = typeof sid === 'string' ? this.transports.get(sid) : undefined;
      if (!transport) {
        if (req.method !== 'POST') { res.writeHead(400); res.end('no session'); return; }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => { this.transports.set(id, transport!); },
        });
        transport.onclose = () => { if (transport?.sessionId) this.transports.delete(transport.sessionId); };
        const server = this.buildServer();
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    } catch (e) {
      this.opts.host.log(`[mcp] request error: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); }
    }
  }

  /**
   * Per-turn memory of read-only tool results, keyed by the turn's abort signal (a new one per turn).
   * A repeat of an identical call whose result is also identical is answered with one line instead of the
   * whole result again: small models loop on the same search, and every repeat is re-sent on each later model
   * call, which is what exhausts per-minute token quotas. Results are compared, not assumed, so a file the user
   * edits mid-turn is still returned in full.
   */
  private readonly seen = new WeakMap<AbortSignal, Map<string, string>>();

  private dedupe(name: string, args: unknown, text: string): string {
    if (text.length < DEDUPE_MIN_CHARS) return text;
    const signal = this.opts.decisions.signal;
    let turn = this.seen.get(signal);
    if (!turn) { turn = new Map(); this.seen.set(signal, turn); }
    const key = name + '\u0000' + JSON.stringify(args ?? {});
    const digest = createHash('sha1').update(text).digest('hex');
    if (turn.get(key) === digest) {
      return `Same result as your earlier identical ${name} call in this turn: nothing has changed, so it is not repeated here. ` +
        'Use that earlier output. If you need something different, change the query, narrow the glob, or read_file the specific lines.';
    }
    turn.set(key, digest);
    return text;
  }

  private text(s: string) { return { content: [{ type: 'text' as const, text: s }] }; }
  private err(s: string) { return { content: [{ type: 'text' as const, text: s }], isError: true }; }

  private buildServer(): McpServer {
    const { host, index, decisions } = this.opts;
    const server = new McpServer({ name: 'anvil-vscode-workspace', version: '0.1.0' }, { capabilities: { tools: {} } });
    const ev = this.opts.events;
    const wrap = <A, R extends { content: { type: 'text'; text: string }[] }>(name: string, fn: (a: A) => Promise<R>) => async (a: A): Promise<R> => {
      const t0 = Date.now();
      ev?.onToolCall?.(name, a);
      try {
        let r = await fn(a);
        if (DEDUPE_TOOLS.has(name) && !(r as { isError?: boolean }).isError) {
          const full = r.content.map(c => c.text).join('\n');
          const out = this.dedupe(name, a, full);
          if (out !== full) r = { ...r, content: [{ type: 'text', text: out }] } as R;
        }
        ev?.onToolResult?.(name, r.content.map(c => c.text).join('\n'), Date.now() - t0);
        return r;
      } catch (e) {
        const msg = `${name} failed: ${(e as Error).message ?? e}`;
        ev?.onToolResult?.(name, msg, Date.now() - t0);
        return this.err(msg) as unknown as R;
      }
    };

    server.registerTool(TOOL_NAMES.readFile, {
      title: 'Read file',
      description: 'Read a workspace file (whole file or a 1-based inclusive line range). Output is line-numbered. Prefer ranges for big files; call find_symbols/assemble_context first to learn where to look.',
      inputSchema: { path: z.string().describe('workspace-relative path'), start_line: z.number().int().optional(), end_line: z.number().int().optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, wrap(TOOL_NAMES.readFile, async ({ path, start_line, end_line }: { path: string; start_line?: number; end_line?: number }) => {
      const content = await host.readFile(path);
      const lines = content.split(/\r?\n/);
      const s = Math.max(1, start_line ?? 1);
      const e = Math.min(lines.length, end_line ?? lines.length);
      const body = numbered(lines.slice(s - 1, e).join('\n'), s);
      const head = `${path} (${lines.length} lines${s !== 1 || e !== lines.length ? `, showing ${s}-${e}` : ''})`;
      return this.text(head + '\n' + truncateToTokens(body, 12000));
    }));

    server.registerTool(TOOL_NAMES.listDir, {
      title: 'List directory',
      description: 'List files and folders under a workspace directory (respects .gitignore). Use depth to expand.',
      inputSchema: { path: z.string().optional().describe('directory, default workspace root'), depth: z.number().int().min(1).max(4).optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, wrap(TOOL_NAMES.listDir, async ({ path, depth }: { path?: string; depth?: number }) => {
      await index.ensure();
      const base = (path ?? '').replace(/^\.\/?/, '').replace(/\/$/, '');
      const d = depth ?? 1;
      const seen = new Set<string>();
      for (const f of index.files.keys()) {
        if (base && !f.startsWith(base + '/')) continue;
        const rest = base ? f.slice(base.length + 1) : f;
        const parts = rest.split('/');
        for (let k = 1; k <= Math.min(d, parts.length); k++) {
          const p = parts.slice(0, k).join('/') + (k < parts.length ? '/' : '');
          seen.add(p);
        }
      }
      const items = [...seen].sort();
      return this.text(`${base || '.'} (${items.length} entries, depth ${d})\n` + items.map(i => '  ' + i).join('\n'));
    }));

    server.registerTool(TOOL_NAMES.search, {
      title: 'Search workspace',
      description: 'Search file contents (plain text or regex) across the workspace. Returns path:line: text matches grouped by file. Use glob to narrow (e.g. "src/**/*.py").',
      inputSchema: { query: z.string(), is_regex: z.boolean().optional(), glob: z.string().optional(), max_results: z.number().int().optional(), case_sensitive: z.boolean().optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, wrap(TOOL_NAMES.search, async ({ query, is_regex, glob, max_results, case_sensitive }: { query: string; is_regex?: boolean; glob?: string; max_results?: number; case_sensitive?: boolean }) => {
      await index.ensure();
      const limit = max_results ?? 60;
      let re: RegExp;
      try { re = new RegExp(is_regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), case_sensitive ? '' : 'i'); } catch (e) { return this.err(`invalid regex: ${(e as Error).message}`); }
      const matcher = glob ? globToRegex(glob) : undefined;
      const out: string[] = [];
      let n = 0;
      let files = 0;
      for (const f of index.files.values()) {
        if (matcher && !matcher.test(f.path)) continue;
        const lines = f.content.split(/\r?\n/);
        let first = true;
        for (let i = 0; i < lines.length && n < limit; i++) {
          if (re.test(lines[i])) {
            if (first) { out.push(f.path); first = false; files++; }
            out.push(`  ${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            n++;
          }
        }
        if (n >= limit) break;
      }
      if (!n) return this.text(`no matches for ${JSON.stringify(query)}${glob ? ' in ' + glob : ''}`);
      return this.text(`${n} match(es) in ${files} file(s)${n >= limit ? ' (truncated)' : ''}:\n` + out.join('\n'));
    }));

    server.registerTool(TOOL_NAMES.symbols, {
      title: 'Find symbols',
      description: 'Find functions/classes/methods by name across the workspace (exact, prefix, substring, or word match). Returns path, kind and line range. Use read_file with the range to see the body.',
      inputSchema: { query: z.string(), limit: z.number().int().optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, wrap(TOOL_NAMES.symbols, async ({ query, limit }: { query: string; limit?: number }) => {
      await index.ensure();
      const res = index.findSymbols(query, limit ?? 30);
      if (!res.length) return this.text(`no symbols matching ${JSON.stringify(query)}`);
      return this.text(res.map(r => `${r.path}:${r.sym.startLine}-${r.sym.endLine}  ${r.sym.kind} ${r.sym.container ? r.sym.container + '.' : ''}${r.sym.name}`).join('\n'));
    }));

    server.registerTool(TOOL_NAMES.assemble, { // see also prepareContext(), which runs the same retrieval up front
      title: 'Assemble context',
      description: 'Build a budgeted context pack for a task: ranks workspace files by lexical relevance (BM25 over symbol-level chunks), path match, open editors, explicit @file/@symbol mentions, and neighbour expansion (tests, docs, imports). Returns the chosen files with REASONS and the relevant symbol bodies, plus what was skipped. Call this FIRST for any task that may touch files you have not seen; then read_file only what the pack did not already include.',
      inputSchema: { task: z.string().describe('the user task, verbatim or paraphrased, including any @mentions'), budget_tokens: z.number().int().optional().describe('token budget; default from settings'), mentions: z.array(z.string()).optional().describe('extra @file or @symbol mentions') },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, wrap(TOOL_NAMES.assemble, async ({ task, budget_tokens, mentions }: { task: string; budget_tokens?: number; mentions?: string[] }) => {
      const pack = await this.retriever.assemble(task, budget_tokens ?? this.opts.budgetTokens(), mentions ?? []);
      this.lastPack = pack;
      ev?.onContextPack?.(pack);
      return this.text(renderPack(pack));
    }));

    server.registerTool(TOOL_NAMES.diagnostics, {
      title: 'Get diagnostics',
      description: 'Current editor diagnostics (errors/warnings from language servers) for one file or the whole workspace.',
      inputSchema: { path: z.string().optional() },
      annotations: { readOnlyHint: true },
    }, wrap(TOOL_NAMES.diagnostics, async ({ path }: { path?: string }) => {
      const d = await host.diagnostics(path);
      if (!d.length) return this.text('no diagnostics');
      return this.text(d.slice(0, 100).map(x => `${x.path}:${x.line} [${x.severity}] ${x.message}${x.source ? ' (' + x.source + ')' : ''}`).join('\n'));
    }));

    server.registerTool(TOOL_NAMES.openEditors, {
      title: 'Open editors',
      description: 'Files currently open in the editor, which one is active, and the active selection. A strong hint about what the user means by "this".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, wrap(TOOL_NAMES.openEditors, async () => {
      const o = await host.openFiles();
      if (!o.length) return this.text('no open editors');
      return this.text(o.map(x => `${x.active ? '* ' : '  '}${x.path}${x.selection ? ` (selection L${x.selection.startLine}-${x.selection.endLine})` : ''}`).join('\n'));
    }));

    server.registerTool(TOOL_NAMES.gitStatus, {
      title: 'Git status',
      description: 'Short git status and the diff stat of the working tree.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, wrap(TOOL_NAMES.gitStatus, async () => {
      const r = await host.runCommand('git status --short && git diff --stat', { timeoutMs: 15000 });
      return this.text((r.stdout || '(clean)') + (r.stderr ? '\n' + r.stderr : ''));
    }));

    server.registerTool(TOOL_NAMES.proposeEdit, {
      title: 'Propose edit',
      description:
        'Propose a change to ONE file. Nothing is written until the user reviews it hunk by hunk in the editor. ' +
        'Provide either `edits` (preferred: a list of exact search/replace blocks; each `old` must appear exactly once in the current file, include a few surrounding lines for uniqueness) ' +
        'or `new_content` (full file; use for new files or small files). Returns which hunks the user accepted/rejected and the resulting diff. ' +
        'If a search block does not match, you get an error with the reason — re-read the file and try again. One call per file.',
      inputSchema: {
        path: z.string().describe('workspace-relative path; a new path creates the file'),
        summary: z.string().describe('one line: what this change does and why'),
        edits: z.array(z.object({ old: z.string(), new: z.string() })).optional(),
        new_content: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, title: 'Propose edit (reviewed hunk-by-hunk)' },
    }, wrap(TOOL_NAMES.proposeEdit, async ({ path, summary, edits, new_content }: { path: string; summary: string; edits?: { old: string; new: string }[]; new_content?: string }) => {
      const signal = decisions.signal;
      signal.throwIfAborted();
      if (!edits?.length && new_content === undefined) return this.err('provide either edits[] or new_content');
      const exists = await host.fileExists(path);
      const oldContent = exists ? await host.readFile(path) : '';
      let proposed: string;
      let notes: string[] = [];
      if (edits?.length) {
        if (!exists) return this.err(`${path} does not exist; use new_content to create it`);
        try { const r = applyEditBlocks(oldContent, edits); proposed = r.content; notes = r.notes; }
        catch (e) { if (e instanceof EditBlockError) return this.err(`${e.message}. Current file is ${oldContent.split(/\r?\n/).length} lines; re-read the relevant region with read_file and resend exact text.`); throw e; }
      } else {
        proposed = new_content!;
      }
      if (proposed === oldContent) return this.text(`no change: proposed content for ${path} is identical to the current file`);

      const set = computeHunks(oldContent, proposed);
      const key = decisionKey(path, oldContent, proposed);
      // 1. Decision already made during TrueForge's approval pause? (normal path)
      let stored = decisions.take(key);
      // 2. Otherwise ask the host to review now (headless auto-accept, or a direct call without approval gate).
      if (!stored) {
        const outcome = await host.reviewEdit({ path, newContent: proposed, summary, signal }, { oldContent, newContent: proposed });
        if (outcome.decision === 'deny') return this.text(`User rejected the change to ${path}${outcome.reason ? ': ' + outcome.reason : ''}. No files were modified. Ask what they want instead or propose a different change.`);
        stored = { key, path, baselineHash: '', proposedHash: '', decisions: outcome.decisions, resultingContent: outcome.resultingContent ?? applyHunks(set, new Set(outcome.decisions.filter(d => d.accepted).map(d => d.index))), createdAt: Date.now() };
      }
      const accepted = new Set(stored.decisions.filter(d => d.accepted).map(d => d.index));
      const resulting = stored.resultingContent ?? applyHunks(set, accepted);
      if (resulting === oldContent) return this.text(`User rejected every hunk for ${path}. No files were modified.`);
      signal.throwIfAborted();
      const stillExists = await host.fileExists(path);
      const current = stillExists ? await host.readFile(path) : '';
      if (stillExists !== exists || current !== oldContent) return this.err(`${path} changed during review. Re-read the file and propose the change again.`);
      signal.throwIfAborted();
      decisions.recordSideEffect();
      await host.applyEdit(path, oldContent, resulting);
      await index.touch(path);
      const rejected = stored.decisions.filter(d => !d.accepted);
      const diff = unifiedDiff(path, oldContent, resulting);
      const lines = [
        `${exists ? 'Applied' : 'Created'} ${path}: ${accepted.size}/${set.hunks.length} hunk(s) accepted by the user${rejected.length ? `, ${rejected.length} rejected` : ''}.`,
        ...notes.map(n => 'note: ' + n),
        ...rejected.map(r => `rejected hunk ${r.index + 1}${r.reason ? ': ' + r.reason : ''} (${describeHunk(set.hunks[r.index])}) — do NOT retry it unless the user asks`),
        'Applied diff:',
        truncateToTokens(diff, 4000),
      ];
      return this.text(lines.join('\n'));
    }));

    server.registerTool(TOOL_NAMES.runCommand, {
      title: 'Run command',
      description: 'Run a shell command in the workspace root (tests, linters, the app). The user must approve it. Output is truncated; prefer focused commands (e.g. `pytest tests/test_cli.py -q`).',
      inputSchema: { command: z.string(), cwd: z.string().optional(), timeout_sec: z.number().int().min(1).max(600).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }, wrap(TOOL_NAMES.runCommand, async ({ command, cwd, timeout_sec }: { command: string; cwd?: string; timeout_sec?: number }) => {
      // Approved already during TrueForge's approval pause? Otherwise ask now.
      const signal = decisions.signal;
      signal.throwIfAborted();
      const ok = decisions.takeCommandApproval(command, cwd) ? { allow: true } : await host.confirmCommand(command, cwd);
      if (!ok.allow) return this.text(`User declined to run: ${command}${'reason' in ok && ok.reason ? ' — ' + ok.reason : ''}`);
      signal.throwIfAborted();
      decisions.recordSideEffect();
      const r = await host.runCommand(command, { cwd, signal, timeoutMs: (timeout_sec ?? 120) * 1000 });
      const body = [`$ ${command}`, `exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''} in ${r.durationMs}ms`, r.stdout ? 'stdout:\n' + r.stdout : '', r.stderr ? 'stderr:\n' + r.stderr : ''].filter(Boolean).join('\n');
      return this.text(truncateToTokens(body, 6000));
    }));

    return server;
  }
}

function describeHunk(h: { oldStart: number; oldLines: number } | undefined): string {
  if (!h) return '';
  return `lines ${h.oldStart}-${h.oldStart + Math.max(0, h.oldLines - 1)}`;
}

export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = glob.indexOf('}', i); if (j > 0) { re += '(' + glob.slice(i + 1, j).split(',').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j; } else re += '\\{'; }
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export { hunkStats, estimateTokens };
