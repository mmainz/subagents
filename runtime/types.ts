import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { SubagentConfig } from "../agents.js";

export type AgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "stopped";

export interface AgentRecord {
  id: string;
  agent: SubagentConfig;
  task: string;
  cwd: string;
  description?: string;
  status: AgentStatus;
  runInBackground: boolean;
  result?: string;
  error?: string;
  stopReason?: string;
  startedAt?: number;
  completedAt?: number;
  model?: string;
  thinking?: string;
  session?: AgentSession;
  abortController: AbortController;
  promise?: Promise<string>;
  completionResolve?: (value: string) => void;
  toolUses: number;
}

export interface AgentActivity {
  id: string;
  agentName: string;
  activeTool?: string;
  latestText?: string;
  toolUses: number;
  startedAt: number;
  updatedAt: number;
}

export interface AgentRunCallbacks {
  onSessionCreated?: (session: AgentSession) => void;
  onToolActivity?: (toolName: string, args: Record<string, unknown>) => void;
  onTextUpdate?: (text: string) => void;
}
