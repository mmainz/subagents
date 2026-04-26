import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SubagentConfig } from "../agents.js";
import type { AgentRunCallbacks } from "./types.js";

const RECURSIVE_TOOL_NAMES = new Set(["subagent", "get_subagent_result"]);
const EXTENSION_INDEX_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../index.ts",
);
const EXTENSION_INDEX_REALPATH = safeRealpath(EXTENSION_INDEX_PATH);

function safeRealpath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

class SubagentRunError extends Error {
  stopReason: string;

  constructor(stopReason: string, message: string) {
    super(message);
    this.name = "SubagentRunError";
    this.stopReason = stopReason;
  }
}

function extractAssistantText(message: AgentMessage | undefined): string {
  if (
    !message ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  )
    return "";

  return message.content
    .filter((block): block is { type: "text"; text: string } => {
      return (
        Boolean(block) &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      );
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function getAssistantFailure(
  message: AgentMessage | undefined,
): { stopReason: string; errorMessage?: string } | undefined {
  if (!message || message.role !== "assistant") return undefined;
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  if (stopReason !== "error" && stopReason !== "aborted") return undefined;
  const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
  return {
    stopReason,
    errorMessage: typeof errorMessage === "string" ? errorMessage : undefined,
  };
}

function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return (
        Boolean(block) &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      );
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function resolveConfiguredModel(ctx: ExtensionContext, agent: SubagentConfig) {
  if (!agent.model) return undefined;

  const slash = agent.model.indexOf("/");
  if (slash <= 0 || slash === agent.model.length - 1) {
    throw new Error(
      `Invalid model '${agent.model}' for subagent '${agent.name}'. Expected provider/model.`,
    );
  }

  const provider = agent.model.slice(0, slash);
  const modelId = agent.model.slice(slash + 1);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(
      `Configured model '${agent.model}' for subagent '${agent.name}' was not found.`,
    );
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `Configured model '${agent.model}' for subagent '${agent.name}' has no configured auth.`,
    );
  }
  return model;
}

function filterSelfExtension(base: any) {
  return {
    ...base,
    extensions: base.extensions.filter(
      (extension: { path?: string; resolvedPath?: string }) => {
        const extensionPaths = [
          safeRealpath(extension.path),
          safeRealpath(extension.resolvedPath),
        ];
        return !extensionPaths.includes(EXTENSION_INDEX_REALPATH);
      },
    ),
  };
}

export async function runAgentInProcess(
  ctx: ExtensionContext,
  agent: SubagentConfig,
  input: { task: string; cwd: string; signal?: AbortSignal },
  callbacks: AgentRunCallbacks = {},
): Promise<{
  result: string;
  session: any;
  model?: string;
  thinking?: string;
  stopReason?: string;
  errorMessage?: string;
}> {
  if (input.signal?.aborted) {
    throw new SubagentRunError("aborted", `${agent.name} was aborted.`);
  }

  const services = await createAgentSessionServices({
    cwd: input.cwd,
    agentDir: getAgentDir(),
    authStorage: ctx.modelRegistry.authStorage,
    modelRegistry: ctx.modelRegistry,
    resourceLoaderOptions: {
      noExtensions: !agent.extensions,
      noSkills: !agent.inheritSkills,
      noContextFiles: !agent.inheritContext,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride:
        agent.promptMode === "replace" ? () => agent.systemPrompt : undefined,
      appendSystemPromptOverride:
        agent.promptMode === "replace"
          ? () => []
          : (base: string[]) => [...base, agent.systemPrompt],
      extensionsOverride: agent.extensions ? filterSelfExtension : undefined,
    },
  });

  const model = resolveConfiguredModel(ctx, agent);
  const toolNames = agent.tools.filter(
    (tool) => !RECURSIVE_TOOL_NAMES.has(tool),
  );
  const sessionManager = SessionManager.inMemory(input.cwd);

  if (agent.conversationContext === "fork") {
    for (const message of structuredClone(
      ctx.sessionManager.buildSessionContext().messages,
    )) {
      sessionManager.appendMessage(message);
    }
  }

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: agent.thinking,
    tools: toolNames,
  });

  callbacks.onSessionCreated?.(session);

  let finalText = "";
  let finalAssistant: AgentMessage | undefined;
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      callbacks.onToolActivity?.(event.toolName || "tool", event.args || {});
    }
    if (
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "turn_end"
    ) {
      if (event.message?.role === "assistant") finalAssistant = event.message;
      const text = extractAssistantText(event.message);
      if (text) {
        finalText = text;
        callbacks.onTextUpdate?.(text);
      }
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const lastAssistant = [...event.messages]
        .reverse()
        .find((message: AgentMessage) => message.role === "assistant");
      finalAssistant = lastAssistant;
      const text = extractAssistantText(lastAssistant);
      if (text) {
        finalText = text;
        callbacks.onTextUpdate?.(text);
      }
    }
  });

  const onAbort = () => {
    void session.abort();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (input.signal?.aborted) {
      throw new SubagentRunError("aborted", `${agent.name} was aborted.`);
    }
    await session.prompt(input.task, { expandPromptTemplates: false });
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message: AgentMessage) => message.role === "assistant");
    finalAssistant = finalAssistant || lastAssistant;
    if (!finalText) finalText = extractAssistantText(finalAssistant);

    const failure = getAssistantFailure(finalAssistant);
    if (failure) {
      throw new SubagentRunError(
        failure.stopReason,
        failure.errorMessage ||
          `${agent.name} stopped with ${failure.stopReason}`,
      );
    }

    return {
      result: finalText,
      session,
      model: session.model
        ? `${session.model.provider}/${session.model.id}`
        : agent.model,
      thinking: session.thinkingLevel,
      stopReason: (finalAssistant as { stopReason?: string } | undefined)
        ?.stopReason,
      errorMessage: (finalAssistant as { errorMessage?: string } | undefined)
        ?.errorMessage,
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}

export function formatAgentConversation(session: any): string {
  const lines: string[] = [];
  for (const message of session.messages || []) {
    if (message.role === "user") {
      lines.push(`## User\n${extractMessageText(message)}`.trim());
    } else if (message.role === "assistant") {
      lines.push(`## Assistant\n${extractAssistantText(message)}`.trim());
    } else if (message.role === "toolResult") {
      lines.push(
        `## Tool result\n${JSON.stringify(message.content ?? message, null, 2)}`,
      );
    }
  }
  return lines.join("\n\n");
}
