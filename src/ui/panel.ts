/**
 * The Agent panel (WebviewView in the Anvil activity-bar container).
 * Streams tokens, shows tool calls, context packs, approval cards, questions and the TrueForge session link.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { resolveWorkspacePath } from '../host/paths';
import type { ContextPack } from '../context/retriever';
import type { RepoIndex } from '../context/index';
import { mentionCandidates } from '../context/mentions';

export interface PanelDelegate {
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  newChat(): boolean;
  openSession(): void;
  selectModel(): void;
  index(): RepoIndex | undefined;
  status(): { model?: string; fallback?: string; trueforge: string; session?: string; running: boolean; mcpPort?: number };
}

type ToWebview =
  | { type: 'reset' }
  | { type: 'status'; payload: ReturnType<PanelDelegate['status']> & { text?: string } }
  | { type: 'user'; text: string }
  | { type: 'delta'; threadId: string; text: string }
  | { type: 'thread'; threadId: string; title: string; parent?: string; done?: boolean }
  | { type: 'tool.call'; threadId: string; id: string; name: string; args: string }
  | { type: 'tool.result'; id?: string; name: string; text: string; ms?: number }
  | { type: 'context.pack'; pack: Omit<ContextPack, 'chosen'> & { chosen: Omit<ContextPack['chosen'][number], 'text'>[] } }
  | { type: 'review'; path: string; hunks: number }
  | { type: 'approval'; id: string; command: string; cwd?: string }
  | { type: 'approval.resolved'; id: string; allow: boolean }
  | { type: 'question'; id: string; question: string; options: string[] }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'turn.done'; status: string; message?: string; model?: string; usedFallback?: boolean; attempts?: number }
  | { type: 'mention.results'; q: string; items: { label: string; detail: string; kind: string }[] }
  | { type: 'compaction'; phase: 'started' | 'finished' };

export class AgentPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly queue: ToWebview[] = [];
  private readonly pendingApprovals = new Map<string, (r: { allow: boolean; reason?: string }) => void>();
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  private seq = 0;
  private ready = false;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly delegate: PanelDelegate) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview')] };
    view.webview.onDidReceiveMessage(async (m: { type: string; [k: string]: unknown }) => {
      switch (m.type) {
        case 'ready': this.ready = true; for (const q of this.queue.splice(0)) view.webview.postMessage(q); this.post({ type: 'status', payload: this.delegate.status() }); break;
        case 'send': try { await this.delegate.send(String(m.text ?? '')); } finally { this.status(); } break;
        case 'cancel': await this.delegate.cancel(); break;
        case 'newChat': if (!this.delegate.newChat()) break; this.post({ type: 'reset' }); this.post({ type: 'status', payload: this.delegate.status() }); break;
        case 'openSession': this.delegate.openSession(); break;
        case 'selectModel': this.delegate.selectModel(); break;
        case 'openFile': {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (folder) {
            let uri: vscode.Uri;
            try { uri = vscode.Uri.file(resolveWorkspacePath(folder.uri.fsPath, String(m.path))); } catch { break; }
            const doc = await vscode.workspace.openTextDocument(uri).then(d => d, () => undefined);
            if (doc) {
              const editor = await vscode.window.showTextDocument(doc, { preview: true });
              if (typeof m.line === 'number') { const pos = new vscode.Position(Math.min(doc.lineCount - 1, Math.max(0, Math.floor(m.line) - 1)), 0); editor.selection = new vscode.Selection(pos, pos); editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter); }
            }
          }
          break;
        }
        case 'approve': { const r = this.pendingApprovals.get(String(m.id)); if (r) { this.pendingApprovals.delete(String(m.id)); r({ allow: !!m.allow, reason: m.allow ? undefined : 'declined in panel' }); this.post({ type: 'approval.resolved', id: String(m.id), allow: !!m.allow }); } break; }
        case 'answer': { const r = this.pendingQuestions.get(String(m.id)); if (r) { this.pendingQuestions.delete(String(m.id)); r(String(m.answer ?? '')); } break; }
        case 'mention.query': { const idx = this.delegate.index(); this.post({ type: 'mention.results', q: String(m.q), items: idx ? mentionCandidates(idx, String(m.q)) : [] }); break; }
        case 'command': if (['anvil.startTrueForge', 'anvil.selectModel', 'anvil.selectFallbackModel', 'anvil.openSettings'].includes(String(m.command))) await vscode.commands.executeCommand(String(m.command)); break;
      }
    });
    view.webview.html = this.html(view.webview);
    view.onDidDispose(() => { this.flushPending(); this.view = undefined; this.ready = false; });
  }

  reveal(): void {
    if (this.view) this.view.show(true);
    else void vscode.commands.executeCommand('anvil.agentPanel.focus');
  }

  post(m: ToWebview): void {
    if (this.view && this.ready) void this.view.webview.postMessage(m);
    else { this.queue.push(m); if (this.queue.length > 500) this.queue.shift(); }
  }

  status(extra?: string): void { this.post({ type: 'status', payload: { ...this.delegate.status(), text: extra } }); }

  /** Approval card for run_command; resolves when the user clicks Allow / Deny. */
  requestCommandApproval(command: string, cwd?: string): Promise<{ allow: boolean; reason?: string }> {
    const id = `a${++this.seq}`;
    this.reveal();
    return new Promise(resolve => { this.pendingApprovals.set(id, resolve); this.post({ type: 'approval', id, command, cwd }); });
  }

  askQuestion(question: string, options: string[]): Promise<string> {
    const id = `q${++this.seq}`;
    this.reveal();
    return new Promise(resolve => { this.pendingQuestions.set(id, resolve); this.post({ type: 'question', id, question, options }); });
  }

  /** Resolve every pending card as denied (on cancel). */
  flushPending(): void {
    for (const [id, r] of this.pendingApprovals) { r({ allow: false, reason: 'cancelled' }); this.post({ type: 'approval.resolved', id, allow: false }); }
    this.pendingApprovals.clear();
    for (const r of this.pendingQuestions.values()) r('');
    this.pendingQuestions.clear();
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'style.css'));
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}"><title>Anvil</title></head>
<body>
<div id="app">
  <header id="status">
    <div class="brand"><strong>Anvil</strong><span>Workspace agent</span><button id="newChat" class="icon" aria-label="New chat" title="New chat">＋</button></div>
    <div class="connection"><button id="modelChip" class="chip" title="Select a model">Choose model</button><span id="tfChip" class="chip">Connecting…</span><button id="sessionChip" class="chip hidden" title="Open this session in TrueForge">Session ↗</button></div>
  </header>
  <main id="log" aria-label="Conversation">
    <section id="welcome" class="welcome">
      <div class="eyebrow">YOUR WORKSPACE, IN CONTEXT</div>
      <h1>What would you like to change?</h1>
      <p>Describe a task. Anvil finds relevant code and proposes changes for your review.</p>
      <div id="setup" class="setup hidden" role="status"><strong id="setupTitle"></strong><p id="setupText"></p><button id="setupAction" class="primary"></button></div>
      <div class="examples"><button class="example" data-prompt="Explain how this project is organized and where its main entry points are.">Explore this project <span>Find the main entry points</span></button><button class="example" data-prompt="Find a small bug, propose a focused fix, and suggest how to verify it.">Investigate a bug <span>Review a focused fix</span></button></div>
      <div class="welcome-note">Select code in the editor to request an inline edit.<br>Use @file or @symbol to pin context.</div>
    </section>
  </main>
  <div id="mentions" class="hidden" role="listbox" aria-label="Context suggestions"></div>
  <footer>
    <div id="statusLine" role="status" aria-live="polite">Ready when you are</div>
    <label class="sr-only" for="input">Describe a change</label>
    <textarea id="input" rows="3" placeholder="Describe a change… @file or @symbol" aria-describedby="inputHint"></textarea>
    <div class="row"><span id="inputHint" class="hint">Enter to send · Shift+Enter for a new line</span><button id="send" class="primary">Send</button><button id="cancel" class="danger hidden">Cancel</button></div>
    <p class="safety-note">Review before applying · Accepted edits can be undone</p>
  </footer>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }
}
