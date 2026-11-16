# Round 1 rubric (from the official problem statement) and where Anvil answers each line

Eligibility gate: loop on TrueForge (sessions/turns via SDK, editor capabilities as MCP tools, local mode, model
configured in TrueForge, TrueForge session shown in the video for Task B, agent definition in repo).
→ `src/trueforge/*`, `src/mcp/server.ts`, `agent/anvil-agent.json`.

| Criterion | Pts | Top anchor | Anvil |
|---|---|---|---|
| A1 Inline edit | 10 | diff rendered with per-hunk accept and reject | `inlineEdit.ts` + `reviewer.ts` (CodeLens per hunk) |
| A2 Agent mode | 10 | discovers and edits ≥3 files unprompted (Task B) | panel + `assemble_context` + agent instructions |
| A3 Streaming & cancellation | 10 | cancellation immediate, workspace consistent | SSE deltas; `sessions.cancel`; writes only inside approved tool calls |
| B1 Context assembly | 15 | retrieval with a size budget, strategy stated, visibly at work in Task B | `retriever.ts` budget + reasons; Context-pack card; write-up §4 |
| B2 Diff safety | 10 | per-hunk review and a working undo, shown on screen | reviewer + `WorkspaceEdit` + `Anvil: Undo Last Applied Change` |
| B3 Resilience | 10 | automatic fallback to a second configured model, no user action, workspace unchanged | `runner.ts` retry/backoff → fallback; e2e scenarios 3–4 |
| B4 TrueForge integration depth | 10 | MCP tools + approval drives review + a context-engineering feature explained & visible | approval→review bridge (`decisions.ts`); selective `preload_tools` (deferred loading); dynamic sub-agents; compaction trigger |
| C1 Video | 10 | all three complete, legible, verified | `docs/DEMO-SCRIPT.md` |
| C2 Write-up | 15 | architecture, context strategy, model setup, trade-offs + accurate scorecard + honest limitations | `WRITEUP.md` |

Shortlist: top 15; a 10-minute live call repeating Task A with the organisers' model — so keep it model-agnostic.
