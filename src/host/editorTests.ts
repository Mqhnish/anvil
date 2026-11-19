/** Runs inside the actual VS Code Extension Host; no mocked vscode module. */
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(check: () => T | Promise<T>, description: string, timeout = 25000): Promise<NonNullable<T>> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await check();
    if (result) return result as NonNullable<T>;
    await delay(50);
  }
  throw new Error('Timed out: ' + description);
}
function within<T>(promise: Thenable<T>, ms: number, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), ms);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
async function reviewDocument(): Promise<vscode.TextDocument> {
  return until(() => vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'anvil-proposed')?.document, 'native review editor');
}
async function lensesFor(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
  return until(async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
    return lenses?.filter(l => l.command?.command === 'anvil.review.acceptHunk').length === 2 ? lenses : undefined;
  }, 'two per-hunk CodeLens actions');
}
async function invoke(lens: vscode.CodeLens): Promise<void> {
  assert.ok(lens.command);
  await vscode.commands.executeCommand(lens.command.command, ...(lens.command.arguments ?? []));
}
async function noReviewTabs(): Promise<void> {
  await until(() => !vscode.window.tabGroups.all.some(group => group.tabs.some(tab => {
    const input = tab.input as { modified?: vscode.Uri };
    return input.modified?.scheme === 'anvil-proposed';
  })), 'review tab closes', 5000);
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'test workspace is open');
  const target = path.join(folder.uri.fsPath, 'sample.py');
  const baseline = await fs.readFile(target, 'utf8');
  const ext = vscode.extensions.getExtension('tokenisers.anvil');
  assert.ok(ext, 'Anvil is loaded');
  await ext.activate();
  const results: string[] = [];
  const task = 'Annotate the first and last lines of @sample.py for this scripted regression test.';
  let pending: Thenable<unknown> | undefined;
  try {
    pending = vscode.commands.executeCommand('anvil.runTask', task);
    const doc = await reviewDocument();
    const lenses = await lensesFor(doc);
    const accept = lenses.filter(l => l.command?.command === 'anvil.review.acceptHunk');
    const reject = lenses.filter(l => l.command?.command === 'anvil.review.rejectHunk');
    await invoke(accept[0]);
    await invoke(reject[1]);
    await vscode.commands.executeCommand('anvil.review.finish', doc.uri);
    await pending;
    await noReviewTabs();
    const partial = await fs.readFile(target, 'utf8');
    assert.ok(partial.includes('# touched by mock-coder'));
    assert.ok(!partial.includes('# second hunk'));
    results.push('individual CodeLens accept/reject applies only the accepted hunk');

    await vscode.commands.executeCommand('anvil.undoLastApply');
    assert.equal(await fs.readFile(target, 'utf8'), baseline);
    results.push('real WorkspaceEdit undo restores the original file');

    await vscode.commands.executeCommand('anvil.newChat');
    pending = vscode.commands.executeCommand('anvil.runTask', task);
    await lensesFor(await reviewDocument());
    await vscode.commands.executeCommand('anvil.cancel');
    await within(pending, 6000, 'Cancelled task did not return');
    await noReviewTabs();
    assert.equal(await fs.readFile(target, 'utf8'), baseline);
    results.push('cancelling a pending real diff review closes it and leaves the file unchanged');

    await vscode.commands.executeCommand('anvil.newChat');
    pending = vscode.commands.executeCommand('anvil.runTask', task);
    const rejected = await reviewDocument();
    await lensesFor(rejected);
    await vscode.commands.executeCommand('anvil.review.rejectAll', rejected.uri);
    await pending;
    await noReviewTabs();
    assert.equal(await fs.readFile(target, 'utf8'), baseline);
    results.push('a new task works after cancellation; rejecting all hunks leaves the file unchanged');

    await vscode.commands.executeCommand('anvil.newChat');
    pending = vscode.commands.executeCommand('anvil.runTask', task);
    const closed = await reviewDocument();
    await lensesFor(closed);
    const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(t => (t.input as { modified?: vscode.Uri }).modified?.toString() === closed.uri.toString());
    assert.ok(tab, 'review diff tab exists');
    await vscode.window.tabGroups.close(tab, true);
    await within(pending, 6000, 'Closing the diff did not finish the review');
    assert.equal(await fs.readFile(target, 'utf8'), baseline);
    results.push('closing the native diff rejects the pending edit without hanging');
  } finally {
    await vscode.commands.executeCommand('anvil.cancel');
    await pending;
    await fs.writeFile(path.join(folder.uri.fsPath, 'editor-test-results.json'), JSON.stringify({ passed: results.length, results }, null, 2));
  }
  assert.equal(results.length, 5);
  console.log('EDITOR TESTS: ' + JSON.stringify({ passed: results.length, results }));
}
