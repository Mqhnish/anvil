/**
 * CLI for the headless host.
 *
 *   node dist/headless.js serve --root ../flask [--port 7777] [--reject-all]
 *       Start the workspace MCP server on a folder and print its URL + token (for TrueForge or the e2e script).
 *
 *   node dist/headless.js assemble --root ../flask --budget 12000 "Add a flask config CLI command…"
 *       Print the context pack the agent would receive — handy for the write-up and for tuning retrieval.
 *
 *   node dist/headless.js symbols --root ../flask get_debug_flag
 */
import { HeadlessHost } from './headlessHost';
import { RepoIndex } from '../context/index';
import { Retriever, renderPack } from '../context/retriever';
import { WorkspaceMcpServer } from '../mcp/server';
import { DecisionStore } from '../edit/decisions';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const flag = (name: string) => process.argv.includes(name);

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const root = arg('--root', process.cwd())!;
  const host = new HeadlessHost(root, { reviewPolicy: flag('--reject-all') ? 'reject-all' : 'accept-all', commandPolicy: flag('--deny-commands') ? 'deny' : 'allow' });
  const index = new RepoIndex(host, Number(arg('--max-files', '4000')));

  if (cmd === 'serve') {
    const decisions = new DecisionStore();
    const server = new WorkspaceMcpServer({
      host, index, decisions, port: Number(arg('--port', '0')), budgetTokens: () => Number(arg('--budget', '12000')),
      secret: arg('--secret') ?? undefined,
      events: {
        onToolCall: (n, a) => console.error(`[tool] ${n} ${JSON.stringify(a).slice(0, 200)}`),
        onToolResult: (n, r, ms) => console.error(`[tool] ${n} → ${r.length} chars in ${ms}ms`),
      },
    });
    await index.ensure();
    await server.start();
    console.log(JSON.stringify({ url: server.url, secret: server.secret, port: server.port, files: index.files.size }));
    process.on('SIGINT', () => void server.stop().then(() => process.exit(0)));
    return;
  }
  if (cmd === 'assemble') {
    const task = process.argv.slice(3).filter(a => !a.startsWith('--') && a !== root && a !== arg('--budget')).pop() ?? '';
    await index.ensure();
    const pack = await new Retriever(index, host).assemble(task, Number(arg('--budget', '12000')));
    if (flag('--json')) console.log(JSON.stringify({ ...pack, chosen: pack.chosen.map(c => ({ ...c, text: undefined })) }, null, 2));
    else console.log(renderPack(pack));
    return;
  }
  if (cmd === 'symbols') {
    await index.ensure();
    for (const r of index.findSymbols(process.argv[3] ?? '')) console.log(`${r.path}:${r.sym.startLine}-${r.sym.endLine} ${r.sym.kind} ${r.sym.name}`);
    return;
  }
  console.error('usage: headless.js serve|assemble|symbols --root <dir> …');
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });
