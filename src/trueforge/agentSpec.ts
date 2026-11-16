/**
 * Builds the inline AgentSpec passed to TrueForge from agent/anvil-agent.json plus user settings.
 * The JSON file is the "agent definition" the competition asks us to ship in the repository.
 */
import agentDefinition from '../../agent/anvil-agent.json';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

export interface SpecOptions {
  model: string;
  mcpServerName: string;
  subagents: boolean;
  compactionTriggerTokens: number;
  iterationLimit: number;
  /** extra instructions appended (e.g. workspace facts) */
  extraInstructions?: string;
}

export function agentInstructions(): string {
  return agentDefinition.manifest.instructions;
}

export function buildAgentSpec(o: SpecOptions): TrueForgeApi.AgentSpec {
  const m = agentDefinition.manifest;
  const mcp = m.mcp_servers[0];
  return {
    model: { name: o.model, params: m.model.params },
    instructions: m.instructions + (o.extraInstructions ? '\n\n## Workspace\n' + o.extraInstructions : ''),
    mcpServers: [
      {
        name: o.mcpServerName,
        enableTools: mcp.enable_tools,
        // Selective preloading (TrueForge deferred tool loading): the four tools used on almost every turn are
        // loaded eagerly; the rest (list_dir, find_symbols, get_diagnostics, open_editors, git_status, run_command)
        // are discovered on demand through TrueForge's meta tools, keeping the system prompt small.
        preloadTools: mcp.preload_tools,
        requireApprovalForTools: mcp.require_approval_for_tools,
      },
    ],
    config: {
      sandbox: { enabled: false },
      webSearch: { enabled: false },
      memory: { enabled: false },
      generativeUi: { enabled: false },
      askUserQuestions: { enabled: true },
      dynamicSubAgents: { enabled: o.subagents },
      contextManagement: {
        compaction: { enabled: true, trigger: { type: 'input_tokens', value: o.compactionTriggerTokens } },
        largeToolResponse: { enabled: false },
      },
      iterationLimit: o.iterationLimit,
    },
  } as TrueForgeApi.AgentSpec;
}
