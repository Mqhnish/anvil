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

it.each(['done', 'cancelled', 'error'] as const)('reports an inline %s outcome before resetting the panel', async status => {
  const outcome: TurnOutcome = { status, modelUsed: 'test/model', usedFallback: false, attempts: 1 };
  const runner = { isRunning: false, run: vi.fn(async () => outcome) } as unknown as TurnRunner;
  const order: string[] = [];
  await runInlineEdit(runner, process.cwd(), () => order.push('start'), () => order.push('idle'), r => { expect(r).toBe(outcome); order.push('outcome'); });
  expect(order).toEqual(['start', 'outcome', 'idle']);
});

it('resets running controls after an unexpected runner exception', async () => {
  const runner = { isRunning: false, run: vi.fn(async () => { throw new Error('transport lost'); }) } as unknown as TurnRunner;
  const finished = vi.fn();
  const report = vi.fn();
  await runInlineEdit(runner, process.cwd(), vi.fn(), finished, report);
  expect(finished).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
});
