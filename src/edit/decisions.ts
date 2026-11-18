/**
 * Review decisions made during TrueForge's tool-approval pause are stored here, keyed by
 * (path, baseline hash, proposed hash). When TrueForge later executes the approved `propose_edit`
 * tool call, the MCP handler looks the decision up and applies only the accepted hunks.
 *
 * This is the bridge that lets the harness's approval gate drive a per-hunk review.
 */
import { sha1 } from '../util/text';
import type { HunkDecision } from '../host/types';

export interface StoredDecision {
  key: string;
  path: string;
  baselineHash: string;
  proposedHash: string;
  decisions: HunkDecision[];
  resultingContent: string;
  createdAt: number;
}

export function decisionKey(path: string, baseline: string, proposed: string): string {
  return `${path}#${sha1(baseline)}#${sha1(proposed)}`;
}

export class DecisionStore {
  private controller = new AbortController();
  private effects = 0;
  get hasSideEffects(): boolean { return this.effects > 0; }
  recordSideEffect(): void { this.effects++; }
  get signal(): AbortSignal { return this.controller.signal; }
  beginTurn(): void { this.clear(); this.effects = 0; this.controller = new AbortController(); }
  cancelTurn(): void { this.controller.abort(); this.clear(); }
  clear(): void { this.byKey.clear(); this.approvedCommands.clear(); }
  private readonly byKey = new Map<string, StoredDecision>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  put(d: Omit<StoredDecision, 'createdAt'>): void {
    this.gc();
    this.byKey.set(d.key, { ...d, createdAt: Date.now() });
  }

  take(key: string): StoredDecision | undefined {
    this.gc();
    const d = this.byKey.get(key);
    if (d) this.byKey.delete(key);
    return d;
  }

  peek(key: string): StoredDecision | undefined {
    this.gc();
    return this.byKey.get(key);
  }

  // Commands approved during TrueForge's approval pause, so the MCP handler does not ask twice.
  private readonly approvedCommands = new Map<string, number>();

  approveCommand(command: string, cwd?: string): void { this.approvedCommands.set(JSON.stringify([command, cwd ?? '.']), Date.now()); }

  takeCommandApproval(command: string, cwd?: string): boolean {
    const key = JSON.stringify([command, cwd ?? '.']);
    const t = this.approvedCommands.get(key);
    if (t === undefined) return false;
    this.approvedCommands.delete(key);
    return Date.now() - t < this.ttlMs;
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.byKey) if (now - v.createdAt > this.ttlMs) this.byKey.delete(k);
  }
}
