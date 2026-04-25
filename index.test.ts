import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentConfig } from "./agents.js";
import subagentsMinimal from "./index.js";

const mocks = vi.hoisted(() => ({
  registry: {
    agents: [] as SubagentConfig[],
    disabledAgents: [] as Array<{
      name: string;
      filePath: string;
      scope: "user";
    }>,
    warnings: [] as string[],
  },
  managers: [] as Array<{
    spawn: ReturnType<typeof vi.fn>;
    spawnAndWait: ReturnType<typeof vi.fn>;
    getRecord: ReturnType<typeof vi.fn>;
    clearCompleted: ReturnType<typeof vi.fn>;
    abortAll: ReturnType<typeof vi.fn>;
    listAgents: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("./agents.js", () => ({
  discoverSubagentRegistry: vi.fn(() => mocks.registry),
  formatAgentCatalog: vi.fn((agents: SubagentConfig[]) =>
    agents.map((agent) => `- ${agent.name} — ${agent.description}`).join("\n"),
  ),
  formatRegistryWarnings: vi.fn((warnings: string[]) =>
    warnings.map((warning) => `- ${warning}`).join("\n"),
  ),
}));

vi.mock("./runtime/agent-manager.js", () => ({
  AgentManager: vi.fn().mockImplementation(() => {
    const manager = {
      spawn: vi.fn(),
      spawnAndWait: vi.fn(),
      getRecord: vi.fn(),
      clearCompleted: vi.fn(),
      abortAll: vi.fn(),
      listAgents: vi.fn(() => []),
    };
    mocks.managers.push(manager);
    return manager;
  }),
}));

vi.mock("./ui/agent-widget.js", () => ({
  AgentWidget: vi.fn().mockImplementation(() => ({
    setContext: vi.fn(),
    ensureTimer: vi.fn(),
    markFinished: vi.fn(),
    update: vi.fn(),
    onTurnStart: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("./ui/conversation-viewer.js", () => ({
  showConversationViewer: vi.fn(),
}));

function makeAgent(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    name: "explore",
    description: "Explore repository",
    useWhen: "repository mapping is needed",
    model: "provider/model",
    thinking: "minimal",
    tools: ["read"],
    extensions: false,
    enabled: true,
    inheritContext: true,
    inheritSkills: false,
    promptMode: "append",
    conversationContext: "isolated",
    systemPrompt: "Explore prompt.",
    filePath: "/tmp/explore.md",
    scope: "default",
    ...overrides,
  };
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  const agent = makeAgent();
  return {
    id: "ag_123",
    agent,
    task: "Map the repo",
    cwd: "/repo",
    status: "completed",
    runInBackground: false,
    result: "Handoff text",
    toolUses: 2,
    model: "provider/model",
    thinking: "minimal",
    startedAt: Date.now() - 1000,
    completedAt: Date.now(),
    abortController: new AbortController(),
    session: {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      ],
    },
    ...overrides,
  };
}

function makePi() {
  const events = new Map<string, Function[]>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  return {
    pi: {
      on: vi.fn((event: string, handler: Function) => {
        const handlers = events.get(event) ?? [];
        handlers.push(handler);
        events.set(event, handlers);
      }),
      registerCommand: vi.fn((name: string, command: unknown) => {
        commands.set(name, command);
      }),
      registerTool: vi.fn((tool: { name: string }) => {
        tools.set(tool.name, tool);
      }),
    },
    events,
    commands,
    tools,
  };
}

function textOf(result: unknown): string {
  return String(
    (result as { content: Array<{ text: string }> }).content[0].text,
  );
}

beforeEach(() => {
  mocks.registry = {
    agents: [makeAgent()],
    disabledAgents: [
      { name: "review", filePath: "/tmp/review.md", scope: "user" },
    ],
    warnings: [],
  };
  mocks.managers.splice(0);
});

describe("subagents extension", () => {
  it("registers tools, command, and lifecycle handlers", () => {
    const { pi, commands, tools, events } = makePi();

    subagentsMinimal(pi as never);

    expect(commands.has("agents")).toBe(true);
    expect(tools.has("subagent")).toBe(true);
    expect(tools.has("get_subagent_result")).toBe(true);
    expect(events.has("before_agent_start")).toBe(true);
    expect(events.has("session_shutdown")).toBe(true);
  });

  it("returns useful errors for unknown and disabled subagents", async () => {
    const { pi, tools } = makePi();
    subagentsMinimal(pi as never);
    const subagentTool = tools.get("subagent") as {
      execute: Function;
    };

    await expect(
      subagentTool.execute(
        "call-1",
        { agent: "missing", task: "Task" },
        undefined,
        undefined,
        { cwd: "/repo" },
      ),
    ).resolves.toMatchObject({ isError: true });
    let result = await subagentTool.execute(
      "call-2",
      { agent: "missing", task: "Task" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    expect(textOf(result)).toContain("Unknown subagent: missing");
    expect(result.details.availableAgents).toEqual(["explore"]);

    result = await subagentTool.execute(
      "call-3",
      { agent: "review", task: "Task" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Subagent 'review' is disabled");
    expect(result.details.disabledAgents).toEqual(["review"]);
  });

  it("starts background runs and returns their IDs", async () => {
    const { pi, tools } = makePi();
    subagentsMinimal(pi as never);
    const manager = mocks.managers.at(-1)!;
    manager.spawn.mockReturnValue(
      makeRecord({
        id: "ag_bg",
        status: "running",
        runInBackground: true,
      }),
    );

    const subagentTool = tools.get("subagent") as { execute: Function };
    const result = await subagentTool.execute(
      "call-1",
      {
        agent: "explore",
        task: "Map the repo",
        cwd: "/custom",
        run_in_background: true,
        description: "Mapping",
      },
      undefined,
      undefined,
      { cwd: "/repo" },
    );

    expect(manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ name: "explore" }),
        task: "Map the repo",
        cwd: "/custom",
        description: "Mapping",
        runInBackground: true,
      }),
    );
    expect(textOf(result)).toContain("Agent ID: ag_bg");
    expect(result.details.record).toMatchObject({
      id: "ag_bg",
      runInBackground: true,
    });
  });

  it("returns foreground handoffs and marks failed runs as errors", async () => {
    const { pi, tools } = makePi();
    subagentsMinimal(pi as never);
    const manager = mocks.managers.at(-1)!;
    manager.spawnAndWait.mockResolvedValue(
      makeRecord({
        status: "error",
        result: "",
        error: "boom",
        stopReason: "error",
      }),
    );
    const onUpdate = vi.fn();

    const subagentTool = tools.get("subagent") as { execute: Function };
    const result = await subagentTool.execute(
      "call-1",
      { agent: "explore", task: "Map the repo" },
      undefined,
      onUpdate,
      { cwd: "/repo" },
    );

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { agent: "explore", task: "Map the repo" },
      }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("- Status: failed");
    expect(textOf(result)).toContain("boom");
  });

  it("gets background results, waits when requested, and includes verbose conversations", async () => {
    const { pi, tools } = makePi();
    subagentsMinimal(pi as never);
    const manager = mocks.managers.at(-1)!;
    let resolveRun!: (value: string) => void;
    let settled = false;
    const record = makeRecord({
      id: "ag_wait",
      status: "running",
      result: "",
      promise: new Promise<string>((resolve) => {
        resolveRun = resolve;
      }),
    });
    manager.getRecord.mockReturnValue(record);

    const getResultTool = tools.get("get_subagent_result") as {
      execute: Function;
    };
    const execution = getResultTool
      .execute("call-1", {
        agent_id: "ag_wait",
        wait: true,
        verbose: true,
      })
      .then((result: unknown) => {
        settled = true;
        return result;
      });

    await Promise.resolve();
    expect(settled).toBe(false);

    record.status = "completed";
    record.result = "Finished result";
    resolveRun("done");
    const result = await execution;

    expect(manager.getRecord).toHaveBeenCalledWith("ag_wait");
    expect(textOf(result)).toContain("## explore (ag_wait)");
    expect(textOf(result)).toContain("Finished result");
    expect(textOf(result)).toContain("### Conversation");
  });

  it("returns an error for unknown background result IDs", async () => {
    const { pi, tools } = makePi();
    subagentsMinimal(pi as never);
    mocks.managers.at(-1)!.getRecord.mockReturnValue(undefined);

    const getResultTool = tools.get("get_subagent_result") as {
      execute: Function;
    };
    const result = await getResultTool.execute("call-1", {
      agent_id: "missing",
    });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain("Unknown subagent id: missing");
  });

  it("injects the subagent catalog and warnings into the system prompt", async () => {
    const { pi, events } = makePi();
    mocks.registry.warnings = ["bad config"];
    subagentsMinimal(pi as never);

    const handler = events.get("before_agent_start")![0];
    const result = await handler({ systemPrompt: "Base prompt" });

    expect(result.systemPrompt).toContain("Base prompt");
    expect(result.systemPrompt).toContain("Subagents:");
    expect(result.systemPrompt).toContain("- explore — Explore repository");
    expect(result.systemPrompt).toContain(
      "Subagent config validation warnings",
    );
    expect(result.systemPrompt).toContain("- bad config");
  });

  it("clears completed records before session switches and aborts on shutdown", () => {
    const { pi, events } = makePi();
    subagentsMinimal(pi as never);
    const manager = mocks.managers.at(-1)!;

    events.get("session_before_switch")![0]();
    events.get("session_shutdown")![0]();

    expect(manager.clearCompleted).toHaveBeenCalledTimes(1);
    expect(manager.abortAll).toHaveBeenCalledTimes(1);
  });
});
