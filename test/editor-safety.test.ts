import { beforeEach, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { files, Uri, commands, workspace } from './vscode-mock';
import { VsCodeHost } from '../src/host/vscodeHost';
import { HunkReviewer, applyFullText } from '../src/edit/reviewer';

beforeEach(() => { files.clear(); commands.executeCommand.mockClear(); workspace.applyEdit.mockClear(); });
function fixture() {
  const ctx = { subscriptions: [] } as unknown as vscode.ExtensionContext;
  const reviewer = new HunkReviewer(ctx);
  const folder = { uri: Uri.file(process.cwd()), name: 'test' } as unknown as vscode.WorkspaceFolder;
  const host = new VsCodeHost(folder, reviewer, { appendLine() {} } as unknown as vscode.OutputChannel);
  return { reviewer, host };
}

it('undo removes a file created by Anvil instead of leaving an empty file', async () => {
  const { host } = fixture();
  const target = process.cwd() + '/new-file.txt';
  await host.applyEdit('new-file.txt', '', 'created content');
  expect(files.get(target)).toBe('created content');
  await host.undoLastApply();
  expect(files.has(target)).toBe(false);
  expect(host.history.size).toBe(0);
});

it('undo restores an existing file, including one that was originally empty', async () => {
  const { host } = fixture();
  const target = process.cwd() + '/existing.txt';
  files.set(target, '');
  await host.applyEdit('existing.txt', '', 'new text');
  await host.undoLastApply();
  expect(files.has(target)).toBe(true);
  expect(files.get(target)).toBe('');
});

it('cancellation closes an active diff review and resolves it as denied', async () => {
  const { reviewer } = fixture();
  const controller = new AbortController();
  const review = reviewer.review(process.cwd() + '/file', 'file', 'old', 'new', 'change', controller.signal);
  // Wait until the asynchronous existence check has opened the review.
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(reviewer.activeCount).toBe(1);
  controller.abort();
  expect((await review).decision).toBe('deny');
  expect(reviewer.activeCount).toBe(0);
});

it('a cancelled review never opens a diff', async () => {
  const { reviewer } = fixture();
  const result = await reviewer.review(process.cwd() + '/file', 'file', 'old', 'new', 'change', AbortSignal.abort());
  expect(result.decision).toBe('deny');
  expect(commands.executeCommand).not.toHaveBeenCalled();
});

it('reports a refused save instead of claiming success', async () => {
  workspace.openTextDocument.mockResolvedValueOnce({ getText: () => '', positionAt: () => ({ line: 0, character: 0 }), isDirty: true, save: async () => false } as never);
  await expect(applyFullText(process.cwd() + '/file', 'new', true)).rejects.toThrow('could not save');
});

it('refuses to replace an editor buffer that changed since review', async () => {
  const target = process.cwd() + '/changed.txt';
  files.set(target, 'user change');
  await expect(applyFullText(target, 'proposal', false, 'reviewed baseline')).rejects.toThrow('changed before');
  expect(files.get(target)).toBe('user change');
  expect(workspace.applyEdit).not.toHaveBeenCalled();
});

it('keeps undo history when the editor refuses the undo operation', async () => {
  const { host } = fixture();
  await host.applyEdit('new-file.txt', '', 'content');
  workspace.applyEdit.mockResolvedValueOnce(false);
  await expect(host.undoLastApply()).rejects.toThrow('could not remove');
  expect(host.history.size).toBe(1);
});
