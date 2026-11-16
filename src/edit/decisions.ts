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
    return this.byKey.get(key);
  }

  // Commands approved during TrueForge's approval pause, so the MCP handler does not ask twice.
  private readonly approvedCommands = new Map<string, number>();

  approveCommand(command: string): void { this.approvedCommands.set(command, Date.now()); }

  takeCommandApproval(command: string): boolean {
    const t = this.approvedCommands.get(command);
    if (t === undefined) return false;
    this.approvedCommands.delete(command);
    return Date.now() - t < this.ttlMs;
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, v] of this.byKey) if (now - v.createdAt > this.ttlMs) this.byKey.delete(k);
  }
}
