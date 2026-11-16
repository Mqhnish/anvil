/**
 * RepoIndex: an in-memory, incrementally refreshed index of the workspace for retrieval.
 *
 *  - file list (gitignore-aware, size/binary filtered)
 *  - per file: content, regex outline, symbol-level chunks, identifier term frequencies
 *  - BM25 over chunks, plus a path-term index and an import graph (python / js-ts)
 *
 * Everything is cheap enough to build for a ~20k-line repo in well under a second and is refreshed
 * per file on mtime change, so the agent always retrieves against the current working tree.
 */
import type { WorkspaceHost, SymbolInfo } from '../host/types';
import { outlineFile } from './outline';
import { estimateTokens, queryTerms, splitIdentifier, stem } from '../util/text';

export interface Chunk {
  id: number;
  path: string;
  symbol?: string; // qualified symbol name when the chunk is a symbol body
  kind?: string;
  startLine: number; // 1-based inclusive
  endLine: number;
  text: string;
  tokens: number;
  tf: Map<string, number>;
  len: number; // term count
}

export interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
  content: string;
  lines: number;
  tokens: number;
  outline: SymbolInfo[];
  chunks: Chunk[];
  pathTerms: string[];
  imports: string[]; // resolved relative paths
}

const MAX_FILE_BYTES = 400_000;
const CHUNK_LINES = 60;

function termsOf(text: string): string[] {
  const out: string[] = [];
  // identifiers and words
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const parts = splitIdentifier(m[0]);
    if (parts.length > 1) out.push(stem(m[0].toLowerCase()));
    for (const p of parts) if (p.length >= 2) out.push(stem(p));
  }
  return out;
}

function pathTermsOf(path: string): string[] {
  const out = new Set<string>();
  for (const seg of path.split('/')) {
    const base = seg.replace(/\.[^.]+$/, '');
    for (const p of splitIdentifier(base)) if (p.length >= 2) out.add(stem(p));
    if (base) out.add(stem(base.toLowerCase()));
  }
  return [...out];
}

function parseImports(path: string, content: string): string[] {
  const out = new Set<string>();
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext === 'py') {
    const re = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const mod = (m[1] ?? m[2]).replace(/^\.+/, '');
      if (mod) out.add('py:' + mod);
    }
  } else if (ext && /^(ts|tsx|js|jsx|mjs|cjs|mts)$/.test(ext)) {
    const re = /(?:from\s+|import\s*\(?\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) out.add('rel:' + m[1]);
  }
  return [...out];
}

export class RepoIndex {
  readonly files = new Map<string, FileEntry>();
  private chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private built = false;
  private building: Promise<void> | undefined;
  private pyModuleToPath = new Map<string, string>();

  constructor(private readonly host: WorkspaceHost, private readonly maxFiles = 4000) {}

  get isBuilt(): boolean { return this.built; }
  get chunkCount(): number { return this.chunks.length; }

  async ensure(): Promise<void> {
    if (this.building) return this.building;
    this.building = this.refresh().finally(() => { this.building = undefined; });
    return this.building;
  }

  /** Full refresh: re-list files and re-index those whose mtime changed. */
  async refresh(): Promise<void> {
    const t0 = Date.now();
    const list = (await this.host.listFiles()).slice(0, this.maxFiles);
    const seen = new Set<string>();
    let changed = 0;
    await Promise.all(list.map(async rel => {
      seen.add(rel);
      let st;
      try { st = await this.host.stat(rel); } catch { return; }
      if (st.isDirectory || st.size > MAX_FILE_BYTES) return;
      const prev = this.files.get(rel);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return;
      let content: string;
      try { content = await this.host.readFile(rel); } catch { return; }
      if (content.includes('\u0000')) return;
      this.files.set(rel, this.indexFile(rel, content, st.mtimeMs, st.size));
      changed++;
    }));
    for (const p of [...this.files.keys()]) if (!seen.has(p)) { this.files.delete(p); changed++; }
    if (changed || !this.built) this.rebuildStats();
    this.built = true;
    this.host.log(`[index] ${this.files.size} files, ${this.chunks.length} chunks, ${changed} (re)indexed in ${Date.now() - t0}ms`);
  }

  /** Re-index a single file (e.g. on save). */
  async touch(rel: string): Promise<void> {
    try {
      const st = await this.host.stat(rel);
      const content = await this.host.readFile(rel);
      this.files.set(rel, this.indexFile(rel, content, st.mtimeMs, st.size));
    } catch {
      this.files.delete(rel);
    }
    this.rebuildStats();
  }

  private indexFile(rel: string, content: string, mtimeMs: number, size: number): FileEntry {
    const outline = outlineFile(rel, content);
    const lines = content.split(/\r?\n/);
    const chunks: Chunk[] = [];
    const pushChunk = (startLine: number, endLine: number, symbol?: string, kind?: string) => {
      const text = lines.slice(startLine - 1, endLine).join('\n');
      if (!text.trim()) return;
      const terms = termsOf(text);
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      chunks.push({ id: 0, path: rel, symbol, kind, startLine, endLine, text, tokens: estimateTokens(text), tf, len: terms.length || 1 });
    };
    // symbol-level chunks for top-level symbols; split very long ones
    const top = outline.filter(s => !s.container);
    if (top.length) {
      let cursor = 1;
      for (const s of top) {
        if (s.startLine > cursor + 2) pushChunk(cursor, s.startLine - 1); // preamble / between-symbol code
        const span = s.endLine - s.startLine + 1;
        if (span > CHUNK_LINES * 2) {
          for (let a = s.startLine; a <= s.endLine; a += CHUNK_LINES) pushChunk(a, Math.min(s.endLine, a + CHUNK_LINES - 1), s.name + (a === s.startLine ? '' : ' (cont.)'), s.kind);
        } else {
          pushChunk(s.startLine, s.endLine, s.name, s.kind);
        }
        cursor = s.endLine + 1;
      }
      if (cursor <= lines.length) pushChunk(cursor, lines.length);
    } else {
      for (let a = 1; a <= lines.length; a += CHUNK_LINES) pushChunk(a, Math.min(lines.length, a + CHUNK_LINES - 1));
    }
    return {
      path: rel, mtimeMs, size, content, lines: lines.length, tokens: estimateTokens(content), outline, chunks,
      pathTerms: pathTermsOf(rel), imports: parseImports(rel, content),
    };
  }

  private rebuildStats(): void {
    this.chunks = [];
    this.df = new Map();
    this.pyModuleToPath = new Map();
    let totalLen = 0;
    let id = 0;
    for (const f of this.files.values()) {
      // python module name: src/flask/cli.py -> flask.cli ; flask/cli.py -> flask.cli
      if (f.path.endsWith('.py')) {
        const mod = f.path.replace(/^src\//, '').replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
        this.pyModuleToPath.set(mod, f.path);
      }
      for (const c of f.chunks) {
        c.id = id++;
        this.chunks.push(c);
        totalLen += c.len;
        for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
    this.avgLen = this.chunks.length ? totalLen / this.chunks.length : 1;
  }

  /** Resolve a file's imports to workspace paths. */
  resolveImports(f: FileEntry): string[] {
    const out = new Set<string>();
    for (const imp of f.imports) {
      if (imp.startsWith('py:')) {
        const mod = imp.slice(3);
        const direct = this.pyModuleToPath.get(mod);
        if (direct) { out.add(direct); continue; }
        // from flask.helpers import x  -> flask.helpers ; from flask import helpers -> try flask.helpers? we only resolve module itself
        const parts = mod.split('.');
        for (let k = parts.length; k > 0; k--) {
          const p = this.pyModuleToPath.get(parts.slice(0, k).join('.'));
          if (p) { out.add(p); break; }
        }
      } else if (imp.startsWith('rel:')) {
        const spec = imp.slice(4);
        const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        const base = normalizePath(dir + '/' + spec);
        for (const cand of [base, base + '.ts', base + '.tsx', base + '.js', base + '.jsx', base + '/index.ts', base + '/index.js', base + '.mjs']) {
          if (this.files.has(cand)) { out.add(cand); break; }
        }
      }
    }
    out.delete(f.path);
    return [...out];
  }

  /** BM25 scores for a query over all chunks. */
  scoreChunks(query: string, k1 = 1.4, b = 0.75): { chunk: Chunk; score: number; matched: string[] }[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const N = this.chunks.length || 1;
    const results: { chunk: Chunk; score: number; matched: string[] }[] = [];
    for (const c of this.chunks) {
      let s = 0;
      const matched: string[] = [];
      for (const t of terms) {
        const f = c.tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / this.avgLen)));
        matched.push(t);
      }
      if (s > 0) results.push({ chunk: c, score: s, matched });
    }
    results.sort((a, b2) => b2.score - a.score);
    return results;
  }

  findSymbols(query: string, limit = 30): { path: string; sym: SymbolInfo; score: number }[] {
    const q = query.toLowerCase();
    const qs = splitIdentifier(query).map(stem);
    const out: { path: string; sym: SymbolInfo; score: number }[] = [];
    for (const f of this.files.values()) {
      for (const s of f.outline) {
        const name = s.name.toLowerCase();
        let score = 0;
        if (name === q) score = 100;
        else if (name.startsWith(q)) score = 60;
        else if (name.includes(q)) score = 40;
        else {
          const parts = splitIdentifier(s.name).map(stem);
          const hit = qs.filter(t => parts.includes(t)).length;
          if (hit) score = 10 * hit;
        }
        if (score) out.push({ path: f.path, sym: s, score });
      }
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out.slice(0, limit);
  }

  /** Files whose path matches the query terms, with the matching terms. */
  pathMatchTerms(query: string): Map<string, string[]> {
    const terms = queryTerms(query);
    const out = new Map<string, string[]>();
    for (const f of this.files.values()) {
      const hit = terms.filter(t => f.pathTerms.includes(t));
      if (hit.length) out.set(f.path, hit);
    }
    return out;
  }
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
