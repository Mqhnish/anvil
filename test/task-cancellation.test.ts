import { afterEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';
import { RepoIndex } from '../src/context/index';
import { WorkspaceMcpServer } from '../src/mcp/server';
import { TurnRunner } from '../src/trueforge/runner';
import { AgentPanel } from '../src/ui/panel';
import * as client from '../src/trueforge/client';

vi.mock('vscode', async importOriginal => {
  const original = await importOriginal<typeof import('./vscode-mock')>();
  return {
    ...original,
    CancellationTokenSource: class {
      private controller = new AbortController();
      token = {
        get isCancellationRequested() { return this.signal.aborted; },
        signal: this.controller.signal,
        onCancellationRequested: (cb: () => void) => this.controller.signal.addEventListener('abort', cb),
      };
      cancel() { this.controller.abort(); }
      dispose() {}
    },
    StatusBarAlignment: { Left: 1 },
    workspace: {
      ...original.workspace, workspaceFolders: [{ name: 'fixture', uri: original.Uri.file(process.cwd()) }],
      getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'model.primary' ? 'local/test' : fallback }),
      onDidSaveTextDocument: vi.fn(), onDidCreateFiles: vi.fn(), onDidDeleteFiles: vi.fn(),
      onDidRenameFiles: vi.fn(), onDidChangeConfiguration: vi.fn(),
    },
    window: {
      ...original.window, createOutputChannel: () => ({ appendLine() {} }),
      createStatusBarItem: () => ({ show() {} }), registerWebviewViewProvider: vi.fn(),
    },
  };
});

afterEach(async () => { await deactivate(); vi.restoreAllMocks(); });

it('cancels during retrieval and keeps a later task in control when the old context arrives', async () => {
  vi.spyOn(RepoIndex.prototype, 'ensure').mockResolvedValue();
  vi.spyOn(WorkspaceMcpServer.prototype, 'start').mockResolvedValue();
  vi.spyOn(client, 'ping').mockResolvedValue({ ok: true, message: 'ok' });
  vi.spyOn(client, 'registerWorkspaceMcp').mockResolvedValue();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((id, fn) => {
    handlers.set(id, fn);
    return { dispose() {} };
  });
  const prepare = vi.spyOn(WorkspaceMcpServer.prototype, 'prepareContext');
  let finishFirst!: (pack: string) => void;
  let finishSecond!: (pack: string) => void;
  prepare.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
  const run = vi.spyOn(TurnRunner.prototype, 'run').mockResolvedValue({ status: 'done', attempts: 1, usedFallback: false, modelUsed: 'local/test' });
  const post = vi.spyOn(AgentPanel.prototype, 'post');
  const flush = vi.spyOn(AgentPanel.prototype, 'flushPending');
  await activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  const invoke = (name: string, ...args: unknown[]) => handlers.get('anvil.' + name)!(...args);

  const first = invoke('runTask', 'first task');
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  await invoke('runTask', 'overlapping task');
  await invoke('inlineEdit');
  expect(prepare).toHaveBeenCalledTimes(1);
  await invoke('cancel');
  await first;
  expect(post).toHaveBeenCalledWith({ type: 'turn.done', status: 'cancelled' });

  const second = invoke('runTask', 'second task');
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  flush.mockClear();
  finishFirst('stale context');
  await new Promise(resolve => setImmediate(resolve));
  expect(run).not.toHaveBeenCalled();
  expect(flush).not.toHaveBeenCalled();
  await invoke('newChat');
  expect(post).not.toHaveBeenCalledWith({ type: 'reset' });
  finishSecond('fresh context');
  await second;
  expect(run).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('fresh context'));

  prepare.mockResolvedValue('');
  run.mockRejectedValueOnce(new Error('transport lost'));
  await invoke('runTask', 'failed task');
  expect(post).toHaveBeenCalledWith({ type: 'turn.done', status: 'error', message: 'transport lost' });
  await invoke('newChat');
  expect(post).toHaveBeenCalledWith({ type: 'reset' });
});
