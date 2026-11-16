/**
 * Language-agnostic-ish symbol outline by regex. Used when no language server answers
 * (headless mode, or VS Code before Pylance/TS server warms up) and as the chunking unit for retrieval.
 */
import type { SymbolInfo } from '../host/types';

interface Rule { kind: string; re: RegExp; nameGroup: number; }

const RULES: Record<string, Rule[]> = {
  py: [
    { kind: 'class', re: /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 2 },
    { kind: 'function', re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 2 },
  ],
  ts: [
    { kind: 'class', re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, nameGroup: 2 },
    { kind: 'interface', re: /^(\s*)(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, nameGroup: 2 },
    { kind: 'type', re: /^(\s*)(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, nameGroup: 2 },
    { kind: 'enum', re: /^(\s*)(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, nameGroup: 2 },
    { kind: 'function', re: /^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, nameGroup: 2 },
    { kind: 'function', re: /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, nameGroup: 2 },
    { kind: 'method', re: /^(\s+)(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, nameGroup: 2 },
  ],
  go: [
    { kind: 'function', re: /^(\s*)func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, nameGroup: 2 },
    { kind: 'type', re: /^(\s*)type\s+([A-Za-z_][\w]*)/, nameGroup: 2 },
  ],
  rs: [
    { kind: 'function', re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, nameGroup: 2 },
    { kind: 'struct', re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/, nameGroup: 2 },
    { kind: 'impl', re: /^(\s*)impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:<>]*\s+for\s+)?([A-Za-z_][\w]*)/, nameGroup: 2 },
  ],
  java: [
    { kind: 'class', re: /^(\s*)(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/, nameGroup: 2 },
    { kind: 'method', re: /^(\s+)(?:public\s+|private\s+|protected\s+|static\s+|final\s+|synchronized\s+|abstract\s+)*[\w<>\[\],.\s]+\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws[^{]+)?\{?\s*$/, nameGroup: 2 },
  ],
  rb: [
    { kind: 'class', re: /^(\s*)(?:class|module)\s+([A-Za-z_][\w:]*)/, nameGroup: 2 },
    { kind: 'function', re: /^(\s*)def\s+(?:self\.)?([A-Za-z_][\w?!=]*)/, nameGroup: 2 },
  ],
  c: [
    { kind: 'function', re: /^([A-Za-z_][\w\s\*]*?)\s+\*?([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, nameGroup: 2 },
    { kind: 'struct', re: /^(\s*)(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/, nameGroup: 2 },
  ],
  rst: [
    { kind: 'section', re: /^()(\S.*)$/, nameGroup: 2 }, // handled specially below
  ],
  md: [
    { kind: 'section', re: /^(\s*)#{1,6}\s+(.+)$/, nameGroup: 2 },
  ],
};

const EXT_TO_LANG: Record<string, string> = {
  py: 'py', pyi: 'py',
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', mts: 'ts', cts: 'ts',
  go: 'go', rs: 'rs', java: 'java', kt: 'java', scala: 'java', cs: 'java',
  rb: 'rb',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cxx: 'c', m: 'c',
  rst: 'rst', md: 'md', mdx: 'md',
};

export function langForPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext];
}

function indentOf(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].replace(/\t/g, '    ').length : 0;
}

/** Regex outline. For indentation languages the symbol ends where a line with <= indent starts; for brace languages we track braces loosely. */
export function outlineFile(path: string, content: string): SymbolInfo[] {
  const lang = langForPath(path);
  if (!lang) return [];
  const lines = content.split(/\r?\n/);
  const out: SymbolInfo[] = [];

  if (lang === 'rst') {
    // reStructuredText: a title line followed by an underline of punctuation
    for (let i = 0; i + 1 < lines.length; i++) {
      const t = lines[i];
      const u = lines[i + 1];
      if (t.trim() && /^[=\-~^"'`#*+:.]{3,}\s*$/.test(u) && u.trim().length >= t.trim().length) {
        out.push({ name: t.trim(), kind: 'section', startLine: i + 1, endLine: i + 1 });
      }
    }
    for (let k = 0; k < out.length; k++) out[k].endLine = (k + 1 < out.length ? out[k + 1].startLine - 1 : lines.length);
    return out;
  }
  if (lang === 'md') {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(RULES.md[0].re);
      if (m) out.push({ name: m[2].trim(), kind: 'section', startLine: i + 1, endLine: i + 1 });
    }
    for (let k = 0; k < out.length; k++) out[k].endLine = (k + 1 < out.length ? out[k + 1].startLine - 1 : lines.length);
    return out;
  }

  const rules = RULES[lang];
  const stack: { sym: SymbolInfo; indent: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    // close symbols whose block ended (indentation-based; works acceptably for brace languages too)
    while (stack.length && ind <= stack[stack.length - 1].indent && !/^\s*[})\]]/.test(line)) {
      const top = stack.pop()!;
      top.sym.endLine = i; // previous line
    }
    for (const r of rules) {
      const m = line.match(r.re);
      if (m && m[r.nameGroup]) {
        const name = m[r.nameGroup];
        if (lang === 'ts' && r.kind === 'method' && /^(if|for|while|switch|catch|return|function|else)$/.test(name)) break;
        const container = stack.length ? stack[stack.length - 1].sym.name : undefined;
        const sym: SymbolInfo = { name, kind: r.kind === 'function' && container ? 'method' : r.kind, startLine: i + 1, endLine: lines.length, container };
        out.push(sym);
        stack.push({ sym, indent: ind });
        break;
      }
    }
  }
  // trim trailing blank lines from symbol ends
  for (const s of out) {
    while (s.endLine > s.startLine && !lines[s.endLine - 1]?.trim()) s.endLine--;
  }
  return out;
}

/** Compact one-line-per-symbol outline text, e.g. for repo maps. */
export function outlineToText(path: string, syms: SymbolInfo[], maxSymbols = 40): string {
  const shown = syms.slice(0, maxSymbols).map(s => `  ${s.kind} ${s.container ? s.container + '.' : ''}${s.name}  (L${s.startLine}-${s.endLine})`);
  const more = syms.length > maxSymbols ? `  … ${syms.length - maxSymbols} more` : '';
  return [path + ':', ...shown, more].filter(Boolean).join('\n');
}
