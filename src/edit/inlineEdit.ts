/**
 * Inline edit (capability 1): select code → keybinding → plain-language instruction → proposed diff in the
 * editor → accept / reject per hunk. Runs as an ephemeral TrueForge session with the same agent spec; the
 * agent still goes through propose_edit, so the review path is identical to agent mode.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { isInsideWorkspace } from '../host/paths';
import type { TurnRunner, TurnOutcome } from '../trueforge/runner';
import { toPosix } from '../util/text';

export async function runInlineEdit(runner: TurnRunner, root: string, onOutcome: (outcome: TurnOutcome) => void, token: vscode.CancellationToken): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { vscode.window.showInformationMessage('Anvil: open a file and select the code to edit.'); return; }
  if (runner.isRunning) { vscode.window.showWarningMessage('Anvil: a turn is already running (Esc to cancel).'); return; }
  const doc = editor.document;
  if (doc.uri.scheme !== 'file' || !isInsideWorkspace(root, doc.uri.fsPath)) { vscode.window.showWarningMessage('Anvil: inline edit works on files inside the workspace folder.'); return; }

  let sel = editor.selection;
  if (sel.isEmpty) {
    // No selection: use the enclosing symbol if the language server knows it, else the current line.
    const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri).then(s => s ?? [], () => []);
    if (token.isCancellationRequested) return;
    const enclosing = findEnclosing(syms, sel.active);
    sel = enclosing ? new vscode.Selection(enclosing.range.start, enclosing.range.end) : new vscode.Selection(doc.lineAt(sel.active.line).range.start, doc.lineAt(sel.active.line).range.end);
  }
  // Expand to whole lines so the search block is exact.
  const start = new vscode.Position(sel.start.line, 0);
  const endLine = !sel.isEmpty && sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  const end = doc.lineAt(endLine).range.end;
  const range = new vscode.Range(start, end);
  const selected = doc.getText(range);
  const rel = toPosix(path.relative(root, doc.uri.fsPath));

  const instruction = await vscode.window.showInputBox({
    title: `Anvil inline edit — ${rel}:${start.line + 1}-${end.line + 1}`,
    prompt: 'What should change in the selected code?',
    placeHolder: 'e.g. Treat "off" and "n" as false as well, case-insensitively, and update the docstring',
    ignoreFocusOut: true,
  }, token);
  if (!instruction || token.isCancellationRequested) return;

  const message = [
    'INLINE EDIT',
    `file: ${rel}`,
    `lines: ${start.line + 1}-${end.line + 1}`,
    `instruction: ${instruction}`,
    '',
    'selected code (use this EXACT text as the `old` search block of propose_edit):',
    '```',
    selected,
    '```',
  ].join('\n');

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Anvil: inline edit', cancellable: true }, async (progress, progressToken) => {
    if (token.isCancellationRequested || progressToken.isCancellationRequested) return;
    progressToken.onCancellationRequested(() => void runner.cancel());
    progress.report({ message: 'asking the model…' });
    const r = await runner.run(message, { ephemeral: true });
    onOutcome(r);
    if (r.status === 'error') vscode.window.showErrorMessage(`Anvil: ${r.message}`);
    else if (r.status === 'cancelled') vscode.window.setStatusBarMessage('Anvil: inline edit cancelled; previously accepted edits remain applied', 4000);
    else if (r.usedFallback) vscode.window.showInformationMessage(`Anvil: primary model failed; this edit was produced by the fallback model ${r.modelUsed}.`);
  });
}

function findEnclosing(syms: vscode.DocumentSymbol[], pos: vscode.Position): vscode.DocumentSymbol | undefined {
  for (const s of syms) {
    if (s.range.contains(pos)) return findEnclosing(s.children ?? [], pos) ?? s;
  }
  return undefined;
}
