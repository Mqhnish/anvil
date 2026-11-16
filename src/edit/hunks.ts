/**
 * Hunk computation and selective application.
 *
 * We diff line-by-line, group consecutive changes (with `context` lines of slack) into hunks, and can
 * rebuild the file from any subset of accepted hunks. This is what makes "accept hunk 1, reject hunk 2"
 * trivially correct: the rejected hunk simply keeps the old lines.
 */
import { diffLines, type Change } from 'diff';

export interface HunkLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
}

export interface Hunk {
  index: number; // 0-based
  oldStart: number; // 1-based line in old file
  oldLines: number;
  newStart: number; // 1-based line in new file
  newLines: number;
  lines: HunkLine[];
  /** indexes into the `parts` array (internal) that this hunk owns */
  partRange: [number, number];
}

interface Part {
  added: boolean;
  removed: boolean;
  lines: string[];
}

function toParts(oldText: string, newText: string): Part[] {
  const changes: Change[] = diffLines(normalizeEol(oldText), normalizeEol(newText));
  return changes.map(c => ({
    added: !!c.added,
    removed: !!c.removed,
    lines: splitKeepingLastLine(c.value),
  }));
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/** "a\nb\n" -> ["a","b"], "a\nb" -> ["a","b"] (trailing newline handling is reconciled in rebuild). */
function splitKeepingLastLine(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface HunkSet {
  hunks: Hunk[];
  parts: Part[];
  oldText: string;
  newText: string;
}

export function computeHunks(oldText: string, newText: string, context = 3): HunkSet {
  const parts = toParts(oldText, newText);
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;

  // Find change groups: runs of parts that are added/removed, merged when separated by <= 2*context ctx lines.
  interface Group { start: number; end: number; }
  const groups: Group[] = [];
  let i = 0;
  while (i < parts.length) {
    if (!parts[i].added && !parts[i].removed) { i++; continue; }
    let end = i;
    let j = i + 1;
    while (j < parts.length) {
      const p = parts[j];
      if (p.added || p.removed) { end = j; j++; continue; }
      // context part: merge only if small
      if (p.lines.length <= 2 * context && j + 1 < parts.length && (parts[j + 1].added || parts[j + 1].removed)) { j++; continue; }
      break;
    }
    groups.push({ start: i, end });
    i = end + 1;
  }

  // Walk parts to compute line numbers and build hunks with leading/trailing context
  const partOldStart: number[] = [];
  const partNewStart: number[] = [];
  for (let k = 0; k < parts.length; k++) {
    partOldStart[k] = oldLine;
    partNewStart[k] = newLine;
    const p = parts[k];
    if (!p.added) oldLine += p.lines.length;
    if (!p.removed) newLine += p.lines.length;
  }

  groups.forEach((g, idx) => {
    const lines: HunkLine[] = [];
    // leading context from previous ctx part
    let oStart = partOldStart[g.start];
    let nStart = partNewStart[g.start];
    const prev = g.start > 0 ? parts[g.start - 1] : undefined;
    if (prev && !prev.added && !prev.removed) {
      const take = prev.lines.slice(-context);
      for (const t of take) lines.push({ type: 'ctx', text: t });
      oStart -= take.length;
      nStart -= take.length;
    }
    let oCount = lines.length;
    let nCount = lines.length;
    for (let k = g.start; k <= g.end; k++) {
      const p = parts[k];
      for (const t of p.lines) {
        if (p.added) { lines.push({ type: 'add', text: t }); nCount++; }
        else if (p.removed) { lines.push({ type: 'del', text: t }); oCount++; }
        else { lines.push({ type: 'ctx', text: t }); oCount++; nCount++; }
      }
    }
    const next = g.end + 1 < parts.length ? parts[g.end + 1] : undefined;
    if (next && !next.added && !next.removed) {
      const take = next.lines.slice(0, context);
      for (const t of take) lines.push({ type: 'ctx', text: t });
      oCount += take.length;
      nCount += take.length;
    }
    hunks.push({ index: idx, oldStart: oStart, oldLines: oCount, newStart: nStart, newLines: nCount, lines, partRange: [g.start, g.end] });
  });

  return { hunks, parts, oldText, newText };
}

/** Rebuild the file keeping only accepted hunks. */
export function applyHunks(set: HunkSet, accepted: ReadonlySet<number>): string {
  const partToHunk = new Map<number, number>();
  for (const h of set.hunks) for (let k = h.partRange[0]; k <= h.partRange[1]; k++) partToHunk.set(k, h.index);
  const out: string[] = [];
  set.parts.forEach((p, k) => {
    const h = partToHunk.get(k);
    const keepNew = h === undefined ? true : accepted.has(h);
    if (p.added) { if (keepNew) out.push(...p.lines); }
    else if (p.removed) { if (!keepNew) out.push(...p.lines); }
    else out.push(...p.lines);
  });
  let text = out.join('\n');
  // Preserve trailing newline convention of whichever side we ended closer to.
  const wantTrailing = accepted.size === set.hunks.length ? set.newText.endsWith('\n') : set.oldText.endsWith('\n');
  if (wantTrailing && !text.endsWith('\n')) text += '\n';
  if (!wantTrailing && text.endsWith('\n') && !set.oldText.endsWith('\n') && !set.newText.endsWith('\n')) text = text.replace(/\n$/, '');
  return text;
}

export function hunkHeader(h: Hunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

export function hunkToUnified(h: Hunk): string {
  return [hunkHeader(h), ...h.lines.map(l => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text)].join('\n');
}

export function unifiedDiff(path: string, oldText: string, newText: string, context = 3): string {
  const set = computeHunks(oldText, newText, context);
  if (!set.hunks.length) return '';
  return [`--- a/${path}`, `+++ b/${path}`, ...set.hunks.map(hunkToUnified)].join('\n') + '\n';
}

export function hunkStats(h: Hunk): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of h.lines) { if (l.type === 'add') added++; else if (l.type === 'del') removed++; }
  return { added, removed };
}
