/**
 * The host abstraction: everything the agent's tools need from "the editor".
 *
 * Two implementations exist:
 *   - VsCodeHost   (src/host/vscodeHost.ts)  — the real thing, inside the extension host
 *   - HeadlessHost (src/host/headlessHost.ts) — plain Node + filesystem, used by scripts/headless-e2e
 *     and unit tests so the MCP server, retriever and TrueForge plumbing can be exercised without VS Code.
 *
 * Keeping the MCP tools host-agnostic is what lets us test the TrueForge loop in CI.
 */

export interface FileStat {
  size: number;
  isDirectory: boolean;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface SymbolInfo {
  name: string;
  kind: string; // 'class' | 'function' | 'method' | 'variable' | ...
  startLine: number; // 1-based inclusive
  endLine: number; // 1-based inclusive
  container?: string;
}

export interface Diagnostic {
  path: string;
  line: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** A search-and-replace block. `old` must match exactly once (after whitespace-tolerant fallback). */
export interface EditBlock {
  old: string;
  new: string;
}

export interface ProposeEditRequest {
  signal?: AbortSignal;
  /** workspace-relative path */
  path: string;
  /** Either a full replacement, or a list of search/replace blocks against the current content. */
  newContent?: string;
  edits?: EditBlock[];
  /** One-line summary shown in the review UI. */
  summary?: string;
  /** Tool call id when known (approval flow) so the host can correlate decisions. */
  toolCallId?: string;
}

export interface HunkDecision {
  index: number;
  accepted: boolean;
  reason?: string;
}

export interface ReviewOutcome {
  /** 'allow' = at least one hunk accepted; 'deny' = user rejected everything or cancelled. */
  decision: 'allow' | 'deny';
  decisions: HunkDecision[];
  reason?: string;
  /** The content that will exist on disk after applying the accepted hunks. */
  resultingContent?: string;
  /** Key under which the decision was stored, so the executing tool can look it up. */
  key: string;
}

export interface ApplyResult {
  applied: number;
  rejected: number;
  totalHunks: number;
  created: boolean;
  /** unified diff of what was actually written */
  appliedDiff: string;
  rejectedSummary: string[];
}

export interface WorkspaceHost {
  readonly rootPath: string;
  readonly kind: 'vscode' | 'headless';

  /** All indexable files (relative, forward slashes), honouring .gitignore and binary/size filters. */
  listFiles(): Promise<string[]>;
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  fileExists(relPath: string): Promise<boolean>;
  stat(relPath: string): Promise<FileStat>;
  listDir(relPath: string): Promise<DirEntry[]>;

  /** Symbols for a file; VS Code uses the language server when available, otherwise regex outline. */
  documentSymbols(relPath: string): Promise<SymbolInfo[]>;
  diagnostics(relPath?: string): Promise<Diagnostic[]>;
  /** Files currently open in editors (VS Code) — a strong signal for what the user cares about. */
  openFiles(): Promise<{ path: string; active: boolean; selection?: { startLine: number; endLine: number } }[]>;

  runCommand(command: string, opts?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult>;

  /**
   * Show the proposed change to the user hunk by hunk and wait for their decisions.
   * Nothing is written to disk here. Returns the decisions; `applyEdit` does the write.
   */
  reviewEdit(req: ProposeEditRequest, hunksPreview: { oldContent: string; newContent: string }): Promise<ReviewOutcome>;

  /** Apply the accepted hunks (undoable in VS Code). */
  applyEdit(relPath: string, oldContent: string, resultingContent: string): Promise<void>;

  /** Ask the user to allow/deny a shell command. */
  confirmCommand(command: string, cwd?: string): Promise<{ allow: boolean; reason?: string }>;

  /** Ask the user a multiple-choice question (TrueForge ask_user_question). */
  askQuestion?(question: string, options: string[]): Promise<string>;

  log(message: string): void;
}
