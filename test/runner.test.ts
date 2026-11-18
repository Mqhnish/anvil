import { describe, expect, it, vi } from 'vitest';
import { TurnRunner, type Ev } from '../src/trueforge/runner';
import type { TrueForgeConnection } from '../src/trueforge/client';
import type { WorkspaceHost } from '../src/host/types';
import { DecisionStore } from '../src/edit/decisions';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function* events(values: unknown[]): AsyncGenerator<Ev> { for (const value of values) yield value as Ev; }
const modelCall = { id: 'message', type: 'model.message', threadId: 'thread', toolCalls: [{ id: 'edit', function: { name: 'propose_edit', arguments: JSON.stringify({ path: 'file', new_content: 'after' }) } }] };
const paused = [
  { id: 'created', type: 'turn.created', turnId: 'turn' }, modelCall,
  { id: 'approval', type: 'tool.approval_required', threadId: 'thread', toolCalls: [{ id: 'edit', sourceEventId: 'message' }] },
  { id: 'paused', type: 'turn.update', state: { status: 'paused' } },
];
function fixture() {
  const sessions = {
    create: vi.fn(async () => ({ data: { id: 'session' } })),
    cancel: vi.fn(async () => {}),
    createTurnStream: vi.fn(async () => events([{ id: 'done', type: 'turn.done', state: { status: 'done' } }])),
    subscribeToTurn: vi.fn(async () => events([{ id: 'done', type: 'turn.done', state: { status: 'done' } }])),
    createTurnEvents: vi.fn(async () => {}),
  };
  const host = { log: vi.fn(), fileExists: vi.fn(async () => true), readFile: vi.fn(async () => 'before'), reviewEdit: vi.fn() };
  const decisions = new DecisionStore();
  const runner = new TurnRunner({ conn: { client: { sessions }, baseUrl: 'http://localhost' } as unknown as TrueForgeConnection, host: host as unknown as WorkspaceHost, decisions,
    primaryModel: 'primary/model', fallbackModel: 'fallback/model', maxRetries: 0,
    spec: { mcpServerName: 'workspace', subagents: false, compactionTriggerTokens: 60000, iterationLimit: 20 }, callbacks: {},
  });
  return { runner, sessions, host, decisions };
}

describe('turn lifecycle', () => {
  it('cancels promptly even when the event stream never arrives', async () => {
    const { runner, sessions } = fixture();
    const started = deferred<void>();
    sessions.createTurnStream.mockImplementation(async () => { started.resolve(); return new Promise(() => {}); });
    const run = runner.run('change');
    await started.promise;
    await runner.cancel();
    expect((await run).status).toBe('cancelled');
    expect(runner.isRunning).toBe(false);
    expect(runner.currentSessionId).toBeUndefined();
  });
  it('revokes a pending review and never submits its late approval', async () => {
    const { runner, sessions, host, decisions } = fixture();
    const started = deferred<AbortSignal>();
    const review = deferred<unknown>();
    host.reviewEdit.mockImplementation(async req => { started.resolve(req.signal); return review.promise; });
    sessions.createTurnStream.mockImplementation(async () => events(paused));
    const run = runner.run('change');
    const signal = await started.promise;
    await runner.cancel();
    expect((await run).status).toBe('cancelled');
    expect(signal.aborted).toBe(true);
    review.resolve({ decision: 'allow', decisions: [{ index: 0, accepted: true }], resultingContent: 'after' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sessions.createTurnEvents).not.toHaveBeenCalled();
    expect(decisions.takeCommandApproval('anything')).toBe(false);
  });
  it('does not retry or fall back after a side effect', async () => {
    const { runner, sessions, decisions } = fixture();
    sessions.createTurnStream.mockImplementation(async () => {
      decisions.recordSideEffect();
      return events([{ id: 'error', type: 'turn.done', state: { status: 'error', message: 'model unavailable' } }]);
    });
    const result = await runner.run('change');
    expect(result.status).toBe('error');
    expect(result.message).toContain('Previously accepted changes remain applied');
    expect(result.message).not.toContain('No files were changed');
    expect(sessions.createTurnStream).toHaveBeenCalledTimes(1);
    expect(result.usedFallback).toBe(false);
  });
  it('still falls back automatically when the primary fails before a side effect', async () => {
    const { runner, sessions } = fixture();
    sessions.createTurnStream.mockImplementationOnce(async () => events([{ id: 'error', type: 'turn.done', state: { status: 'error', message: 'model unavailable' } }]));
    const result = await runner.run('change');
    expect(result.status).toBe('done');
    expect(result.usedFallback).toBe(true);
    expect(result.modelUsed).toBe('fallback/model');
  });
});

it('does not attach a session that finishes being created after cancellation', async () => {
  const { runner, sessions } = fixture();
  const started = deferred<void>();
  const created = deferred<{ data: { id: string } }>();
  sessions.create.mockImplementationOnce(async () => { started.resolve(); return created.promise; });
  const run = runner.run('change');
  await started.promise;
  await runner.cancel();
  expect((await run).status).toBe('cancelled');
  created.resolve({ data: { id: 'late-session' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(runner.currentSessionId).toBeUndefined();
  expect(sessions.cancel).toHaveBeenCalledWith('late-session');
  expect(sessions.createTurnStream).not.toHaveBeenCalled();
});
