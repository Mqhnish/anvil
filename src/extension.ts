/**
 * Anvil — VS Code extension entry point.
 *
 *   VS Code ──(SDK: sessions / turns / events)──► TrueForge (local, :8790)
 *      ▲                                               │
 *      └──── MCP (Streamable HTTP, 127.0.0.1:port) ◄───┘   TrueForge calls our tools back
 *
 * Everything the agent can do to the workspace is an MCP tool served by this process; TrueForge owns
 * the loop; the extension renders the stream, reviews edits hunk-by-hunk and applies them undoably.
 */
import * as vscode from 'vscode';
import { createClient, ping, registerWorkspaceMcp, listModels, describeError, type TrueForgeConnection } from './trueforge/client';
import { TurnRunner } from './trueforge/runner';
import { WorkspaceMcpServer } from './mcp/server';
import { RepoIndex } from './context/index';
import { DecisionStore } from './edit/decisions';
import { HunkReviewer } from './edit/reviewer';
import { VsCodeHost } from './host/vscodeHost';
import { AgentPanel } from './ui/panel';
import { runInlineEdit } from './edit/inlineEdit';
import { renderPack } from './context/retriever';
import { isInsideWorkspace } from './host/paths';

interface Services {
  host: VsCodeHost;
  index: RepoIndex;
  decisions: DecisionStore;
  mcp: WorkspaceMcpServer;
  conn: TrueForgeConnection;
  runner: TurnRunner;
  panel: AgentPanel;
  reviewer: HunkReviewer;
  status: vscode.StatusBarItem;
  trueforgeState: string;
  registered: boolean;
}

let services: Services | undefined;

function cfg<T>(key: string, def: T): T { return vscode.workspace.getConfiguration('anvil').get<T>(key, def); }

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('Anvil');
  ctx.subscriptions.push(out);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'anvil.openPanel';
  ctx.subscriptions.push(status);

  if (!folder) {
    status.text = '$(tools) Anvil: open a folder';
    status.show();
    ctx.subscriptions.push(vscode.commands.registerCommand('anvil.openPanel', () => vscode.window.showInformationMessage('Anvil needs an open workspace folder.')));
    return;
  }

  const reviewer = new HunkReviewer(ctx, (p, n) => services?.panel.post({ type: 'review', path: p, hunks: n }));
  const host = new VsCodeHost(folder, reviewer, out);
  const index = new RepoIndex(host, cfg('context.maxFiles', 4000));
  const decisions = new DecisionStore();
  const conn = createClient(cfg('trueforge.baseUrl', 'http://localhost:8790'), cfg('trueforge.token', ''));

  let panel!: AgentPanel;
  const mcp = new WorkspaceMcpServer({
    host, index, decisions, port: cfg('mcp.port', 0), budgetTokens: () => cfg('context.budgetTokens', 12000),
    events: {
      onToolCall: () => { /* model.message already announced it */ },
      onToolResult: (name, text, ms) => panel.post({ type: 'tool.result', name, text, ms }),
      onContextPack: pack => panel.post({ type: 'context.pack', pack: { ...pack, chosen: pack.chosen.map(c => ({ ...c, text: undefined as unknown as string })) } }),
    },
  });

  const makeRunner = (): TurnRunner => new TurnRunner({
    conn, host, decisions,
    spec: {
      mcpServerName: cfg('mcp.serverName', 'vscode-workspace'),
      subagents: cfg('agent.subagents', true),
      compactionTriggerTokens: cfg('agent.compactionTriggerTokens', 60000),
      iterationLimit: cfg('agent.iterationLimit', 60),
      extraInstructions: `Workspace root: ${folder.name}. Paths are relative to it.`,
    },
    primaryModel: cfg('model.primary', ''),
    fallbackModel: cfg('model.fallback', '') || undefined,
    maxRetries: cfg('resilience.maxRetries', 2),
    callbacks: {
      onDelta: (threadId, text) => panel.post({ type: 'delta', threadId, text }),
      onToolCall: (threadId, name, args, id) => panel.post({ type: 'tool.call', threadId, name, args, id }),
      onStatus: text => panel.status(text),
      onNotice: (level, text) => { panel.post({ type: 'notice', level, text }); if (level === 'error') vscode.window.showErrorMessage('Anvil: ' + text); else if (level === 'warn') vscode.window.setStatusBarMessage('Anvil: ' + text, 6000); },
      onSession: () => panel.status(),
      onCommandApproval: (c, w) => panel.requestCommandApproval(c, w),
      onAsk: (q, o) => panel.askQuestion(q, o),
      onEvent: ev => {
        if (ev.type === 'thread.created') panel.post({ type: 'thread', threadId: ev.threadId, title: ev.title });
        if (ev.type === 'thread.done') panel.post({ type: 'thread', threadId: ev.threadId, title: ev.title, done: true });
        if (ev.type === 'thread.context_compaction_started') panel.post({ type: 'compaction', phase: 'started' });
        if (ev.type === 'thread.context_compaction_finished') panel.post({ type: 'compaction', phase: 'finished' });
      },
    },
  });
  const runner = makeRunner();
  let configurationDirty = false;
  function refreshConfiguration(): void {
    if (!configurationDirty || svc.runner.isRunning) return;
    Object.assign(conn, createClient(cfg('trueforge.baseUrl', 'http://localhost:8790'), cfg('trueforge.token', '')));
    svc.runner = makeRunner();
    svc.registered = false;
    configurationDirty = false;
  }

  const svc: Services = { host, index, decisions, mcp, conn, runner, panel: undefined as unknown as AgentPanel, reviewer, status, trueforgeState: 'checking…', registered: false };
  services = svc;

  panel = new AgentPanel(ctx, {
    send: text => sendMessage(text),
    cancel: () => cancelTurn(),
    newChat: () => { if (svc.runner.isRunning) return false; svc.runner.resetSession(); return true; },
    openSession: () => openSession(),
    selectModel: () => vscode.commands.executeCommand('anvil.selectModel'),
    index: () => index,
    status: () => ({ model: cfg('model.primary', '') || undefined, fallback: cfg('model.fallback', '') || undefined, trueforge: svc.trueforgeState, session: svc.runner.currentSessionId, running: svc.runner.isRunning, mcpPort: mcp.port }),
  });
  svc.panel = panel;
  host.commandApprover = (c, w) => panel.requestCommandApproval(c, w);
  host.questionAsker = (q, o) => panel.askQuestion(q, o);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('anvil.agentPanel', panel, { webviewOptions: { retainContextWhenHidden: true } }));

  // --- commands -----------------------------------------------------------------------------------------------
  const setRunning = (r: boolean) => { void vscode.commands.executeCommand('setContext', 'anvil.turnRunning', r); updateStatus(r); };
  async function sendMessage(text: string): Promise<void> {
    if (!text.trim()) return;
    if (svc.runner.isRunning) { vscode.window.showWarningMessage('Anvil: a turn is already running.'); return; }
    if (!(await preflight())) return;
    if (svc.runner.isRunning) { vscode.window.showWarningMessage('Anvil: a turn is already running.'); return; }
    panel.post({ type: 'user', text });
    setRunning(true);
    try {
      const r = await svc.runner.run(text);
      panel.post({ type: 'turn.done', status: r.status, message: r.message, model: r.modelUsed, usedFallback: r.usedFallback, attempts: r.attempts });
      if (r.status === 'error') vscode.window.showErrorMessage(`Anvil: ${r.message}`);
    } catch (e) {
      panel.post({ type: 'turn.done', status: 'error', message: describeError(e) });
      vscode.window.showErrorMessage(`Anvil: ${describeError(e)}`);
    } finally {
      panel.flushPending();
      setRunning(false);
      panel.status();
    }
  }
  async function cancelTurn(): Promise<void> {
    if (!svc.runner.isRunning) return;
    panel.flushPending();
    await svc.runner.cancel();
  }
  function openSession(): void {
    const sid = svc.runner.currentSessionId;
    void vscode.env.openExternal(vscode.Uri.parse(sid ? `${conn.baseUrl}/sessions/${sid}` : `${conn.baseUrl}/sessions`));
  }
  function updateStatus(runningOverride?: boolean): void {
    const model = cfg('model.primary', '');
    const running = runningOverride ?? svc.runner.isRunning;
    status.text = running ? '$(sync~spin) Anvil' : svc.registered ? '$(tools) Anvil' : '$(warning) Anvil';
    status.tooltip = `TrueForge: ${svc.trueforgeState}\nModel: ${model || '(not set)'}\nFallback: ${cfg('model.fallback', '') || '(none)'}\nMCP: ${mcp.url}`;
    status.show();
  }

  /** Make sure TrueForge is reachable, our MCP server is registered, and a model is chosen. */
  async function preflight(): Promise<boolean> {
    refreshConfiguration();
    const p = await ping(conn);
    svc.trueforgeState = p.ok ? 'ok' : 'unreachable';
    if (!p.ok) {
      panel.status();
      const pick = await vscode.window.showErrorMessage(p.message, 'Start TrueForge', 'Open settings');
      if (pick === 'Start TrueForge') await vscode.commands.executeCommand('anvil.startTrueForge');
      if (pick === 'Open settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'anvil.trueforge');
      return false;
    }
    if (!svc.registered) {
      try { await registerWorkspaceMcp(conn, cfg('mcp.serverName', 'vscode-workspace'), mcp.url, mcp.secret); svc.registered = true; host.log(`[tf] registered MCP server ${cfg('mcp.serverName', 'vscode-workspace')} → ${mcp.url}`); }
      catch (e) {
        const msg = describeError(e);
        host.log(`[tf] MCP registration failed: ${msg}`);
        vscode.window.showErrorMessage(`Anvil: could not register the workspace MCP server with TrueForge: ${msg}. If it mentions a blocked URL, start TrueForge with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' (the "Anvil: Start TrueForge" command does this).`);
        return false;
      }
    }
    if (!cfg('model.primary', '')) {
      await vscode.commands.executeCommand('anvil.selectModel');
      if (!cfg('model.primary', '')) return false;
      configurationDirty = true; refreshConfiguration();
    }
    svc.trueforgeState = 'ok';
    panel.status();
    updateStatus();
    return true;
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand('anvil.openPanel', () => panel.reveal()),
    vscode.commands.registerCommand('anvil.cancel', () => cancelTurn()),
    vscode.commands.registerCommand('anvil.inlineEdit', async () => { if (await preflight()) await runInlineEdit(svc.runner, folder.uri.fsPath, () => setRunning(true), () => setRunning(false)); }),
    vscode.commands.registerCommand('anvil.selectModel', () => pickModel('model.primary', 'Primary model')),
    vscode.commands.registerCommand('anvil.selectFallbackModel', () => pickModel('model.fallback', 'Fallback model (used automatically when the primary fails)')),
    vscode.commands.registerCommand('anvil.registerWithTrueForge', async () => { svc.registered = false; if (await preflight()) vscode.window.showInformationMessage(`Anvil: registered ${cfg('mcp.serverName', 'vscode-workspace')} → ${mcp.url}`); }),
    vscode.commands.registerCommand('anvil.startTrueForge', () => {
      const term = vscode.window.createTerminal({ name: 'TrueForge', env: { OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1","localhost"]' } });
      term.show();
      term.sendText(`OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest`);
      vscode.window.showInformationMessage('Anvil: starting TrueForge in a terminal. When it says it is listening, configure a model under Settings → Models at http://localhost:8790, then run "Anvil: Select Model".');
    }),
    vscode.commands.registerCommand('anvil.undoLastApply', async () => {
      const p = await host.undoLastApply();
      vscode.window.setStatusBarMessage(p ? `Anvil: restored ${p}` : 'Anvil: nothing to undo', 4000);
    }),
    vscode.commands.registerCommand('anvil.showContextPack', async () => {
      const pack = mcp.lastPack;
      if (!pack) { vscode.window.showInformationMessage('Anvil: no context pack yet — run an agent task first.'); return; }
      const doc = await vscode.workspace.openTextDocument({ content: renderPack(pack), language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('anvil.openSessionInTrueForge', () => openSession()),
    vscode.workspace.onDidSaveTextDocument(doc => { if (isInsideWorkspace(folder.uri.fsPath, doc.uri.fsPath)) void index.touch(toRel(doc.uri.fsPath)); }),
    vscode.workspace.onDidCreateFiles(() => void index.refresh()),
    vscode.workspace.onDidDeleteFiles(() => void index.refresh()),
    vscode.workspace.onDidRenameFiles(() => void index.refresh()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('anvil')) return;
      configurationDirty = true; refreshConfiguration();
      if (e.affectsConfiguration('anvil.mcp.port')) void vscode.window.showInformationMessage('Anvil: reload the window to use the new MCP port.', 'Reload window').then(pick => { if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow'); });
      panel.status(); updateStatus();
    }),
  );
  const rootFs = folder.uri.fsPath;
  function toRel(abs: string): string { return abs.slice(rootFs.length + 1).replace(/\\/g, '/'); }

  async function pickModel(key: 'model.primary' | 'model.fallback', title: string): Promise<void> {
    const p = await ping(conn);
    if (!p.ok) { vscode.window.showErrorMessage(p.message); return; }
    let models: { name: string; provider: string; warning?: string }[] = [];
    try { models = await listModels(conn); } catch (e) { vscode.window.showErrorMessage(`Anvil: could not list models: ${describeError(e)}`); return; }
    if (!models.length) {
      const pick = await vscode.window.showWarningMessage('TrueForge has no models configured. Add a provider under Settings → Models (any OpenAI-compatible endpoint works), then retry.', 'Open TrueForge');
      if (pick) void vscode.env.openExternal(vscode.Uri.parse(conn.baseUrl + '/settings'));
      return;
    }
    const items = models.map(m => ({ label: m.name, description: m.provider, detail: m.warning }));
    if (key === 'model.fallback') items.unshift({ label: '(none)', description: 'disable automatic fallback', detail: undefined });
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Models configured in TrueForge' });
    if (!pick) return;
    await vscode.workspace.getConfiguration('anvil').update(key, pick.label === '(none)' ? '' : pick.label, vscode.ConfigurationTarget.Workspace);
    configurationDirty = true; refreshConfiguration();
    panel.status();
    updateStatus();
  }

  // --- startup ---------------------------------------------------------------------------------------------------
  updateStatus();
  try { await mcp.start(); } catch (e) { vscode.window.showErrorMessage(`Anvil: could not start the workspace MCP server: ${describeError(e)}`); }
  void index.ensure().then(() => host.log('[index] ready'));
  void ping(conn).then(async p => {
    svc.trueforgeState = p.ok ? 'ok' : 'unreachable';
    if (p.ok) { try { await registerWorkspaceMcp(conn, cfg('mcp.serverName', 'vscode-workspace'), mcp.url, mcp.secret); svc.registered = true; } catch (e) { host.log(`[tf] registration at startup failed: ${describeError(e)}`); } }
    panel.status();
    updateStatus();
  });
  ctx.subscriptions.push({ dispose: () => void mcp.stop() });
  host.log(`Anvil activated for ${folder.uri.fsPath}`);
}

export async function deactivate(): Promise<void> {
  services?.panel.flushPending();
  if (services?.runner.isRunning) await services.runner.cancel();
  await services?.mcp.stop();
  services = undefined;
}
