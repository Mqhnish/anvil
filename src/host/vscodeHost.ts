/**
 * VsCodeHost — WorkspaceHost backed by the VS Code API.
 * Review goes through HunkReviewer (diff editor + per-hunk CodeLens); writes are WorkspaceEdits (undoable).
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { resolveWorkspacePath, isInsideWorkspace } from './paths';
import { executeCommand } from './commands';
import ignore from 'ignore';
import type { WorkspaceHost, FileStat, DirEntry, SymbolInfo, Diagnostic, CommandResult, ProposeEditRequest, ReviewOutcome } from './types';
import { outlineFile } from '../context/outline';
import { HunkReviewer, ApplyHistory, applyFullText } from '../edit/reviewer';
import { isProbablyBinary, toPosix } from '../util/text';

const DEFAULT_IGNORES = ['.git', 'node_modules', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.idea', '.vscode-test', 'coverage', '.DS_Store', '*.pyc', '*.min.js', '*.map', '*.lock', 'package-lock.json', 'pnpm-lock.yaml', '*.png', '*.jpg', '*.gif', '*.ico', '*.woff', '*.woff2', '*.ttf'];

export class VsCodeHost implements WorkspaceHost {
  readonly kind = 'vscode' as const;
  readonly rootPath: string;
  readonly history = new ApplyHistory();
  private readonly out: vscode.OutputChannel;
  /** Set by the panel so command approvals render as cards instead of modal dialogs. */
  commandApprover?: (command: string, cwd?: string) => Promise<{ allow: boolean; reason?: string }>;
  questionAsker?: (question: string, options: string[]) => Promise<string>;

  constructor(readonly folder: vscode.WorkspaceFolder, readonly reviewer: HunkReviewer, out: vscode.OutputChannel) {
    this.rootPath = folder.uri.fsPath;
    this.out = out;
  }

  private abs(rel: string): string {
    return resolveWorkspacePath(this.rootPath, rel);
  }
  private rel(abs: string): string { return toPosix(path.relative(this.rootPath, abs)); }

  async listFiles(): Promise<string[]> {
    const ig = ignore().add(DEFAULT_IGNORES);
    try { ig.add(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.folder.uri, '.gitignore'))).toString('utf8')); } catch { /* none */ }
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, '**/*'), '**/{node_modules,.git,dist,build,out,.venv,venv,__pycache__}/**', 20000);
    return uris.map(u => this.rel(u.fsPath)).filter(r => r && !ig.ignores(r)).sort();
  }

  async readFile(rel: string): Promise<string> {
    const uri = vscode.Uri.file(this.abs(rel));
    // Prefer the live editor buffer (unsaved changes) when the file is open.
    const open = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
    if (open) return open.getText();
    const buf = await vscode.workspace.fs.readFile(uri);
    if (isProbablyBinary(buf)) throw new Error(`${rel} is binary`);
    return Buffer.from(buf).toString('utf8');
  }
  async writeFile(rel: string, content: string): Promise<void> {
    await applyFullText(this.abs(rel), content, !(await this.fileExists(rel)));
  }
  async fileExists(rel: string): Promise<boolean> {
    try { const s = await vscode.workspace.fs.stat(vscode.Uri.file(this.abs(rel))); return (s.type & vscode.FileType.File) !== 0; } catch { return false; }
  }
  async stat(rel: string): Promise<FileStat> {
    const s = await vscode.workspace.fs.stat(vscode.Uri.file(this.abs(rel)));
    return { size: s.size, isDirectory: (s.type & vscode.FileType.Directory) !== 0, mtimeMs: s.mtime };
  }
  async listDir(rel: string): Promise<DirEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(this.abs(rel || '.')));
    return entries.map(([name, type]) => ({ name, isDirectory: (type & vscode.FileType.Directory) !== 0 }));
  }

  async documentSymbols(rel: string): Promise<SymbolInfo[]> {
    const uri = vscode.Uri.file(this.abs(rel));
    try {
      const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
      if (syms?.length) {
        const out: SymbolInfo[] = [];
        const walk = (s: vscode.DocumentSymbol, container?: string) => {
          out.push({ name: s.name, kind: vscode.SymbolKind[s.kind].toLowerCase(), startLine: s.range.start.line + 1, endLine: s.range.end.line + 1, container });
          for (const c of s.children ?? []) walk(c, s.name);
        };
        syms.forEach(s => walk(s));
        return out;
      }
    } catch { /* fall through */ }
    return outlineFile(rel, await this.readFile(rel));
  }

  async diagnostics(rel?: string): Promise<Diagnostic[]> {
    const all = rel ? [[vscode.Uri.file(this.abs(rel)), vscode.languages.getDiagnostics(vscode.Uri.file(this.abs(rel)))] as const] : vscode.languages.getDiagnostics();
    const out: Diagnostic[] = [];
    for (const [uri, diags] of all) {
      if (!isInsideWorkspace(this.rootPath, uri.fsPath)) continue;
      for (const d of diags) out.push({ path: this.rel(uri.fsPath), line: d.range.start.line + 1, severity: (['error', 'warning', 'info', 'hint'] as const)[d.severity], message: d.message, source: d.source });
    }
    return out;
  }

  async openFiles(): Promise<{ path: string; active: boolean; selection?: { startLine: number; endLine: number } }[]> {
    const active = vscode.window.activeTextEditor;
    const out: { path: string; active: boolean; selection?: { startLine: number; endLine: number } }[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (!input?.uri || input.uri.scheme !== 'file' || !isInsideWorkspace(this.rootPath, input.uri.fsPath)) continue;
        const isActive = active?.document.uri.fsPath === input.uri.fsPath;
        const sel = isActive && active && !active.selection.isEmpty ? { startLine: active.selection.start.line + 1, endLine: active.selection.end.line + 1 } : undefined;
        out.push({ path: this.rel(input.uri.fsPath), active: isActive, selection: sel });
      }
    }
    return out;
  }

  runCommand(command: string, opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    return executeCommand(command, opts.cwd ? this.abs(opts.cwd) : this.rootPath, opts);
  }

  async reviewEdit(req: ProposeEditRequest, prev: { oldContent: string; newContent: string }): Promise<ReviewOutcome> {
    return this.reviewer.review(this.abs(req.path), req.path, prev.oldContent, prev.newContent, req.summary, req.signal);
  }

  async applyEdit(rel: string, oldContent: string, resulting: string): Promise<void> {
    const abs = this.abs(rel);
    const exists = await this.fileExists(rel);
    await applyFullText(abs, resulting, !exists, oldContent);
    this.history.push(abs, oldContent, resulting, !exists);
    vscode.commands.executeCommand('setContext', 'anvil.canUndo', true);
  }

  async undoLastApply(): Promise<string | undefined> {
    const last = this.history.pop();
    if (!last) return undefined;
    const uri = vscode.Uri.file(last.absPath);
    const exists = await vscode.workspace.fs.stat(uri).then(() => true, () => false);
    const current = exists ? await this.readFile(this.rel(last.absPath)) : undefined;
    if ((exists && current !== last.after) || (!exists && !last.created)) {
      const pick = await vscode.window.showWarningMessage(`${this.rel(last.absPath)} changed since Anvil applied it. Restore the pre-Anvil content anyway?`, { modal: true }, 'Restore');
      if (pick !== 'Restore') { this.history.push(last.absPath, last.before, last.after, last.created); return undefined; }
    }
    try {
      if (last.created) {
        if (exists) {
          const edit = new vscode.WorkspaceEdit();
          edit.deleteFile(uri);
          if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not remove ${last.absPath}`);
        }
      } else await applyFullText(last.absPath, last.before, !exists);
    } catch (e) {
      this.history.push(last.absPath, last.before, last.after, last.created);
      throw e;
    }
    vscode.commands.executeCommand('setContext', 'anvil.canUndo', this.history.size > 0);
    return this.rel(last.absPath);
  }

  async confirmCommand(command: string, cwd?: string): Promise<{ allow: boolean; reason?: string }> {
    if (this.commandApprover) return this.commandApprover(command, cwd);
    const pick = await vscode.window.showWarningMessage(`Anvil wants to run:\n\n${command}`, { modal: true }, 'Run', 'Deny');
    return pick === 'Run' ? { allow: true } : { allow: false, reason: 'declined' };
  }

  async askQuestion(question: string, options: string[]): Promise<string> {
    if (this.questionAsker) return this.questionAsker(question, options);
    const pick = options.length ? await vscode.window.showQuickPick(options, { title: question, ignoreFocusOut: true }) : await vscode.window.showInputBox({ title: question, ignoreFocusOut: true });
    return pick ?? '';
  }

  log(m: string): void { this.out.appendLine(`${new Date().toISOString().slice(11, 19)} ${m}`); }
}
