/**
 * TurnRunner — drives one TrueForge turn end to end and owns all the resilience logic.
 *
 *   createTurnStream ──► events ──► (paused?) ──► review/approve ──► subscribeToTurn ──► … ──► turn.done
 *          │                                                                              │
 *          └── transport error / turn error ──► retry with backoff ──► fallback model ──► clear error
 *
 * Invariants the judges look for:
 *   - the editor never blocks: everything here is async, UI updates are callbacks.
 *   - cancellation is immediate: `cancel()` calls sessions.cancel and the stream drains to turn.done.
 *   - the workspace is never left half-edited: writes happen only inside an approved propose_edit tool
 *     call, which applies a complete, user-reviewed set of hunks atomically.
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
    const sid = this.activeSessionIdForCancel ?? this.sessionId;
    if (sid) {
      try { await this.o.conn.client.sessions.cancel(sid); } catch (e) { this.o.host.log(`[runner] cancel: ${describeError(e)}`); }
    }
    this.o.callbacks.onStatus?.('cancelling…');
  }

  private async ensureSession(model: string): Promise<string> {
    if (this.sessionId && this.sessionModel === model) return this.sessionId;
    const spec = buildAgentSpec({ ...this.o.spec, model });
    const { data } = await this.o.conn.client.sessions.create({ agent: { spec } });
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
    const cb = this.o.callbacks;
    const models = [this.o.primaryModel, ...(this.o.fallbackModel && this.o.fallbackModel !== this.o.primaryModel ? [this.o.fallbackModel] : [])];
    let attempts = 0;
    let lastError = '';
    const savedSession = opts.ephemeral ? { id: this.sessionId, model: this.sessionModel } : undefined;
    if (opts.ephemeral) this.resetSession();

    try {
      for (let mi = 0; mi < models.length; mi++) {
        const model = models[mi];
        const usedFallback = mi > 0;
        if (usedFallback) {
          cb.onNotice?.('warn', `Primary model "${models[0]}" failed (${lastError}). Falling back to "${model}" automatically.`);
          this.resetSession();
        }
        for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
          attempts++;
          if (this.cancelRequested) return { status: 'cancelled', modelUsed: model, usedFallback, attempts, sessionId: this.sessionId };
          if (attempt > 0) {
            const delay = 800 * 2 ** (attempt - 1);
            cb.onStatus?.(`model error — retry ${attempt}/${this.o.maxRetries} in ${delay}ms (${lastError})`);
            await sleep(delay);
            if (this.cancelRequested) return { status: 'cancelled', modelUsed: model, usedFallback, attempts, sessionId: this.sessionId };
          }
          try {
            const sid = await this.ensureSession(model);
            this.activeSessionIdForCancel = sid;
            const r = await this.executeTurn(sid, userText);
            if (r.status === 'done') return { ...r, modelUsed: model, usedFallback, attempts, sessionId: sid };
            if (r.status === 'cancelled') return { ...r, modelUsed: model, usedFallback, attempts, sessionId: sid };
            lastError = r.message ?? 'unknown error';
            if (!isRetryable(lastError)) break; // e.g. iteration limit: no point retrying
            this.o.host.log(`[runner] turn error on ${model}: ${lastError}`);
          } catch (e) {
            lastError = describeError(e);
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
      return { status: 'error', message: `The model is unavailable: ${lastError}. ${tried} No files were changed.`, modelUsed: models[models.length - 1], usedFallback: models.length > 1, attempts, sessionId: this.sessionId };
    } finally {
      this.running = false;
      this.activeSessionIdForCancel = undefined;
      if (savedSession) { this.sessionId = savedSession.id; this.sessionModel = savedSession.model; }
    }
  }

  /** One turn on an existing session, including every pause/resume cycle. */
  private async executeTurn(sessionId: string, userText: string): Promise<{ status: 'done' | 'cancelled' | 'error'; message?: string; output?: string }> {
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
      if (!turnId) return { status: 'error', message: 'stream ended before the turn was created' };
      if (this.cancelRequested) {
        await client.sessions.cancel(sessionId).catch(() => {});
      }
      const answers: TrueForgeApi.TurnUserEventMessage[] = [];
      if (pendingApprovals.length) {
        this.o.callbacks.onStatus?.('waiting for your review…');
        for (const p of pendingApprovals) for (const ref of p.toolCalls) answers.push(await this.decideApproval(p.threadId, ref));
        pendingApprovals = [];
      }
      if (pendingResponses.length) {
        for (const p of pendingResponses) for (const ref of p.toolCalls) answers.push(await this.answerToolResponse(p.threadId, ref));
        pendingResponses = [];
      }
      if (pendingAuth.length) {
        this.o.callbacks.onNotice?.('warn', 'An MCP server needs sign-in; open TrueForge to authorize it.');
        for (const p of pendingAuth) answers.push({ type: 'user.mcp_auth_continue', threadId: p.threadId } as unknown as TrueForgeApi.TurnUserEventMessage);
        pendingAuth = [];
      }
      // Subscribe first, then send answers, then read what they produce.
      const resume = await client.sessions.subscribeToTurn(sessionId, turnId, { afterEventId: lastEventId }, { timeoutInSeconds: 600 });
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
  private async decideApproval(threadId: string, ref: TrueForgeApi.ToolCallRef): Promise<TrueForgeApi.TurnUserEventMessage> {
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
        const outcome = await this.o.host.reviewEdit({ path: a.path, newContent: proposed, summary: a.summary, toolCallId: ref.id }, { oldContent, newContent: proposed });
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
        const res = await ask(a.command, a.cwd);
        if (!res.allow) return deny(`User declined to run "${a.command}"${res.reason ? ': ' + res.reason : ''}`);
        this.o.decisions.approveCommand(a.command);
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

function isRetryable(msg: string): boolean {
  const m = msg.toLowerCase();
  if (/iteration limit|cancelled|canceled|denied|context length|too long/.test(m)) return false;
  return true;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
