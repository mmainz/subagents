import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type AgentScope = "default" | "user";
export type PromptMode = "append" | "replace";
export type ConversationContextMode = "isolated" | "fork";

export interface SubagentConfig {
  name: string;
  description: string;
  useWhen?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools: string[];
  extensions: boolean;
  enabled: boolean;
  inheritContext: boolean;
  inheritSkills: boolean;
  promptMode: PromptMode;
  conversationContext: ConversationContextMode;
  systemPrompt: string;
  filePath: string;
  scope: AgentScope;
}

export interface DisabledSubagentConfig {
  name: string;
  filePath: string;
  scope: AgentScope;
}

export interface SubagentRegistry {
  agents: SubagentConfig[];
  disabledAgents: DisabledSubagentConfig[];
  warnings: string[];
}

export interface DiscoverSubagentRegistryOptions {
  defaultAgentsDir?: string;
  userAgentsDir?: string;
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENTS_DIR = path.join(EXTENSION_DIR, "agents");
const USER_AGENTS_DIR = path.join(getAgentDir(), "subagents");

interface RawMarkdownAgent {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseMarkdownAgent(filePath: string): RawMarkdownAgent {
  const content = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } =
    parseFrontmatter<Record<string, unknown>>(content);
  return { frontmatter, body: body.trim() };
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim() as ThinkingLevel;
  return THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

function parsePromptMode(value: unknown): PromptMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "append" || normalized === "replace") return normalized;
  return undefined;
}

function parseConversationContext(
  value: unknown,
): ConversationContextMode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "isolated" || normalized === "fork") return normalized;
  return undefined;
}

function normalizeAgent(
  filePath: string,
  scope: AgentScope,
  warnings: string[],
): SubagentConfig | DisabledSubagentConfig | undefined {
  let parsed: RawMarkdownAgent;
  try {
    parsed = parseMarkdownAgent(filePath);
  } catch (error) {
    warnings.push(
      `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  const raw = parsed.frontmatter;
  const name = parseString(raw.name);
  if (!name) {
    warnings.push(
      `Agent file ${filePath} is missing required frontmatter field 'name'.`,
    );
    return undefined;
  }

  const enabled = parseBoolean(raw.enabled, true);
  if (!enabled) return { name, filePath, scope };

  const description = parseString(raw.description);
  if (!description) {
    warnings.push(
      `Agent '${name}' in ${filePath} is missing required field 'description' and was ignored.`,
    );
    return undefined;
  }

  const thinking = parseThinking(raw.thinking);
  const rawPromptMode = raw.prompt_mode ?? raw.promptMode;
  const promptMode = parsePromptMode(rawPromptMode);
  const rawConversationContext =
    raw.conversation_context ?? raw.conversationContext;
  const conversationContext = parseConversationContext(rawConversationContext);

  if (raw.thinking !== undefined && !thinking) {
    warnings.push(
      `Agent '${name}' in ${filePath} has invalid thinking level '${String(raw.thinking)}'.`,
    );
  }
  if (!parseString(raw.model)) {
    warnings.push(`Agent '${name}' in ${filePath} has no model configured.`);
  }
  if (!thinking) {
    warnings.push(
      `Agent '${name}' in ${filePath} has no thinking level configured.`,
    );
  }
  if (!parsed.body.trim()) {
    warnings.push(`Agent '${name}' in ${filePath} has an empty prompt body.`);
  }
  if (rawPromptMode !== undefined && !promptMode) {
    warnings.push(
      `Agent '${name}' in ${filePath} has invalid prompt_mode '${String(rawPromptMode)}'. Expected 'append' or 'replace'.`,
    );
  }
  if (rawConversationContext !== undefined && !conversationContext) {
    warnings.push(
      `Agent '${name}' in ${filePath} has invalid conversation_context '${String(rawConversationContext)}'. Expected 'isolated' or 'fork'.`,
    );
  }

  return {
    name,
    description,
    useWhen: parseString(raw.use_when ?? raw.useWhen),
    model: parseString(raw.model),
    thinking,
    tools: parseStringList(raw.tools),
    extensions: parseBoolean(raw.extensions, false),
    enabled,
    inheritContext: parseBoolean(
      raw.inherit_context ?? raw.inheritContext,
      true,
    ),
    inheritSkills: parseBoolean(raw.inherit_skills ?? raw.inheritSkills, false),
    promptMode: promptMode || "append",
    conversationContext: conversationContext || "isolated",
    systemPrompt: parsed.body.trim(),
    filePath,
    scope,
  };
}

function listMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))
    .map((fileName) => path.join(dir, fileName));
}

function applyAgentLayer(
  registry: Map<string, SubagentConfig>,
  disabled: Map<string, DisabledSubagentConfig>,
  dir: string,
  scope: AgentScope,
  warnings: string[],
) {
  const seenInLayer = new Set<string>();
  for (const filePath of listMarkdownFiles(dir)) {
    const agent = normalizeAgent(filePath, scope, warnings);
    if (!agent) continue;

    if (seenInLayer.has(agent.name)) {
      warnings.push(
        `Duplicate ${scope} subagent '${agent.name}' in ${dir}; later file wins.`,
      );
    }
    seenInLayer.add(agent.name);

    if ("enabled" in agent && agent.enabled) {
      registry.set(agent.name, agent);
      disabled.delete(agent.name);
    } else {
      registry.delete(agent.name);
      disabled.set(agent.name, agent);
    }
  }
}

export function discoverSubagentRegistry(
  options: DiscoverSubagentRegistryOptions = {},
): SubagentRegistry {
  const warnings: string[] = [];
  const agents = new Map<string, SubagentConfig>();
  const disabledAgents = new Map<string, DisabledSubagentConfig>();
  const defaultAgentsDir = options.defaultAgentsDir ?? DEFAULT_AGENTS_DIR;
  const userAgentsDir = options.userAgentsDir ?? USER_AGENTS_DIR;

  applyAgentLayer(
    agents,
    disabledAgents,
    defaultAgentsDir,
    "default",
    warnings,
  );
  applyAgentLayer(agents, disabledAgents, userAgentsDir, "user", warnings);

  return {
    agents: [...agents.values()].sort((a, b) => a.name.localeCompare(b.name)),
    disabledAgents: [...disabledAgents.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    warnings,
  };
}

export function formatAgentCatalog(agents: SubagentConfig[]): string {
  if (agents.length === 0) return "No subagents are configured.";

  return agents
    .map((agent) => {
      const lines = [`- ${agent.name} — ${agent.description}`];
      lines.push(
        agent.useWhen
          ? `  use_when: ${agent.useWhen}`
          : "  no use_when: use only when the user explicitly requests it.",
      );
      return lines.join("\n");
    })
    .join("\n");
}

export function formatRegistryWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "No validation warnings.";

  return warnings.map((warning) => `- ${warning}`).join("\n");
}
