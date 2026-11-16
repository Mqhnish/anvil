/**
 * @mentions: `@src/flask/cli.py`, `@cli.py`, `@get_debug_flag`, `@Flask.run`, `@helpers.py:20-40`.
 * Resolution order: exact path → unique basename → symbol name (unique or best) → fuzzy path contains.
 */
import type { RepoIndex } from './index';

export interface ResolvedMention {
  raw: string;
  path?: string;
  symbol?: string;
  range?: { startLine: number; endLine: number };
  note?: string;
}

const MENTION_RE = /(?:^|[\s(,])@([A-Za-z0-9_./\\-]+(?::\d+(?:-\d+)?)?)/g;

export function parseMentions(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text))) {
    const v = m[1].replace(/[.,;:)]+$/, '');
    if (v) out.push(v);
  }
  return [...new Set(out)];
}

/** Strip the `@` so the model sees plain paths; keep the mention text otherwise. */
export function stripMentionSigils(text: string): string {
  return text.replace(MENTION_RE, (full, inner) => full.replace('@' + inner, inner));
}

export function resolveMentions(index: RepoIndex, mentions: string[]): ResolvedMention[] {
  const out: ResolvedMention[] = [];
  for (const raw of mentions) {
    let spec = raw.replace(/\\/g, '/');
    let range: ResolvedMention['range'];
    const lm = spec.match(/^(.*?):(\d+)(?:-(\d+))?$/);
    if (lm) { spec = lm[1]; range = { startLine: +lm[2], endLine: +(lm[3] ?? lm[2]) }; }

    // 1. exact path
    if (index.files.has(spec)) { out.push({ raw, path: spec, range }); continue; }
    // 2. unique basename / suffix
    const suffix = [...index.files.keys()].filter(p => p === spec || p.endsWith('/' + spec));
    if (suffix.length === 1) { out.push({ raw, path: suffix[0], range }); continue; }
    if (suffix.length > 1) {
      // prefer src/ or shortest path
      suffix.sort((a, b) => a.length - b.length);
      out.push({ raw, path: suffix[0], range, note: `ambiguous (${suffix.length} matches), picked shortest` });
      continue;
    }
    // 3. symbol (possibly Qualified.Name)
    const symName = spec.includes('.') && !spec.includes('/') ? spec.split('.').pop()! : spec;
    const syms = index.findSymbols(symName, 10).filter(s => s.sym.name === symName || s.score >= 60);
    if (syms.length) {
      const container = spec.includes('.') && !spec.includes('/') ? spec.split('.').slice(0, -1).join('.') : undefined;
      const pick = (container && syms.find(s => s.sym.container === container)) || syms[0];
      out.push({ raw, path: pick.path, symbol: (pick.sym.container ? pick.sym.container + '.' : '') + pick.sym.name, range: range ?? { startLine: pick.sym.startLine, endLine: pick.sym.endLine }, note: syms.length > 1 ? `${syms.length} symbol candidates` : undefined });
      continue;
    }
    // 4. fuzzy contains
    const fuzzy = [...index.files.keys()].filter(p => p.toLowerCase().includes(spec.toLowerCase()));
    if (fuzzy.length) { fuzzy.sort((a, b) => a.length - b.length); out.push({ raw, path: fuzzy[0], range, note: 'fuzzy path match' }); continue; }
    out.push({ raw, note: 'unresolved' });
  }
  return out;
}

/** Completion items for the panel's @ autocomplete. */
export function mentionCandidates(index: RepoIndex, query: string, limit = 12): { label: string; detail: string; kind: 'file' | 'symbol' }[] {
  const q = query.toLowerCase();
  const files = [...index.files.keys()].filter(p => p.toLowerCase().includes(q)).sort((a, b) => a.length - b.length).slice(0, limit)
    .map(p => ({ label: p, detail: 'file', kind: 'file' as const }));
  const syms = q.length >= 2 ? index.findSymbols(query, limit).map(s => ({ label: (s.sym.container ? s.sym.container + '.' : '') + s.sym.name, detail: `${s.sym.kind} in ${s.path}`, kind: 'symbol' as const })) : [];
  return [...files, ...syms].slice(0, limit);
}
