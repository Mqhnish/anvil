/**
 * HunkReviewer — the per-hunk diff review inside VS Code.
 *
 * Opens a native diff editor (current file ⟷ proposed content served from a virtual document), adds a
 * CodeLens above every hunk with Accept / Reject, colours the hunk by its decision, and resolves when the
 * user finishes (title-bar ✓ button, Accept all, Reject all, or closes the editor = reject).
 *
 * Nothing is written here. The caller applies the accepted subset with `applyEdit`, as a single
 * WorkspaceEdit so Cmd+Z undoes it, and Anvil keeps its own undo stack (`Anvil: Undo Last Applied Change`).
 */
import * as vscode from 'vscode';
import { computeHunks, applyHunks, hunkStats, type HunkSet } from './hunks';
import type { HunkDecision, ReviewOutcome } from '../host/types';
import { decisionKey } from './decisions';

export const PROPOSED_SCHEME = 'anvil-proposed';

interface ActiveReview {
  id: string;
  path: string;
  absPath: string;
  summary?: string;
  set: HunkSet;
  decisions: Map<number, boolean | undefined>;
  resolve: (o: ReviewOutcome) => void;
  proposedUri: vscode.Uri;
  originalUri: vscode.Uri;
  finished: boolean;
}

export class HunkReviewer implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider {
  private readonly reviews = new Map<string, ActiveReview>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private seq = 0;
  private readonly accepted = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'), isWholeLine: true, overviewRulerColor: 'green' });
  private readonly rejected = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'), isWholeLine: true, opacity: '0.55', overviewRulerColor: 'red' });
  private readonly pending = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'), isWholeLine: true });

  constructor(ctx: vscode.ExtensionContext, private readonly onReviewOpen?: (path: string, hunks: number) => void) {
    ctx.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, this),
      vscode.commands.registerCommand('anvil.review.acceptHunk', (id: string, idx: number) => this.decide(id, idx, true)),
      vscode.commands.registerCommand('anvil.review.rejectHunk', (id: string, idx: number) => this.decide(id, idx, false)),
      vscode.commands.registerCommand('anvil.review.acceptAll', (uri?: vscode.Uri) => this.decideAll(this.fromUri(uri), true)),
      vscode.commands.registerCommand('anvil.review.rejectAll', (uri?: vscode.Uri) => this.decideAll(this.fromUri(uri), false)),
      vscode.commands.registerCommand('anvil.review.finish', (uri?: vscode.Uri) => this.finish(this.fromUri(uri))),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme !== PROPOSED_SCHEME) return;
        const id = doc.uri.query;
        const r = this.reviews.get(id);
        // Closing the proposed document without finishing = reject everything that is still undecided.
        if (r && !r.finished) setTimeout(() => { if (!r.finished && !this.isVisible(r)) this.finish(id, true); }, 400);
      }),
    );
  }

  get activeCount(): number { return [...this.reviews.values()].filter(r => !r.finished).length; }

  private fromUri(uri?: vscode.Uri): string | undefined {
    const u = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (u?.scheme === PROPOSED_SCHEME) return u.query;
    // when the diff editor is focused on the left side, find the single active review
    const active = [...this.reviews.values()].filter(r => !r.finished);
    return active.length === 1 ? active[0].id : active[active.length - 1]?.id;
  }

  private isVisible(r: ActiveReview): boolean {
    return vscode.window.visibleTextEditors.some(e => e.document.uri.toString() === r.proposedUri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const r = this.reviews.get(uri.query);
    return r ? r.set.newText : '';
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const r = this.reviews.get(doc.uri.query);
    if (!r || r.finished) return [];
    const lenses: vscode.CodeLens[] = [];
    const acc = [...r.decisions.values()].filter(v => v === true).length;
    const rej = [...r.decisions.values()].filter(v => v === false).length;
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(new vscode.CodeLens(top, { title: `$(pass-filled) Finish review — apply ${acc}/${r.set.hunks.length} accepted`, command: 'anvil.review.finish', arguments: [doc.uri] }));
    lenses.push(new vscode.CodeLens(top, { title: '$(check-all) Accept all', command: 'anvil.review.acceptAll', arguments: [doc.uri] }));
    lenses.push(new vscode.CodeLens(top, { title: '$(close-all) Reject all', command: 'anvil.review.rejectAll', arguments: [doc.uri] }));
    if (r.summary) lenses.push(new vscode.CodeLens(top, { title: `${r.summary}  (${acc} accepted, ${rej} rejected, ${r.set.hunks.length - acc - rej} pending)`, command: '' }));
    for (const h of r.set.hunks) {
      const line = Math.max(0, Math.min(doc.lineCount - 1, h.newStart - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const d = r.decisions.get(h.index);
      const st = hunkStats(h);
      const label = `Hunk ${h.index + 1}/${r.set.hunks.length}  +${st.added} −${st.removed}`;
      lenses.push(new vscode.CodeLens(range, { title: d === true ? `$(check) ${label} — accepted` : d === false ? `$(x) ${label} — rejected` : `$(circle-large-outline) ${label}`, command: '' }));
      lenses.push(new vscode.CodeLens(range, { title: d === true ? 'Accepted ✓' : 'Accept', command: 'anvil.review.acceptHunk', arguments: [r.id, h.index] }));
      lenses.push(new vscode.CodeLens(range, { title: d === false ? 'Rejected ✗' : 'Reject', command: 'anvil.review.rejectHunk', arguments: [r.id, h.index] }));
    }
    return lenses;
  }

  /** Open the review and wait for the user's decisions. */
  async review(absPath: string, relPath: string, oldContent: string, newContent: string, summary?: string, token?: vscode.CancellationToken): Promise<ReviewOutcome> {
    const set = computeHunks(oldContent, newContent);
    const key = decisionKey(relPath, oldContent, newContent);
    if (!set.hunks.length) return { decision: 'deny', decisions: [], key, reason: 'no changes' };
    const id = `r${++this.seq}`;
    const proposedUri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${relPath}?${id}`);
    const originalUri = vscode.Uri.file(absPath);
    const exists = await vscode.workspace.fs.stat(originalUri).then(() => true, () => false);
    const leftUri = exists ? originalUri : vscode.Uri.parse(`${PROPOSED_SCHEME}:/${relPath}.empty?${id}-empty`);

    return new Promise<ReviewOutcome>(resolve => {
      const r: ActiveReview = { id, path: relPath, absPath, summary, set, decisions: new Map(set.hunks.map(h => [h.index, undefined])), resolve, proposedUri, originalUri: leftUri, finished: false };
      this.reviews.set(id, r);
      this.onReviewOpen?.(relPath, set.hunks.length);
      token?.onCancellationRequested(() => this.finish(id, true));
      const title = `${relPath}: ${exists ? 'current' : '(new file)'} ⟷ Anvil proposal (${set.hunks.length} hunk${set.hunks.length === 1 ? '' : 's'})`;
      void vscode.commands.executeCommand('vscode.diff', leftUri, proposedUri, title, { preview: false, viewColumn: vscode.ViewColumn.Active })
        .then(() => { this._onDidChangeCodeLenses.fire(); setTimeout(() => this.refreshDecorations(), 150); }, (e: unknown) => {
          vscode.window.showErrorMessage(`Anvil: could not open diff: ${String(e)}`);
          this.finish(id, true);
        });
    });
  }

  private decide(id: string, idx: number, accept: boolean): void {
    const r = this.reviews.get(id);
    if (!r || r.finished) return;
    r.decisions.set(idx, accept);
    this._onDidChangeCodeLenses.fire();
    this.refreshDecorations();
    // Auto-finish when every hunk has a decision and there is only one hunk (snappy inline-edit UX).
    if (r.set.hunks.length === 1) setTimeout(() => this.finish(id), 120);
  }

  private decideAll(id: string | undefined, accept: boolean): void {
    if (!id) return;
    const r = this.reviews.get(id);
    if (!r || r.finished) return;
    for (const h of r.set.hunks) r.decisions.set(h.index, accept);
    this._onDidChangeCodeLenses.fire();
    this.refreshDecorations();
    this.finish(id);
  }

  /** Resolve the review. Undecided hunks count as rejected. */
  finish(id: string | undefined, forceReject = false): void {
    if (!id) return;
    const r = this.reviews.get(id);
    if (!r || r.finished) return;
    r.finished = true;
    const decisions: HunkDecision[] = r.set.hunks.map(h => ({ index: h.index, accepted: !forceReject && r.decisions.get(h.index) === true, reason: r.decisions.get(h.index) === undefined ? 'not reviewed' : undefined }));
    const acceptedSet = new Set(decisions.filter(d => d.accepted).map(d => d.index));
    const key = decisionKey(r.path, r.set.oldText, r.set.newText);
    const outcome: ReviewOutcome = acceptedSet.size
      ? { decision: 'allow', decisions, key, resultingContent: applyHunks(r.set, acceptedSet) }
      : { decision: 'deny', decisions, key, reason: forceReject ? 'review cancelled' : 'all hunks rejected' };
    r.resolve(outcome);
    this.reviews.delete(id);
    this._onDidChangeCodeLenses.fire();
    // Close the diff editor tab(s) for this review.
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { modified?: vscode.Uri; original?: vscode.Uri } | undefined;
        if (input?.modified?.toString() === r.proposedUri.toString()) void vscode.window.tabGroups.close(tab, true);
      }
    }
  }

  private refreshDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== PROPOSED_SCHEME) continue;
      const r = this.reviews.get(editor.document.uri.query);
      if (!r) continue;
      const acc: vscode.Range[] = [], rej: vscode.Range[] = [], pen: vscode.Range[] = [];
      for (const h of r.set.hunks) {
        // highlight the added lines of the hunk in the proposed doc
        let line = h.newStart - 1;
        for (const l of h.lines) {
          if (l.type === 'del') continue;
          if (l.type === 'add') {
            const range = new vscode.Range(line, 0, line, 0);
            const d = r.decisions.get(h.index);
            (d === true ? acc : d === false ? rej : pen).push(range);
          }
          line++;
        }
      }
      editor.setDecorations(this.accepted, acc);
      editor.setDecorations(this.rejected, rej);
      editor.setDecorations(this.pending, pen);
    }
  }
}

/** Undo stack for applied edits (in addition to the editor's native Cmd+Z). */
export class ApplyHistory {
  private readonly stack: { absPath: string; before: string; after: string; at: number }[] = [];
  push(absPath: string, before: string, after: string): void { this.stack.push({ absPath, before, after, at: Date.now() }); if (this.stack.length > 50) this.stack.shift(); }
  pop(): { absPath: string; before: string; after: string; at: number } | undefined { return this.stack.pop(); }
  get size(): number { return this.stack.length; }
}

/** Replace the full text of a file through a WorkspaceEdit so it is undoable and visible in open editors. */
export async function applyFullText(absPath: string, newText: string, create: boolean): Promise<void> {
  const uri = vscode.Uri.file(absPath);
  const edit = new vscode.WorkspaceEdit();
  if (create) {
    edit.createFile(uri, { overwrite: false, ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), newText);
  } else {
    const doc = await vscode.workspace.openTextDocument(uri);
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(uri, full, newText);
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error(`workspace edit rejected for ${absPath}`);
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.isDirty) await doc.save();
}
