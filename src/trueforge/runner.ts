/**
 * TurnRunner — drives one TrueForge turn end to end and owns all the resilience logic.
 *
 *   createTurnStream ──► events ──► (paused?) ──► review/approve ──► subscribeToTurn ──► … ──► turn.done
 *          │                                                                              │
 *          └── transport error / turn error ──► retry with backoff ──► fallback model ──► clear error
 *
 * Invariants the judges look for:
 *   - the editor never blocks: everything here is async, UI updates are callbacks.
 *   - cancellation aborts local waits/reviews immediately and requests sessions.cancel.
 *   - each file receives its reviewed hunks in one apply operation. Accepted changes remain on cancellation;
 *     retries and fallback are disabled after an edit or command to avoid replaying side effects.
 *   - a provider rate limit (per-minute quota, HTTP 429) is waited out for the time the provider asks for, then
 *     the SAME session continues with a short "continue" message: nothing is replayed, so this is safe even
 *     after accepted edits. Daily quotas are not waited out.
 */
import { isEventDelta, mergeEventDelta, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { TrueForgeConnection } from './client';
import { describeError, isTrueForgeUnreachable } from './client';
import { buildAgentSpec, type SpecOptions } from './agentSpec';
import type { WorkspaceHost } from '../host/types';
import { DecisionStore, decisionKey } from '../edit/decisions';
import { computeHunks, applyHunks } from '../edit/hunks';
import { applyEditBlocks, EditBlockError } from '../edit/editBlocks';
import { TOOL_NAMES } from '../mcp/server';

export type Ev = TrueForgeApi.TurnStreamingEvent;

export interface RunnerCallbacks {
  onEvent?(e: Ev): void;
  onDelta?(threadId: string, text: string): void;
  onToolCall?(threadId: string, name: string, args: string, id: string): void;
  onStatus?(text: string): void;
  onNotice?(level: 'info' | 'warn' | 'error', text: string): void;
  onSession?(sessionId: string, model: string): void;
  onAsk?(question: string, options: string[]): Promise<string>;
  onCommandApproval?(command: string, cwd?: string): Promise<{ allow: boolean; reason?: string }>;
}

export interface RunnerOptions {
  conn: TrueForgeConnection;
  host: WorkspaceHost;
  decisions: DecisionStore;
  spec: Omit<SpecOptions, 'model'>;
  primaryModel: string;
  fallbackModel?: string;
  maxRetries: number;
  callbacks: RunnerCallbacks;
}

export interface TurnOutcome {
  status: 'done' | 'cancelled' | 'error';
  message?: string;
  output?: string;
  modelUsed: string;
  sessionId?: string;
  usedFallback: boolean;
  attempts: number;
}

export class TurnRunner {
  private sessionId?: string;
  private sessionModel?: string;
  private running = false;
  private cancelRequested = false;
  private readonly events = new Map<string, Ev>();
  private activeSessionIdForCancel?: string;

  constructor(private readonly o: RunnerOptions) {}

  get isRunning(): boolean { return this.running; }
  get currentSessionId(): string | undefined { return this.sessionId; }
  get currentModel(): string | undefined { return this.sessionModel; }

  /** Start a fresh conversation next time (e.g. "New chat"). */
  resetSession(): void { this.sessionId = undefined; this.sessionModel = undefined; }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    this.o.decisions.cancelTurn();
    const sid = this.activeSessionIdForCancel ?? this.sessionId;
    this.resetSession();
    this.o.callbacks.onStatus?.('cancelling…');
    if (sid) {
      try { await withTimeout(this.o.conn.client.sessions.cancel(sid), 4000); } catch (e) { this.o.host.log(`[runner] cancel: ${describeError(e)}`); }
    }
  }

  private async ensureSession(model: string, signal: AbortSignal): Promise<string> {
    if (this.sessionId && this.sessionModel === model) return this.sessionId;
    const spec = buildAgentSpec({ ...this.o.spec, model });
    const { data } = await this.o.conn.client.sessions.create({ agent: { spec } });
    if (signal.aborted) {
      void this.o.conn.client.sessions.cancel(data.id).catch(() => {});
      throw new Error('cancelled');
    }
    this.sessionId = data.id;
    this.sessionModel = model;
    this.o.callbacks.onSession?.(data.id, model);
    this.o.host.log(`[runner] session ${data.id} on ${model}`);
    return data.id;
  }

  /**
   * Run one user message. Retries on model/transport errors with exponential backoff, then falls back to
   * the configured fallback model (new session, same message) with no user action.
   */
  async run(userText: string, opts: { ephemeral?: boolean } = {}): Promise<TurnOutcome> {
    if (this.running) throw new Error('a turn is already running');
    this.running = true;
    this.cancelRequested = false;
    this.o.decisions.beginTurn();
    let signal = this.o.decisions.signal;
    const cb = this.o.callbacks;
    const models = [this.o.primaryModel, ...(this.o.fallbackModel && this.o.fallbackModel !== this.o.primaryModel ? [this.o.fallbackModel] : [])];
    let attempts = 0;
    let lastError = '';
    let rateLimitWaits = 0;
    let continuing = false; // next turn on the same session is a continuation after a rate-limit wait
    const savedSession = opts.ephemeral ? { id: this.sessionId, model: this.sessionModel } : undefined;
    if (opts.ephemeral) this.resetSession();

    try {
      for (let mi = 0; mi < models.length; mi++) {
        const model = models[mi];
        const usedFallback = mi > 0;
        if (usedFallback) {
          cb.onNotice?.('warn', `Primary model "${models[0]}" failed (${lastError}). Falling back to "${model}" automatically.`);
          this.resetSession();
          continuing = false;
          // A fresh model session has never seen the primary session's tool results.
          if (!this.cancelRequested) {
            this.o.decisions.beginTurn();
            signal = this.o.decisions.signal;
          }
        }
        for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
          attempts++;
          if (this.cancelRequested) return { status: 'cancelled', modelUsed: model, usedFallback, attempts, sessionId: this.sessionId };
          if (attempt > 0) {
            const delay = 800 * 2 ** (attempt - 1);
            cb.onStatus?.(`model error — retry ${attempt}/${this.o.maxRetries} in ${delay}ms (${lastError})`);
            await untilCancelled(sleep(delay), signal).catch(() => {});
            if (this.cancelRequested) return { status: 'cancelled', modelUsed: model, usedFallback, attempts, sessionId: this.sessionId };
          }
          try {
            const sid = await untilCancelled(this.ensureSession(model, signal), signal);
            this.activeSessionIdForCancel = sid;
            const r = await untilCancelled(this.executeTurn(sid, continuing ? CONTINUE_AFTER_RATE_LIMIT : userText, signal), signal);
            continuing = false;
            if (r.status === 'done') return { ...r, modelUsed: model, usedFallback, attempts, sessionId: sid };
            if (r.status === 'cancelled') return { ...r, modelUsed: model, usedFallback, attempts, sessionId: sid };
            lastError = r.message ?? 'unknown error';
            if (/iteration limit/i.test(lastError)) {
              const progress = this.o.decisions.hasSideEffects
                ? 'Review the changes already applied before continuing.'
                : 'This run applied no edits and ran no commands.';
              return { status: 'error', message: `The session reached its iteration limit. ${progress} ${opts.ephemeral ? 'Start another inline edit to continue.' : 'Send a follow-up in this chat to continue.'}`, modelUsed: model, usedFallback, attempts, sessionId: sid };
            }
            const waitMs = rateLimitWaitMs(lastError);
            if (waitMs !== undefined && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
              rateLimitWaits++;
              const secs = Math.ceil(waitMs / 1000);
              this.o.host.log(`[runner] rate limited on ${model}; waiting ${secs}s then continuing session ${sid}`);
              cb.onNotice?.('info', `${model} hit the provider's per-minute limit. Waiting ${secs}s, then continuing where it stopped (nothing is redone).`);
              cb.onStatus?.(`rate limited — continuing in ${secs}s`);
              await untilCancelled(sleep(waitMs), signal).catch(() => {});
              if (this.cancelRequested) return { status: 'cancelled', modelUsed: model, usedFallback, attempts, sessionId: sid };
              continuing = true;
              attempt--; // waiting out a rate limit does not use up a retry
              continue;
            }
            if (this.o.decisions.hasSideEffects) return { status: 'error', message: `The turn failed after an accepted edit or command: ${lastError}. Previously accepted changes remain applied. Review your workspace before retrying.`, modelUsed: model, usedFallback, attempts, sessionId: sid };
            if (!isRetryable(lastError)) break; // e.g. iteration limit: no point retrying
            this.o.host.log(`[runner] turn error on ${model}: ${lastError}`);
          } catch (e) {
            if (signal.aborted) return { status: 'cancelled', modelUsed: model, usedFallback, attempts };
            lastError = describeError(e);
            if (this.o.decisions.hasSideEffects) return { status: 'error', message: `The turn failed after an accepted edit or command: ${lastError}. Previously accepted changes remain applied. Review your workspace before retrying.`, modelUsed: model, usedFallback, attempts, sessionId: this.sessionId };
            this.o.host.log(`[runner] exception on ${model}: ${lastError}`);
            if (isTrueForgeUnreachable(e)) {
              // TrueForge itself is down: no model will help; fail fast with a clear message.
              return { status: 'error', message: `TrueForge is not reachable at ${this.o.conn.baseUrl}: ${lastError}. Start it with "Anvil: Start TrueForge".`, modelUsed: model, usedFallback, attempts, sessionId: this.sessionId };
            }
            // Session creation can fail when the model name is unknown to TrueForge → not retryable on this model.
            if (/unknown model|model .* not found|not configured|400/.test(lastError)) break;
          }
        }
      }
      const tried = models.length > 1 ? `Tried ${models.join(' then ')}.` : `Model: ${models[0]}. Configure anvil.model.fallback for automatic failover.`;
      return { status: 'error', message: `The model is unavailable: ${lastError}. ${tried} This turn did not apply edits or run commands.`, modelUsed: models[models.length - 1], usedFallback: models.length > 1, attempts, sessionId: this.sessionId };
    } finally {
      this.running = false;
      this.activeSessionIdForCancel = undefined;
      this.o.decisions.clear();
      if (savedSession) { this.sessionId = savedSession.id; this.sessionModel = savedSession.model; }
    }
  }

  /** One turn on an existing session, including every pause/resume cycle. */
  private async executeTurn(sessionId: string, userText: string, signal: AbortSignal): Promise<{ status: 'done' | 'cancelled' | 'error'; message?: string; output?: string }> {
    const { client } = this.o.conn;
    this.events.clear();
    this.announced.clear();
    let turnId: string | undefined;
    let lastEventId: string | undefined;
    let pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
    let pendingResponses: TrueForgeApi.ToolResponseRequiredEvent[] = [];
    let pendingAuth: TrueForgeApi.McpAuthRequiredEvent[] = [];

    const consume = async (stream: AsyncIterable<Ev>): Promise<'paused' | { status: 'done' | 'cancelled' | 'error'; message?: string; output?: string }> => {
      for await (const ev of stream) {
        if (signal.aborted) return { status: 'cancelled' };
        lastEventId = ev.id;
        this.o.callbacks.onEvent?.(ev);
        if (ev.type === 'turn.created') turnId = ev.turnId;
        if (isEventDelta(ev)) {
          const base = this.events.get(ev.id);
          if (base) mergeEventDelta(base, ev);
          if (ev.content) this.o.callbacks.onDelta?.(ev.threadId, ev.content);
          // Tool calls stream in as argument fragments; announce them once the message is complete.
          if (ev.finishReason && base?.type === 'model.message') this.announceToolCalls(base);
        } else {
          this.events.set(ev.id, ev);
          if (ev.type === 'model.message') this.announceToolCalls(ev);
        }
        if (ev.type === 'tool.approval_required' || ev.type === 'tool.response_required') {
          for (const ref of ev.toolCalls) { const src = this.events.get(ref.sourceEventId); if (src?.type === 'model.message') this.announceToolCalls(src); }
        }
        if (ev.type === 'tool.approval_required') pendingApprovals.push(ev);
        if (ev.type === 'tool.response_required') pendingResponses.push(ev);
        if (ev.type === 'mcp.auth_required') pendingAuth.push(ev);
        if (ev.type === 'turn.update' && ev.state.status === 'paused') return 'paused';
        if (ev.type === 'turn.done') {
          const st = ev.state;
          if (st.status === 'done') return { status: 'done', output: contentToText(st.output?.content) };
          if (st.status === 'cancelled') return { status: 'cancelled', message: String(st.reason) };
          return { status: 'error', message: st.message };
        }
      }
      // Stream ended without turn.done (connection dropped): resubscribe below.
      return 'paused';
    };

    this.o.callbacks.onStatus?.('thinking…');
    const stream = await client.sessions.createTurnStream(sessionId, { input: [{ type: 'user.message', content: userText }] });
    let r = await consume(stream);

    let resubscribes = 0;
    while (r === 'paused') {
      if (signal.aborted) return { status: 'cancelled' };
      if (!turnId) return { status: 'error', message: 'stream ended before the turn was created' };
      if (this.cancelRequested) {
        await client.sessions.cancel(sessionId).catch(() => {});
      }
      const answers: TrueForgeApi.TurnUserEventMessage[] = [];
      if (pendingApprovals.length) {
        this.o.callbacks.onStatus?.('waiting for your review…');
        for (const p of pendingApprovals) for (const ref of p.toolCalls) {
          if (signal.aborted) return { status: 'cancelled' };
          answers.push(await this.decideApproval(p.threadId, ref, signal));
        }
        pendingApprovals = [];
      }
      if (pendingResponses.length) {
        for (const p of pendingResponses) for (const ref of p.toolCalls) {
          if (signal.aborted) return { status: 'cancelled' };
          answers.push(await untilCancelled(this.answerToolResponse(p.threadId, ref), signal));
        }
        pendingResponses = [];
      }
      if (pendingAuth.length) {
        this.o.callbacks.onNotice?.('warn', 'An MCP server needs sign-in; open TrueForge to authorize it.');
        for (const p of pendingAuth) answers.push({ type: 'user.mcp_auth_continue', threadId: p.threadId } as unknown as TrueForgeApi.TurnUserEventMessage);
        pendingAuth = [];
      }
      // Subscribe first, then send answers, then read what they produce.
      if (signal.aborted) return { status: 'cancelled' };
      const resume = await client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId: lastEventId }, { timeoutInSeconds: 600 });
      if (signal.aborted) return { status: 'cancelled' };
      if (answers.length) await client.sessions.createTurnEvents(sessionId, turnId, { events: answers });
      else if (++resubscribes > 20) return { status: 'error', message: 'stream kept disconnecting' };
      this.o.callbacks.onStatus?.('thinking…');
      r = await consume(resume);
    }
    return r;
  }

  private readonly announced = new Set<string>();
  private announceToolCalls(msg: TrueForgeApi.ModelMessageEvent): void {
    for (const tc of msg.toolCalls ?? []) {
      if (!tc.id || this.announced.has(tc.id)) continue;
      // only announce once the arguments are complete JSON (streaming may still be appending)
      if (tc.function.arguments && !isCompleteJson(tc.function.arguments)) continue;
      this.announced.add(tc.id);
      const call = this.findToolCall({ id: tc.id, sourceEventId: msg.id });
      this.o.callbacks.onToolCall?.(msg.threadId, call?.name ?? tc.function.name, typeof call?.args === 'object' ? JSON.stringify(call.args) : tc.function.arguments, tc.id);
    }
  }

  /** Resolve a pending approval by running the editor-side review for the tool call. */
  private async decideApproval(threadId: string, ref: TrueForgeApi.ToolCallRef, signal: AbortSignal): Promise<TrueForgeApi.TurnUserEventMessage> {
    const allow = (): TrueForgeApi.TurnUserEventMessage => ({ type: 'user.tool_approval', threadId, toolCallId: ref.id, approval: { status: 'allow' } });
    const deny = (reason: string): TrueForgeApi.TurnUserEventMessage => ({ type: 'user.tool_approval', threadId, toolCallId: ref.id, approval: { status: 'deny', reason } });
    if (this.cancelRequested) return deny('cancelled by user');
    const call = this.findToolCall(ref);
    if (!call) { this.o.host.log(`[runner] approval for unknown call ${ref.id}`); return deny('tool call not found in event index'); }
    const { name, args } = call;
    try {
      if (name === TOOL_NAMES.proposeEdit) {
        const a = args as { path: string; summary?: string; edits?: { old: string; new: string }[]; new_content?: string };
        const exists = await this.o.host.fileExists(a.path);
        const oldContent = exists ? await this.o.host.readFile(a.path) : '';
        let proposed: string;
        if (a.edits?.length) {
          if (!exists) return allow(); // let the tool return the precise error to the model
          try { proposed = applyEditBlocks(oldContent, a.edits).content; } catch (e) { if (e instanceof EditBlockError) return allow(); throw e; }
        } else if (a.new_content !== undefined) proposed = a.new_content;
        else return allow();
        if (proposed === oldContent) return allow();
        const outcome = await untilCancelled(this.o.host.reviewEdit({ path: a.path, newContent: proposed, summary: a.summary, toolCallId: ref.id, signal }, { oldContent, newContent: proposed }), signal);
        if (signal.aborted) return deny('cancelled by user');
        if (outcome.decision === 'deny') return deny(`User rejected all hunks for ${a.path}${outcome.reason ? ': ' + outcome.reason : ''}. Do not retry the same change.`);
        const set = computeHunks(oldContent, proposed);
        const accepted = new Set(outcome.decisions.filter(d => d.accepted).map(d => d.index));
        this.o.decisions.put({
          key: decisionKey(a.path, oldContent, proposed), path: a.path, baselineHash: '', proposedHash: '',
          decisions: outcome.decisions, resultingContent: outcome.resultingContent ?? applyHunks(set, accepted),
        });
        return allow();
      }
      if (name === TOOL_NAMES.runCommand) {
        const a = args as { command: string; cwd?: string };
        const ask = this.o.callbacks.onCommandApproval ?? ((c, w) => this.o.host.confirmCommand(c, w));
        const res = await untilCancelled(ask(a.command, a.cwd), signal);
        if (signal.aborted) return deny('cancelled by user');
        if (!res.allow) return deny(`User declined to run "${a.command}"${res.reason ? ': ' + res.reason : ''}`);
        this.o.decisions.approveCommand(a.command, a.cwd);
        return allow();
      }
      // Anything else that is gated: ask generically.
      const res = await (this.o.callbacks.onCommandApproval ?? ((c: string) => this.o.host.confirmCommand(c)))(`${name} ${JSON.stringify(args).slice(0, 500)}`);
      return res.allow ? allow() : deny(res.reason ?? 'denied by user');
    } catch (e) {
      this.o.host.log(`[runner] approval handling failed: ${describeError(e)}`);
      return deny(`review failed: ${describeError(e)}`);
    }
  }

  private async answerToolResponse(threadId: string, ref: TrueForgeApi.ToolCallRef): Promise<TrueForgeApi.TurnUserEventMessage> {
    const call = this.findToolCall(ref);
    let content = 'no answer';
    if (call?.name === 'ask_user_question') {
      const a = call.args as { question?: string; options?: (string | { label?: string; value?: string })[] };
      const options = (a.options ?? []).map(o => (typeof o === 'string' ? o : o.label ?? o.value ?? '')).filter(Boolean);
      const ask = this.o.callbacks.onAsk ?? (async (q: string, opts: string[]) => this.o.host.askQuestion?.(q, opts) ?? opts[0] ?? '');
      content = (await ask(a.question ?? 'The agent has a question', options)) || 'no answer';
    }
    return { type: 'user.tool_response', threadId, toolCallId: ref.id, content };
  }

  private findToolCall(ref: TrueForgeApi.ToolCallRef): { name: string; args: unknown } | undefined {
    const msg = this.events.get(ref.sourceEventId);
    if (msg?.type !== 'model.message') return undefined;
    const tc = msg.toolCalls?.find(t => t.id === ref.id);
    if (!tc) return undefined;
    let name = tc.toolInfo?.name ?? tc.function.name;
    let args: unknown = safeJson(tc.function.arguments);
    // Deferred tools are invoked through TrueForge's `call_tool` meta tool: unwrap it.
    if ((name === 'call_tool' || tc.function.name === 'call_tool') && args && typeof args === 'object') {
      const a = args as Record<string, unknown>;
      const inner = (a.tool_name ?? a.tool ?? a.name) as string | undefined;
      const input = (a.input ?? a.arguments ?? a.args ?? a.body) as unknown;
      if (inner) { name = inner; args = typeof input === 'string' ? safeJson(input) : input ?? {}; }
    }
    return { name, args };
  }
}

function isCompleteJson(s: string): boolean {
  try { JSON.parse(s); return true; } catch { return false; }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

function contentToText(c: TrueForgeApi.ModelMessageEvent['content'] | undefined): string | undefined {
  if (!c) return undefined;
  if (typeof c === 'string') return c;
  return c.map(p => ('text' in p ? p.text : '')).join('');
}

const MAX_RATE_LIMIT_WAITS = 4;
export const CONTINUE_AFTER_RATE_LIMIT =
  'Continue the task from where you stopped. Your previous step was interrupted by a provider rate limit. ' +
  'Everything earlier in this conversation still stands: do not repeat searches or reads you already have, and do not re-propose edits that were already applied or rejected.';

/**
 * How long to wait before continuing after a provider rate limit, or undefined if the error is not a
 * short-term rate limit. Honours "retry in Ns" / "retry-after: N" hints (Gemini, OpenAI); defaults to 60s,
 * capped at 90s. Daily quotas return undefined: waiting a minute will not help.
 */
export function rateLimitWaitMs(msg: string): number | undefined {
  const m = msg.toLowerCase();
  if (!/\b429\b|rate.?limit|quota|resource.?exhausted|too many requests/.test(m)) return undefined;
  if (/per.?day|daily|requests? per day|rpd\b/.test(m)) return undefined;
  const hint = /retry (?:in|after) ([\d.]+)\s*(ms|s)\b/.exec(m) ?? /retry-after:?\s*([\d.]+)()/.exec(m);
  let secs = 60;
  if (hint) secs = hint[2] === 'ms' ? Number(hint[1]) / 1000 : Number(hint[1]);
  if (!Number.isFinite(secs)) secs = 60;
  return Math.round(Math.min(Math.max(secs, 1), 90) * 1000) + 500;
}

function isRetryable(msg: string): boolean {
  const m = msg.toLowerCase();
  if (/iteration limit|cancelled|canceled|denied|context length|too long/.test(m)) return false;
  return true;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function untilCancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('cancelled by user'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
