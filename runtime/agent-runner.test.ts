import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentConfig } from "../agents.js";
import { formatAgentConversation, runAgentInProcess } from "./agent-runner.js";

const piMocks = vi.hoisted(() => ({
  createAgentSessionServices: vi.fn(),
  createAgentSessionFromServices: vi.fn(),
  getAgentDir: vi.fn(),
  sessionManagerInMemory: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSessionServices: piMocks.createAgentSessionServices,
  createAgentSessionFromServices: piMocks.createAgentSessionFromServices,
  getAgentDir: piMocks.getAgentDir,
  SessionManager: { inMemory: piMocks.sessionManagerInMemory },
}));

function makeAgent(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    name: "runner-agent",
    description: "Runner agent",
    model: "provider/model",
    thinking: "low",
    tools: ["read", "subagent", "bash", "get_subagent_result"],
    extensions: false,
    enabled: true,
    inheritContext: true,
    inheritSkills: false,
    promptMode: "append",
    conversationContext: "isolated",
    systemPrompt: "Runner prompt.",
    filePath: "/tmp/runner-agent.md",
    scope: "default",
    ...overrides,
  };
}

function makeContext(options: { model?: unknown; hasAuth?: boolean } = {}) {
  const model = Object.hasOwn(options, "model")
    ? options.model
    : { provider: "provider", id: "model" };
  return {
    modelRegistry: {
      authStorage: { auth: true },
      find: vi.fn(() => model),
      hasConfiguredAuth: vi.fn(() => options.hasAuth ?? true),
    },
    sessionManager: {
      buildSessionContext: vi.fn(() => ({
        messages: [{ role: "user", content: "Parent context" }],
      })),
    },
  };
}

function makeSession() {
  const session = {
    messages: [] as unknown[],
    model: { provider: "provider", id: "model" },
    thinkingLevel: "minimal",
    subscribe: vi.fn((handler: (event: unknown) => void) => {
      session.handler = handler;
      return session.unsubscribe;
    }),
    unsubscribe: vi.fn(),
    prompt: vi.fn(async () => {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "Runner output" }],
        stopReason: "stop",
      };
      session.messages.push(assistant);
      session.handler?.({ type: "message_end", message: assistant });
      session.handler?.({ type: "agent_end", messages: session.messages });
    }),
    abort: vi.fn(),
    handler: undefined as ((event: unknown) => void) | undefined,
  };
  return session;
}

beforeEach(() => {
  vi.clearAllMocks();
  piMocks.getAgentDir.mockReturnValue("/agent-dir");
  piMocks.sessionManagerInMemory.mockReturnValue({ inMemory: true });
  piMocks.createAgentSessionServices.mockResolvedValue({ services: true });
  piMocks.createAgentSessionFromServices.mockResolvedValue({
    session: makeSession(),
  });
});

describe("runAgentInProcess", () => {
  it("rejects already-aborted signals", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAgentInProcess(makeContext() as never, makeAgent(), {
        task: "task",
        cwd: "/tmp",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ stopReason: "aborted" });
    expect(piMocks.createAgentSessionServices).not.toHaveBeenCalled();
  });

  it("validates configured model format, availability, and auth", async () => {
    await expect(
      runAgentInProcess(
        makeContext() as never,
        makeAgent({ model: "missing-slash" }),
        { task: "task", cwd: "/tmp" },
      ),
    ).rejects.toThrow("Expected provider/model");

    await expect(
      runAgentInProcess(
        makeContext({ model: undefined }) as never,
        makeAgent(),
        { task: "task", cwd: "/tmp" },
      ),
    ).rejects.toThrow("was not found");

    await expect(
      runAgentInProcess(makeContext({ hasAuth: false }) as never, makeAgent(), {
        task: "task",
        cwd: "/tmp",
      }),
    ).rejects.toThrow("has no configured auth");
  });

  it("filters recursive subagent tools from child sessions", async () => {
    await runAgentInProcess(makeContext() as never, makeAgent(), {
      task: "task",
      cwd: "/tmp",
    });

    expect(piMocks.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["read", "bash"],
      }),
    );
  });

  it("configures append and replace prompt modes", async () => {
    await runAgentInProcess(
      makeContext() as never,
      makeAgent({ promptMode: "replace", systemPrompt: "Replace prompt" }),
      { task: "task", cwd: "/tmp" },
    );
    let resourceOptions =
      piMocks.createAgentSessionServices.mock.calls.at(-1)?.[0]
        .resourceLoaderOptions;
    expect(resourceOptions.systemPromptOverride()).toBe("Replace prompt");
    expect(resourceOptions.appendSystemPromptOverride()).toEqual([]);

    await runAgentInProcess(
      makeContext() as never,
      makeAgent({ promptMode: "append", systemPrompt: "Append prompt" }),
      { task: "task", cwd: "/tmp" },
    );
    resourceOptions =
      piMocks.createAgentSessionServices.mock.calls.at(-1)?.[0]
        .resourceLoaderOptions;
    expect(resourceOptions.systemPromptOverride).toBeUndefined();
    expect(resourceOptions.appendSystemPromptOverride(["Base"])).toEqual([
      "Base",
      "Append prompt",
    ]);
  });

  it("forks parent conversation context only for fork agents", async () => {
    const forkSession = makeSession();
    const forkContext = makeContext();
    piMocks.createAgentSessionFromServices.mockResolvedValueOnce({
      session: forkSession,
    });
    await runAgentInProcess(
      forkContext as never,
      makeAgent({ conversationContext: "fork" }),
      { task: "task", cwd: "/tmp" },
    );
    expect(
      forkContext.sessionManager.buildSessionContext,
    ).toHaveBeenCalledTimes(1);
    expect(forkSession.messages[0]).toEqual({
      role: "user",
      content: "Parent context",
    });

    const isolatedSession = makeSession();
    const isolatedContext = makeContext();
    piMocks.createAgentSessionFromServices.mockResolvedValueOnce({
      session: isolatedSession,
    });
    await runAgentInProcess(
      isolatedContext as never,
      makeAgent({ conversationContext: "isolated" }),
      { task: "task", cwd: "/tmp" },
    );
    expect(
      isolatedContext.sessionManager.buildSessionContext,
    ).not.toHaveBeenCalled();
    expect(JSON.stringify(isolatedSession.messages)).not.toContain(
      "Parent context",
    );
  });

  it("filters this extension when child extensions are enabled", async () => {
    await runAgentInProcess(
      makeContext() as never,
      makeAgent({ extensions: true }),
      { task: "task", cwd: "/tmp" },
    );

    const resourceOptions =
      piMocks.createAgentSessionServices.mock.calls.at(-1)?.[0]
        .resourceLoaderOptions;
    const filtered = resourceOptions.extensionsOverride({
      extensions: [
        { path: path.resolve(process.cwd(), "index.ts") },
        { path: path.resolve(process.cwd(), "other-extension.ts") },
      ],
    });

    expect(filtered.extensions).toEqual([
      { path: path.resolve(process.cwd(), "other-extension.ts") },
    ]);
  });
});

describe("formatAgentConversation", () => {
  it("renders user, assistant, and tool result messages", () => {
    const session = {
      messages: [
        {
          role: "user",
          content: "Map the repository.",
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I found the main files." },
            { type: "tool_use", id: "call-1", name: "read" },
            { type: "text", text: "Here is the summary." },
          ],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "README contents" }],
        },
      ],
    };

    expect(formatAgentConversation(session)).toBe(
      [
        "## User\nMap the repository.",
        "## Assistant\nI found the main files.\nHere is the summary.",
        '## Tool result\n[\n  {\n    "type": "text",\n    "text": "README contents"\n  }\n]',
      ].join("\n\n"),
    );
  });

  it("ignores non-text blocks and missing messages", () => {
    expect(
      formatAgentConversation({
        messages: [
          { role: "user", content: [{ type: "image", source: {} }] },
          { role: "assistant", content: [{ type: "tool_use", name: "read" }] },
          { role: "system", content: "Hidden" },
        ],
      }),
    ).toBe("## User\n\n## Assistant");

    expect(formatAgentConversation({})).toBe("");
  });
});
