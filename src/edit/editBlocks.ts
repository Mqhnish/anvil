/**
 * Apply search/replace edit blocks to produce the new file content.
 * Matching strategy (in order): exact → trailing-whitespace-insensitive → indentation-insensitive.
 * Each block must match exactly once; ambiguity or no-match is an error the agent gets back verbatim,
 * which is far better than silently editing the wrong place.
 */
import type { EditBlock } from '../host/types';

export class EditBlockError extends Error {
  constructor(message: string, public readonly blockIndex: number) {
    super(message);
  }
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function findAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + 1); }
  return out;
}

/** Returns the matched [start,end) span in `content` for `old` using progressively looser matching. */
export function locateBlock(content: string, old: string): { start: number; end: number; strategy: string } | { error: string } {
  const c = normalizeEol(content);
  const o = normalizeEol(old);
  if (o.trim() === '') return { error: 'empty search block' };

  // 1. exact
  let hits = findAll(c, o);
  if (hits.length === 1) return { start: hits[0], end: hits[0] + o.length, strategy: 'exact' };
  if (hits.length > 1) return { error: `search block matches ${hits.length} times; include more surrounding lines to make it unique` };

  // 2. line-based, trailing whitespace insensitive
  const cLines = c.split('\n');
  const oLines = o.split('\n');
  while (oLines.length && oLines[oLines.length - 1].trim() === '') oLines.pop();
  while (oLines.length && oLines[0].trim() === '') oLines.shift();
  const rtrim = (s: string) => s.replace(/\s+$/, '');
  const ltrimAll = (s: string) => s.trim();
  const tryLines = (norm: (s: string) => string, name: string) => {
    const on = oLines.map(norm);
    const found: number[] = [];
    for (let i = 0; i + on.length <= cLines.length; i++) {
      let ok = true;
      for (let j = 0; j < on.length; j++) { if (norm(cLines[i + j]) !== on[j]) { ok = false; break; } }
      if (ok) found.push(i);
    }
    if (found.length === 1) {
      const startLine = found[0];
      const endLine = startLine + on.length; // exclusive
      const start = cLines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
      const end = cLines.slice(0, endLine).join('\n').length;
      return { start, end, strategy: name };
    }
    if (found.length > 1) return { error: `search block matches ${found.length} times (${name})` };
    return undefined;
  };
  const r2 = tryLines(rtrim, 'trailing-whitespace-insensitive');
  if (r2) return r2;
  const r3 = tryLines(ltrimAll, 'indentation-insensitive');
  if (r3) return r3;
  return { error: 'search block not found in file (check exact text, including indentation)' };
}

/** When the match was indentation-insensitive, re-indent the replacement to the matched block's indentation. */
function reindent(replacement: string, matchedOriginal: string, oldBlock: string): string {
  const firstOrig = matchedOriginal.split('\n').find(l => l.trim() !== '') ?? '';
  const firstOld = oldBlock.split('\n').find(l => l.trim() !== '') ?? '';
  const origIndent = firstOrig.match(/^\s*/)?.[0] ?? '';
  const oldIndent = firstOld.match(/^\s*/)?.[0] ?? '';
  if (origIndent === oldIndent) return replacement;
  return replacement
    .split('\n')
    .map(l => (l.startsWith(oldIndent) ? origIndent + l.slice(oldIndent.length) : l))
    .join('\n');
}

export function applyEditBlocks(content: string, blocks: EditBlock[]): { content: string; notes: string[] } {
  let cur = normalizeEol(content);
  const notes: string[] = [];
  blocks.forEach((b, i) => {
    const loc = locateBlock(cur, b.old);
    if ('error' in loc) throw new EditBlockError(`edit block ${i + 1}: ${loc.error}`, i);
    const matched = cur.slice(loc.start, loc.end);
    let repl = normalizeEol(b.new);
    if (loc.strategy === 'indentation-insensitive') repl = reindent(repl, matched, normalizeEol(b.old));
    cur = cur.slice(0, loc.start) + repl + cur.slice(loc.end);
    if (loc.strategy !== 'exact') notes.push(`block ${i + 1} matched using ${loc.strategy} matching`);
  });
  return { content: cur, notes };
}
