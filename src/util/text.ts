/** Rough token estimate: good enough for budgeting (≈4 chars/token for code, a bit fewer for prose). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.8);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, Math.floor(maxTokens * 3.8));
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… [truncated ${text.length - maxChars} chars]`;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Split an identifier into lowercase word parts: fooBarBaz -> [foo, bar, baz]; snake_case too. */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(s => s.toLowerCase());
}

const STOP = new Set(
  (
    'a an the and or of to in on for with as is are be was were by at from that this it its into ' +
    'add new make create update change fix use using should must will can which when where how what ' +
    'so if then than there their them they we you your our any all each other also just only not no ' +
    'file files code function class method value values key keys name names please would could may might ' +
    'built-in builtin'
  ).split(' '),
);

/** Query terms from free text: identifiers split, stopwords removed, de-duplicated, with simple stemming. */
export function queryTerms(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_.\-/]+/)) {
    if (!raw) continue;
    for (const part of splitIdentifier(raw)) {
      if (part.length < 2 || STOP.has(part)) continue;
      out.add(stem(part));
    }
    // keep whole dotted/pathy tokens too (flask.helpers, src/flask/cli.py)
    if (/[./]/.test(raw)) out.add(raw.toLowerCase());
  }
  return [...out];
}

export function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(ing|ers|ies|es|ed|s)$/, m => (m === 'ies' ? 'y' : ''));
}

export function sha1(text: string): string {
  // Tiny FNV-1a 64-bit-ish hash (no crypto import so it also runs in the webview if needed).
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + text.length.toString(16);
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function isProbablyBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) suspicious++;
  }
  return n > 0 && suspicious / n > 0.3;
}
