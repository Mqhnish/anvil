/**
 * Thin wrapper over @truefoundry/trueforge-sdk: connection, MCP-server registration, model listing.
 */
import { TrueForge, TrueForgeError } from '@truefoundry/trueforge-sdk';

export interface TrueForgeConnection {
  client: TrueForge;
  baseUrl: string;
  token?: string;
}

export function createClient(baseUrl: string, token?: string): TrueForgeConnection {
  const client = new TrueForge({
    baseUrl: baseUrl.replace(/\/$/, ''),
    token: token || undefined,
    timeoutInSeconds: 600, // SSE turns can be long
  });
  return { client, baseUrl: baseUrl.replace(/\/$/, ''), token: token || undefined };
}

export async function ping(conn: TrueForgeConnection): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(conn.baseUrl + '/api/v1/capabilities', { signal: AbortSignal.timeout(4000), headers: conn.token ? { Authorization: `Bearer ${conn.token}` } : undefined });
    if (!res.ok) return { ok: false, message: `TrueForge answered ${res.status} at ${conn.baseUrl}` };
    return { ok: true, message: 'ok' };
  } catch (e) {
    return { ok: false, message: `TrueForge is not reachable at ${conn.baseUrl} (${(e as Error).message}). Start it with "Anvil: Start TrueForge" or: OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@latest` };
  }
}

/** Register (or re-register) the workspace MCP server under Settings → Connectors. Idempotent. */
export async function registerWorkspaceMcp(conn: TrueForgeConnection, name: string, url: string, secret: string): Promise<void> {
  await conn.client.settings.mcpServers.createOrUpdate({
    manifest: {
      type: 'remote',
      name,
      url,
      description: 'The VS Code workspace Anvil is attached to: read/search files, symbols, budgeted context assembly, propose edits (reviewed hunk-by-hunk), run commands.',
      auth: { type: 'header', headers: { 'x-anvil-token': secret } },
    },
  });
}

export async function listModels(conn: TrueForgeConnection): Promise<{ name: string; provider: string; warning?: string }[]> {
  const res = await conn.client.models.list();
  return res.data.map(m => ({ name: m.name, provider: (m.provider as { name?: string; type?: string })?.name ?? (m.provider as { type?: string })?.type ?? '', warning: m.warning }));
}

export function describeError(e: unknown): string {
  if (e instanceof TrueForgeError) {
    const body = typeof e.body === 'object' && e.body ? JSON.stringify(e.body).slice(0, 300) : String(e.body ?? '');
    return `${e.message}${e.statusCode ? ` (HTTP ${e.statusCode})` : ''}${body ? ` ${body}` : ''}`;
  }
  if (e instanceof Error) return e.cause ? `${e.message} — ${String((e.cause as Error).message ?? e.cause)}` : e.message;
  return String(e);
}

/** Heuristic: is this failure about reaching TrueForge itself (vs. the model behind it)? */
export function isTrueForgeUnreachable(e: unknown): boolean {
  const msg = describeError(e).toLowerCase();
  return /econnrefused|fetch failed|enotfound|network|socket hang up|timed out|timeout/.test(msg) && !(e instanceof TrueForgeError && e.statusCode);
}
