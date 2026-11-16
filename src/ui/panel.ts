/**
 * The Agent panel (WebviewView in the Anvil activity-bar container).
 * Streams tokens, shows tool calls, context packs, approval cards, questions and the TrueForge session link.
 */
import * as vscode from 'vscode';
import type { ContextPack } from '../context/retriever';
import type { RepoIndex } from '../context/index';
import { mentionCandidates } from '../context/mentions';

export interface PanelDelegate {
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  newChat(): void;
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

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly delegate: PanelDelegate) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async (m: { type: string; [k: string]: unknown }) => {
      switch (m.type) {
        case 'ready': for (const q of this.queue.splice(0)) view.webview.postMessage(q); this.post({ type: 'status', payload: this.delegate.status() }); break;
        case 'send': await this.delegate.send(String(m.text ?? '')); break;
        case 'cancel': await this.delegate.cancel(); break;
        case 'newChat': this.delegate.newChat(); this.post({ type: 'reset' }); this.post({ type: 'status', payload: this.delegate.status() }); break;
        case 'openSession': this.delegate.openSession(); break;
        case 'selectModel': this.delegate.selectModel(); break;
        case 'openFile': {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (folder) {
            const uri = vscode.Uri.joinPath(folder.uri, String(m.path));
            const doc = await vscode.workspace.openTextDocument(uri).then(d => d, () => undefined);
            if (doc) {
              const editor = await vscode.window.showTextDocument(doc, { preview: true });
              if (typeof m.line === 'number') { const pos = new vscode.Position(Math.max(0, (m.line as number) - 1), 0); editor.selection = new vscode.Selection(pos, pos); editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter); }
            }
          }
          break;
        }
        case 'approve': { const r = this.pendingApprovals.get(String(m.id)); if (r) { this.pendingApprovals.delete(String(m.id)); r({ allow: !!m.allow, reason: m.allow ? undefined : 'declined in panel' }); this.post({ type: 'approval.resolved', id: String(m.id), allow: !!m.allow }); } break; }
        case 'answer': { const r = this.pendingQuestions.get(String(m.id)); if (r) { this.pendingQuestions.delete(String(m.id)); r(String(m.answer ?? '')); } break; }
        case 'mention.query': { const idx = this.delegate.index(); this.post({ type: 'mention.results', q: String(m.q), items: idx ? mentionCandidates(idx, String(m.q)) : [] }); break; }
        case 'command': await vscode.commands.executeCommand(String(m.command)); break;
      }
    });
    view.onDidDispose(() => { this.view = undefined; });
  }

  reveal(): void {
    if (this.view) this.view.show(true);
    else void vscode.commands.executeCommand('anvil.agentPanel.focus');
  }

  post(m: ToWebview): void {
    if (this.view) void this.view.webview.postMessage(m);
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
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}"><title>Anvil</title></head>
<body>
<div id="app">
  <header id="status"><span id="modelChip" class="chip" title="Click to change model">model: —</span><span id="tfChip" class="chip">TrueForge: —</span><span id="sessionChip" class="chip hidden" title="Open this session in the TrueForge UI">session</span><button id="newChat" class="icon" title="New chat">＋</button></header>
  <main id="log"></main>
  <div id="mentions" class="hidden"></div>
  <footer>
    <div id="statusLine"></div>
    <textarea id="input" rows="3" placeholder="Describe a change… use @file or @symbol to pin context. Enter to send, Shift+Enter for newline."></textarea>
    <div class="row"><button id="send" class="primary">Send</button><button id="cancel" class="danger hidden">Cancel (Esc)</button><span class="hint">Edits are reviewed hunk by hunk before anything touches disk.</span></div>
  </footer>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }
}
