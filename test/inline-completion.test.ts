import type { CancellationToken } from 'vscode';
import { beforeEach, expect, it, vi } from 'vitest';
import { window, Position } from './vscode-mock';
import { runInlineEdit } from '../src/edit/inlineEdit';
import type { TurnOutcome, TurnRunner } from '../src/trueforge/runner';

beforeEach(() => {
  window.activeTextEditor = {
    document: { uri: { scheme: 'file', fsPath: process.cwd() + '/test.txt' }, lineAt: () => ({ range: { end: new Position(0, 3) } }), getText: () => 'old' },
    selection: { isEmpty: false, start: new Position(0, 0), end: new Position(0, 3) },
  };
  window.showInputBox.mockResolvedValue('test instruction');
});

const token = { isCancellationRequested: false } as CancellationToken;

it.each(['done', 'cancelled', 'error'] as const)('reports an inline %s outcome to the panel', async status => {
  const outcome: TurnOutcome = { status, modelUsed: 'test/model', usedFallback: false, attempts: 1 };
  const runner = { isRunning: false, run: vi.fn(async () => outcome) } as unknown as TurnRunner;
  const report = vi.fn();
  await runInlineEdit(runner, process.cwd(), report, token);
  expect(report).toHaveBeenCalledWith(outcome);
});

it('skips the model if the task is cancelled while the input box is open', async () => {
  const runner = { isRunning: false, run: vi.fn() } as unknown as TurnRunner;
  const pending = { isCancellationRequested: false };
  window.showInputBox.mockImplementationOnce(async () => {
    pending.isCancellationRequested = true;
    return 'late instruction';
  });
  await runInlineEdit(runner, process.cwd(), vi.fn(), pending as CancellationToken);
  expect(runner.run).not.toHaveBeenCalled();
});
