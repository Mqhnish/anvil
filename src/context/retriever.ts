/**
 * Context assembly: turn a task description (+ explicit @mentions, + what's open in the editor) into a
 * budgeted "context pack" — the files/symbols the model should see, each with a reason and a token cost.
 *
 * Signals, combined into one score per file:
 *   1. explicit @file / @symbol mentions                     (always included, first)
 *   2. BM25 over symbol-level chunks for the task's terms    (semantic-ish lexical retrieval)
 *   3. path-term match (task mentions "cli" -> src/flask/cli.py)
 *   4. open editors / active selection                        (what the user is looking at)
 *   5. neighbour expansion: tests + docs that mirror a chosen source file, and files it imports
 *
 * Packing is budgeted in tokens: mentioned files get their full body when it fits, otherwise their
 * matching symbols; retrieved files get only their matching symbol bodies; everything else that was
 * considered is listed as "skipped" so the agent (and the judge) can see what was left out and why.
 */
import type { RepoIndex, FileEntry, Chunk } from './index';
import type { WorkspaceHost } from '../host/types';
import { estimateTokens, queryTerms, splitIdentifier, stem } from '../util/text';
import { outlineToText } from './outline';
import { parseMentions, resolveMentions, type ResolvedMention } from './mentions';

export interface PackItem {
  path: string;
  reason: string;
  score: number;
  /** 'full' | 'symbols' | 'outline' */
  mode: 'full' | 'symbols' | 'outline';
  ranges: { startLine: number; endLine: number; symbol?: string }[];
  tokens: number;
  text: string;
}

export interface ContextPack {
  task: string;
  budgetTokens: number;
  usedTokens: number;
  chosen: PackItem[];
  skipped: { path: string; reason: string; score: number }[];
  candidatesConsidered: number;
  mentions: ResolvedMention[];
  tookMs: number;
}

interface Cand {
  path: string;
  score: number;
  reasons: string[];
  chunks: Map<number, { chunk: Chunk; score: number; matched: string[] }>;
  mentioned?: ResolvedMention[];
}

const TEST_PATTERNS = (p: string): string[] => {
  const base = p.split('/').pop() ?? p;
  const stem = base.replace(/\.[^.]+$/, '');
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
  return [
    `tests/test_${stem}.py`, `test/test_${stem}.py`, `tests/${stem}_test.py`,
    `tests/test_${stem}${ext}`, `${stem}.test${ext}`, `${stem}.spec${ext}`, `${stem}_test${ext}`,
    `src/${stem}.test${ext}`, `test/${stem}.test${ext}`, `__tests__/${stem}.test${ext}`,
  ];
};
const DOC_PATTERNS = (p: string): string[] => {
  const base = (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');
  return [`docs/${base}.rst`, `docs/${base}.md`, `doc/${base}.md`, `docs/api/${base}.md`, `docs/${base}/index.md`];
};

export class Retriever {
  constructor(private readonly index: RepoIndex, private readonly host: WorkspaceHost) {}

  async assemble(task: string, budgetTokens: number, extraMentions: string[] = []): Promise<ContextPack> {
    const t0 = Date.now();
    await this.index.ensure();
    const mentionsRaw = [...parseMentions(task), ...extraMentions.map(m => m.replace(/^@/, ''))];
    const mentions = resolveMentions(this.index, mentionsRaw);
    const cands = new Map<string, Cand>();
    const cand = (path: string): Cand => {
      let c = cands.get(path);
      if (!c) { c = { path, score: 0, reasons: [], chunks: new Map() }; cands.set(path, c); }
      return c;
    };

    // 0. paths written out in the task without an @ (e.g. "edit src/flask/helpers.py") count as mentions too
    for (const tok of task.match(/[\w.-]+(?:\/[\w.-]+)+\.\w{1,8}/g) ?? []) {
      const hit = this.index.files.has(tok) ? tok : [...this.index.files.keys()].find(p => p.endsWith('/' + tok));
      if (hit && !mentions.some(m => m.path === hit)) mentions.push({ raw: tok, path: hit, note: 'path named in task' });
    }
    // 1. explicit mentions
    for (const m of mentions) {
      if (!m.path) continue;
      const c = cand(m.path);
      c.score += 1000;
      c.reasons.push(m.symbol ? `@${m.raw} → symbol ${m.symbol}` : `@${m.raw} mentioned explicitly`);
      (c.mentioned ??= []).push(m);
    }

    // 2. BM25 over chunks
    const scored = this.index.scoreChunks(task);
    const top = scored.slice(0, 120);
    const maxScore = top[0]?.score ?? 1;
    const isAux = (p: string) => /(^|\/)(tests?|docs?|examples?)\//.test(p) || /^(CHANGES|CHANGELOG|README)/i.test(p);
    for (const r of top) {
      const c = cand(r.chunk.path);
      let norm = (r.score / maxScore) * 10;
      // Source files are what we edit; tests/docs/changelogs mostly enter via neighbour expansion below.
      if (isAux(r.chunk.path)) norm *= 0.6;
      // file score = max chunk + small bonus for additional good chunks
      c.score = Math.max(c.score, (c.mentioned ? 1000 : 0) + norm) + (c.chunks.size ? norm * 0.15 : 0);
      c.chunks.set(r.chunk.id, r);
    }
    // Symbol-name agreement: a query term that is part of a symbol name in the file (e.g. "command" ↔ run_command)
    // is a much stronger signal than the same word inside a docstring.
    const qTerms = new Set(queryTerms(task));
    // Rarity weight per term across files (symbol names + path parts): "flask" or "test" are everywhere and
    // say nothing; "command" or "config" are rare and decisive.
    const termFiles = new Map<string, number>();
    for (const f of this.index.files.values()) {
      const seen = new Set<string>([...f.pathTerms]);
      for (const s of f.outline) for (const t of splitIdentifier(s.name).map(stem)) seen.add(t);
      for (const t of seen) if (qTerms.has(t)) termFiles.set(t, (termFiles.get(t) ?? 0) + 1);
    }
    const nFiles = Math.max(1, this.index.files.size);
    const rarity = (t: string) => { const df = termFiles.get(t) ?? 0; return Math.max(0, 1 - (df / nFiles) * 4); };
    const STRUCTURAL = new Set(['test', 'doc', 'document', 'file', 'src', 'index', 'init', 'main']);
    for (const c of cands.values()) {
      const f = this.index.files.get(c.path);
      if (!f) continue;
      const hits = new Map<string, number>();
      for (const s of f.outline) for (const t of splitIdentifier(s.name).map(stem)) if (qTerms.has(t) && !STRUCTURAL.has(t)) hits.set(t, rarity(t));
      const w = [...hits.values()].reduce((a, b) => a + b, 0);
      if (w > 0) { c.score += Math.min(6, w) * (isAux(c.path) ? 0.8 : 1.6); c.reasons.push(`symbol names match (${[...hits.keys()].slice(0, 4).join(', ')})`); }
      if (c.chunks.size) {
        const best = [...c.chunks.values()].sort((a, b) => b.score - a.score)[0];
        const terms = [...new Set(best.matched)].slice(0, 5).join(', ');
        c.reasons.push(`matches task terms (${terms}) in ${best.chunk.symbol ? best.chunk.kind + ' ' + best.chunk.symbol : 'lines ' + best.chunk.startLine + '-' + best.chunk.endLine}`);
      }
    }

    // 3. path-term match (rarity-weighted: "cli" in src/flask/cli.py counts, "flask" in every path does not)
    for (const [path, terms] of this.index.pathMatchTerms(task)) {
      const c = cand(path);
      const w = terms.filter(t => !STRUCTURAL.has(t)).reduce((a, t) => a + rarity(t), 0);
      if (w <= 0) continue;
      c.score += 3 * w;
      c.reasons.push(`path matches (${terms.filter(t => !STRUCTURAL.has(t)).join(', ')})`);
    }

    // 3b. Extension points. "Add a new built-in CLI command …" should start from the source file that already holds
    // several of that kind of thing (run_command, shell_command, routes_command): the new one is defined and
    // registered there, and its siblings are the pattern to copy. Kind terms come from the words after the verb.
    const addPhrase = /\b(?:add|create|implement|introduce|register)\b((?:[\s-]+[A-Za-z_]+){1,8})/i.exec(task);
    let extension: { c: Cand; boost: number } | undefined;
    if (addPhrase) {
      const kinds = [...new Set(queryTerms(addPhrase[1]))].filter(k => !STRUCTURAL.has(k) && rarity(k) >= 0.5);
      let best: { path: string; kind: string; names: string[] } | undefined;
      for (const f of this.index.files.values()) {
        if (isAux(f.path)) continue;
        for (const k of kinds) {
          // Top-level definitions named like the kind (run_command, shell_command) are the clearest examples: list them
          // first, then other top-level matches, then methods.
          const namedLikeKind = (n: string) => new RegExp(`_${k}s?$`, 'i').test(n);
          const rank = (s: { name: string; container?: string }) => (namedLikeKind(s.name) ? 0 : 2) + (s.container ? 1 : 0);
          const matching = f.outline.filter(s => splitIdentifier(s.name).map(stem).includes(k)).sort((a, b) => rank(a) - rank(b) || a.startLine - b.startLine);
          const names = [...new Set(matching.map(s => s.name))];
          if (names.length >= 3 && (!best || names.length > best.names.length)) best = { path: f.path, kind: k, names };
        }
      }
      if (best) {
        const c = cand(best.path);
        // Applied after neighbour expansion, so its tests and docs do not inherit the boost and outrank it.
        extension = { c, boost: 8 + Math.min(best.names.length, 6) };
        c.reasons.unshift(`existing ${best.kind} pattern to mirror (${best.names.slice(0, 3).join(', ')})`);
        // Seed the smallest sibling definitions, and the place they are registered, so the example lands in the pack.
        const f = this.index.files.get(best.path);
        const lead = Math.max(1, ...[...c.chunks.values()].map(r => r.score));
        const examples = best.names.slice(0, 3);
        const isSibling = (ch: Chunk) => !!ch.symbol && examples.some(n => ch.symbol === n || ch.symbol!.endsWith('.' + n));
        const siblings = (f?.chunks ?? []).filter(ch => isSibling(ch) && ch.tokens <= 600).sort((a, b) => a.tokens - b.tokens).slice(0, 2);
        const registration = (f?.chunks ?? []).find(ch => !siblings.includes(ch) && examples.some(n => (ch.text.includes(`(${n})`) || ch.text.includes(`(${n},`)) && !ch.text.includes(`def ${n}`)));
        // Priority within the file: one complete example, then where the siblings are registered, then the second
        // example. These go ahead of plain keyword hits so a small budget still carries the pattern to copy.
        const ordered = [siblings[0], registration && registration.tokens <= 600 ? registration : undefined, siblings[1]].filter((ch): ch is Chunk => !!ch);
        for (const [i, ch] of ordered.entries()) {
          const seeded = lead * (1.03 - i * 0.01);
          const existing = c.chunks.get(ch.id);
          if (!existing) c.chunks.set(ch.id, { chunk: ch, score: seeded, matched: [best.kind] });
          else existing.score = Math.max(existing.score, seeded);
        }
      }
    }

    // 4. open editors
    const open = await this.host.openFiles().catch(() => []);
    for (const o of open) {
      if (!this.index.files.has(o.path)) continue;
      const c = cand(o.path);
      c.score += o.active ? 3 : 1;
      c.reasons.push(o.active ? 'active editor' : 'open in editor');
    }

    // 5. neighbour expansion for the top-ranked source files
    const ranked = [...cands.values()].sort((a, b) => b.score - a.score);
    const seeds = ranked.filter(c => !/(^|\/)(tests?|docs?)\//.test(c.path)).slice(0, 6);
    if (extension && !seeds.includes(extension.c)) seeds.push(extension.c);
    for (const s of seeds) {
      const f = this.index.files.get(s.path);
      if (!f) continue;
      for (const tp of TEST_PATTERNS(s.path)) if (this.index.files.has(tp) && tp !== s.path) { const c = cand(tp); c.score += s.score * 0.45; c.reasons.push(`tests for ${s.path}`); }
      for (const dp of DOC_PATTERNS(s.path)) if (this.index.files.has(dp)) { const c = cand(dp); c.score += s.score * 0.35; c.reasons.push(`docs for ${s.path}`); }
      for (const imp of this.index.resolveImports(f).slice(0, 8)) { const c = cand(imp); c.score += s.score * 0.2; c.reasons.push(`imported by ${s.path}`); }
    }
    // docs/tests that themselves matched strongly already have their own score; nothing else to do.
    if (extension) {
      extension.c.score += extension.boost;
      // Its own tests and docs show how the existing siblings are tested and documented: keep them ahead of files
      // that only share a word with the task (e.g. config tests for "flask config").
      const p = extension.c.path;
      for (const tp of TEST_PATTERNS(p)) if (tp !== p && cands.has(tp)) { cands.get(tp)!.score += 5; cands.get(tp)!.reasons.unshift(`how existing ${p.split('/').pop()} features are tested`); }
      for (const dp of DOC_PATTERNS(p)) if (cands.has(dp)) { cands.get(dp)!.score += 7; cands.get(dp)!.reasons.unshift(`how existing ${p.split('/').pop()} features are documented`); }
      // The file being extended leads its own tests and docs.
      const neighbours = [...TEST_PATTERNS(p), ...DOC_PATTERNS(p)].map(n => cands.get(n)?.score ?? 0);
      if (!extension.c.mentioned) extension.c.score = Math.max(extension.c.score, ...neighbours.map(s => s + 1));
    }

    // Pack
    const final = [...cands.values()].sort((a, b) => b.score - a.score);
    const chosen: PackItem[] = [];
    const skipped: ContextPack['skipped'] = [];
    let used = 0;
    const perFileCap = Math.max(1500, Math.floor(budgetTokens / 4));
    for (const c of final) {
      const f = this.index.files.get(c.path);
      if (!f) continue;
      if (c.score < 0.8 && !c.mentioned) { skipped.push({ path: c.path, reason: 'low relevance', score: round(c.score) }); continue; }
      const remaining = budgetTokens - used;
      if (remaining < 200) { skipped.push({ path: c.path, reason: 'budget exhausted', score: round(c.score) }); continue; }
      // Line-number prefixes and range headers add ~8% on top of raw chunk text; leave margin so we never overshoot.
      // Docs/tests get a smaller per-file cap so one long .rst cannot crowd out source files.
      const cap = isAux(c.path) && !c.mentioned ? Math.floor(perFileCap / 2) : perFileCap;
      const item = this.buildItem(f, c, Math.floor(Math.min(cap, remaining) * 0.9));
      if (!item) { skipped.push({ path: c.path, reason: 'nothing fit in remaining budget', score: round(c.score) }); continue; }
      if (item.tokens > remaining) { skipped.push({ path: c.path, reason: 'budget exhausted', score: round(c.score) }); continue; }
      chosen.push(item);
      used += item.tokens;
    }

    return {
      task, budgetTokens, usedTokens: used, chosen, skipped: skipped.slice(0, 25),
      candidatesConsidered: cands.size, mentions, tookMs: Date.now() - t0,
    };
  }

  private buildItem(f: FileEntry, c: Cand, cap: number): PackItem | undefined {
    const reason = dedupe(c.reasons).join('; ');
    // Mentioned: full file if it fits, else the mentioned symbols, else outline.
    if (c.mentioned) {
      const symMentions = c.mentioned.filter(m => m.symbol);
      if (!symMentions.length && f.tokens <= cap) {
        return { path: f.path, reason, score: round(c.score), mode: 'full', ranges: [{ startLine: 1, endLine: f.lines }], tokens: f.tokens, text: numbered(f.content, 1) };
      }
      const ranges: PackItem['ranges'] = [];
      for (const m of symMentions) if (m.range) ranges.push({ ...m.range, symbol: m.symbol });
      if (ranges.length) {
        const text = rangesText(f, ranges);
        const tokens = estimateTokens(text);
        if (tokens <= cap) return { path: f.path, reason, score: round(c.score), mode: 'symbols', ranges, tokens, text };
      }
      const ol = outlineToText(f.path, f.outline);
      return { path: f.path, reason: reason + ' (too large: outline only)', score: round(c.score), mode: 'outline', ranges: [], tokens: estimateTokens(ol), text: ol };
    }
    // Retrieved: matching chunks (symbol bodies) in score order until cap.
    const chunks = [...c.chunks.values()].sort((a, b) => b.score - a.score);
    const ranges: PackItem['ranges'] = [];
    let tokens = 0;
    for (const r of chunks) {
      if (tokens + r.chunk.tokens > cap) continue;
      ranges.push({ startLine: r.chunk.startLine, endLine: r.chunk.endLine, symbol: r.chunk.symbol });
      tokens += r.chunk.tokens;
      if (ranges.length >= 6) break;
    }
    if (!ranges.length) {
      // small file with no chunk hits (e.g. docs neighbour): include whole if small, else outline
      if (f.tokens <= Math.min(cap, 1200)) return { path: f.path, reason, score: round(c.score), mode: 'full', ranges: [{ startLine: 1, endLine: f.lines }], tokens: f.tokens, text: numbered(f.content, 1) };
      const ol = outlineToText(f.path, f.outline);
      const olTokens = estimateTokens(ol);
      if (olTokens <= cap) return { path: f.path, reason: reason + ' (outline)', score: round(c.score), mode: 'outline', ranges: [], tokens: olTokens, text: ol };
      return undefined;
    }
    ranges.sort((a, b) => a.startLine - b.startLine);
    const text = rangesText(f, ranges);
    return { path: f.path, reason, score: round(c.score), mode: 'symbols', ranges, tokens: estimateTokens(text), text };
  }
}

function rangesText(f: FileEntry, ranges: { startLine: number; endLine: number; symbol?: string }[]): string {
  const lines = f.content.split(/\r?\n/);
  const parts: string[] = [];
  for (const r of ranges) {
    parts.push(`# ${f.path}:${r.startLine}-${r.endLine}${r.symbol ? '  (' + r.symbol + ')' : ''}`);
    parts.push(numbered(lines.slice(r.startLine - 1, r.endLine).join('\n'), r.startLine));
  }
  return parts.join('\n');
}

export function numbered(text: string, start: number): string {
  return text.split(/\r?\n/).map((l, i) => `${String(start + i).padStart(4, ' ')}| ${l}`).join('\n');
}

function dedupe(a: string[]): string[] { return [...new Set(a)]; }
function round(n: number): number { return Math.round(n * 100) / 100; }

/** Human-readable rendering for the model and the panel. */
export function renderPack(p: ContextPack): string {
  const head = [
    `Context pack for: "${p.task.slice(0, 160)}"`,
    `Budget ${p.budgetTokens} tokens, used ${p.usedTokens}; ${p.candidatesConsidered} candidate files considered, ${p.chosen.length} chosen, ${p.skipped.length} skipped.`,
    '',
    'CHOSEN (why):',
    ...p.chosen.map((c, i) => `${i + 1}. ${c.path}  [${c.mode}, ~${c.tokens} tok, score ${c.score}] — ${c.reason}`),
  ];
  if (p.skipped.length) head.push('', 'SKIPPED:', ...p.skipped.slice(0, 12).map(s => `- ${s.path} (${s.reason}, score ${s.score})`));
  head.push('', '==== CONTENTS ====');
  for (const c of p.chosen) head.push('', `----- ${c.path} -----`, c.text);
  return head.join('\n');
}
