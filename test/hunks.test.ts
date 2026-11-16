import { describe, it, expect } from 'vitest';
import { computeHunks, applyHunks, unifiedDiff } from '../src/edit/hunks';

const OLD = `def a():\n    return 1\n\n\ndef b():\n    return 2\n\n\ndef c():\n    return 3\n`;
const NEW = `def a():\n    return 10\n\n\ndef b():\n    return 2\n\n\ndef c():\n    \"\"\"doc\"\"\"\n    return 30\n`;

describe('hunks', () => {
  it('splits distant changes into separate hunks', () => {
    const set = computeHunks(OLD, NEW, 1);
    expect(set.hunks.length).toBe(2);
    expect(set.hunks[0].lines.some(l => l.type === 'add' && l.text.includes('return 10'))).toBe(true);
    expect(set.hunks[1].lines.some(l => l.type === 'add' && l.text.includes('doc'))).toBe(true);
  });

  it('accepting all hunks reproduces the new text', () => {
    const set = computeHunks(OLD, NEW, 1);
    expect(applyHunks(set, new Set([0, 1]))).toBe(NEW);
  });

  it('rejecting all hunks reproduces the old text', () => {
    const set = computeHunks(OLD, NEW, 1);
    expect(applyHunks(set, new Set())).toBe(OLD);
  });

  it('accepting only the first hunk applies only that change', () => {
    const set = computeHunks(OLD, NEW, 1);
    const out = applyHunks(set, new Set([0]));
    expect(out).toContain('return 10');
    expect(out).not.toContain('doc');
    expect(out).toContain('return 3\n');
  });

  it('accepting only the second hunk applies only that change', () => {
    const set = computeHunks(OLD, NEW, 1);
    const out = applyHunks(set, new Set([1]));
    expect(out).toContain('return 1\n');
    expect(out).toContain('return 30');
  });

  it('merges nearby changes into one hunk with context', () => {
    const o = 'a\nb\nc\nd\ne\n';
    const n = 'A\nb\nc\nd\nE\n';
    expect(computeHunks(o, n, 3).hunks.length).toBe(1);
    expect(computeHunks(o, n, 1).hunks.length).toBe(2);
  });

  it('handles a brand-new file', () => {
    const set = computeHunks('', 'x = 1\ny = 2\n');
    expect(set.hunks.length).toBe(1);
    expect(applyHunks(set, new Set([0]))).toBe('x = 1\ny = 2\n');
    expect(applyHunks(set, new Set())).toBe('');
  });

  it('renders a unified diff', () => {
    const d = unifiedDiff('f.py', OLD, NEW, 1);
    expect(d).toContain('--- a/f.py');
    expect(d).toContain('+    return 10');
    expect(d).toContain('-    return 1');
  });

  it('preserves CRLF-insensitive equality', () => {
    const set = computeHunks('a\r\nb\r\n', 'a\nb\nc\n');
    expect(set.hunks.length).toBe(1);
  });
});
