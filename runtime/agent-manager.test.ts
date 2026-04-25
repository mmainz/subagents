import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentConfig } from "../agents.js";
import { AgentManager } from "./agent-manager.js";
import { runAgentInProcess } from "./agent-runner.js";
import type { AgentRunCallbacks } from "./types.js";

vi.mock("./agent-runner.js", () => ({
  runAgentInProcess: vi.fn(),
}));

interface PendingRun {
  input: { task: string; cwd: string; signal?: AbortSignal };
  callbacks: AgentRunCallbacks;
  resolve: (value: {
    result: string;
    session?: unknown;
    model?: string;
    thinking?: string;
    stopReason?: string;
    errorMessage?: string;
  }) => void;
  reject: (error: unknown) => void;
}

const runAgentMock = vi.mocked(runAgentInProcess);

function makeAgent(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    tools: [],
    extensions: false,
    enabled: true,
    inheritContext: true,
    inheritSkills: false,
    promptMode: "append",
    conversationContext: "isolated",
    systemPrompt: "Test prompt.",
    filePath: "/tmp/test-agent.md",
    scope: "default",
    model: "provider/model",
    thinking: "low",
    ...overrides,
  };
}

function makeManager(
  options: Partial<ConstructorParameters<typeof AgentManager>[0]> = {},
) {
  return new AgentManager({
    maxConcurrent: 4,
    activity: new Map(),
    ...options,
  });
}

function resolveRun(run: PendingRun, result = "done") {
  run.resolve({
    result,
    session: { dispose: vi.fn() },
    model: "provider/model",
    thinking: "minimal",
    stopReason: "stop",
  });
}

beforeEach(() => {
  runAgentMock.mockReset();
  runAgentMock.mockImplementation((_ctx, _agent, input, callbacks = {}) => {
    return new Promise((resolve, reject) => {
      pendingRuns.push({ input, callbacks, resolve, reject });
    }) as ReturnType<typeof runAgentInProcess>;
  });
  pendingRuns = [];
});

let pendingRuns: PendingRun[] = [];

describe("AgentManager", () => {
  it("queues background runs after the concurrency limit and drains when a run completes", async () => {
    const onUpdate = vi.fn();
    const manager = makeManager({ maxConcurrent: 1, onUpdate });

    const first = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "first" }),
      task: "first task",
      cwd: "/tmp",
      runInBackground: true,
    });
    const second = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "second" }),
      task: "second task",
      cwd: "/tmp",
      runInBackground: true,
    });

    expect(first.status).toBe("running");
    expect(second.status).toBe("queued");
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    resolveRun(pendingRuns[0], "first result");
    await first.promise;

    await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(2));
    expect(first.status).toBe("completed");
    expect(first.result).toBe("first result");
    expect(second.status).toBe("running");
    expect(pendingRuns[1].input.task).toBe("second task");
    expect(onUpdate).toHaveBeenCalled();
  });

  it("aborts queued runs without starting them", async () => {
    const activity = new Map();
    const manager = makeManager({ maxConcurrent: 1, activity });

    const running = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "running" }),
      task: "running task",
      cwd: "/tmp",
      runInBackground: true,
    });
    const queued = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "queued" }),
      task: "queued task",
      cwd: "/tmp",
      runInBackground: true,
    });

    expect(queued.status).toBe("queued");
    expect(manager.abort(queued.id)).toBe(true);
    await expect(queued.promise).resolves.toBe("");

    expect(queued.status).toBe("aborted");
    expect(queued.stopReason).toBe("aborted");
    expect(queued.error).toBe("Subagent was aborted.");
    expect(activity.has(queued.id)).toBe(false);

    resolveRun(pendingRuns[0], "running result");
    await running.promise;
    await Promise.resolve();

    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("records tool and text activity while a run is active", () => {
    const activity = new Map();
    const onUpdate = vi.fn();
    const manager = makeManager({ activity, onUpdate });

    const record = manager.spawn({
      ctx: {} as never,
      agent: makeAgent(),
      task: "inspect",
      cwd: "/tmp",
      runInBackground: true,
    });

    pendingRuns[0].callbacks.onToolActivity?.("bash", {
      command: "bun run test",
    });
    pendingRuns[0].callbacks.onTextUpdate?.(
      `  ${"word ".repeat(80)}\nwith extra whitespace  `,
    );

    expect(record.toolUses).toBe(1);
    expect(activity.get(record.id)).toMatchObject({
      id: record.id,
      agentName: "test-agent",
      activeTool: "bash bun run test",
      toolUses: 1,
    });
    expect(activity.get(record.id)?.latestText).not.toMatch(/\s{2,}/);
    expect(activity.get(record.id)?.latestText.length).toBeLessThanOrEqual(160);
    expect(onUpdate).toHaveBeenCalled();
  });

  it("spawnAndWait returns completed and failed records without throwing", async () => {
    const manager = makeManager();

    const completedPromise = manager.spawnAndWait({
      ctx: {} as never,
      agent: makeAgent(),
      task: "complete",
      cwd: "/tmp",
      runInBackground: true,
    });
    resolveRun(pendingRuns[0], "completed output");
    await expect(completedPromise).resolves.toMatchObject({
      status: "completed",
      runInBackground: false,
      result: "completed output",
    });

    const failedPromise = manager.spawnAndWait({
      ctx: {} as never,
      agent: makeAgent(),
      task: "fail",
      cwd: "/tmp",
      runInBackground: true,
    });
    pendingRuns[1].reject(new Error("boom"));
    await expect(failedPromise).resolves.toMatchObject({
      status: "error",
      error: "boom",
      stopReason: "error",
    });
  });

  it("abortAll aborts running and queued records and clears activity", async () => {
    const activity = new Map();
    const manager = makeManager({ maxConcurrent: 1, activity });

    const running = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "running" }),
      task: "running task",
      cwd: "/tmp",
      runInBackground: true,
    });
    const queued = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "queued" }),
      task: "queued task",
      cwd: "/tmp",
      runInBackground: true,
    });

    expect(activity.size).toBe(1);
    manager.abortAll();

    await expect(running.promise).resolves.toBe("");
    await expect(queued.promise).resolves.toBe("");
    expect(running.status).toBe("aborted");
    expect(queued.status).toBe("aborted");
    expect(running.abortController.signal.aborted).toBe(true);
    expect(queued.abortController.signal.aborted).toBe(true);
    expect(activity.size).toBe(0);

    pendingRuns[0].reject(
      Object.assign(new Error("aborted"), { stopReason: "aborted" }),
    );
    await vi.waitFor(() => expect(running.completedAt).toBeDefined());
  });

  it("aborts queued records when the parent signal aborts", async () => {
    const manager = makeManager({ maxConcurrent: 1 });
    const parent = new AbortController();

    manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "running" }),
      task: "running task",
      cwd: "/tmp",
      runInBackground: true,
    });
    const queued = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "queued" }),
      task: "queued task",
      cwd: "/tmp",
      runInBackground: true,
      signal: parent.signal,
    });

    parent.abort();

    await expect(queued.promise).resolves.toBe("");
    expect(queued.status).toBe("aborted");
    expect(queued.stopReason).toBe("aborted");
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("clearCompleted disposes terminal sessions and keeps active records", async () => {
    const activity = new Map();
    const manager = makeManager({ maxConcurrent: 1, activity });
    const dispose = vi.fn();

    const completed = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "completed" }),
      task: "completed task",
      cwd: "/tmp",
      runInBackground: true,
    });
    const queued = manager.spawn({
      ctx: {} as never,
      agent: makeAgent({ name: "queued" }),
      task: "queued task",
      cwd: "/tmp",
      runInBackground: true,
    });

    pendingRuns[0].callbacks.onSessionCreated?.({ dispose } as never);
    pendingRuns[0].resolve({
      result: "done",
      session: { dispose },
      model: "provider/model",
      thinking: "low",
    });
    await completed.promise;
    await vi.waitFor(() => expect(queued.status).toBe("running"));

    manager.clearCompleted();

    expect(manager.getRecord(completed.id)).toBeUndefined();
    expect(manager.getRecord(queued.id)).toBe(queued);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("prunes old completed records and disposes pruned sessions", async () => {
    const manager = makeManager();
    const disposers = Array.from({ length: 51 }, () => vi.fn());
    const records = [];

    for (let i = 0; i < 51; i++) {
      const record = manager.spawn({
        ctx: {} as never,
        agent: makeAgent({ name: `agent-${i}` }),
        task: `task ${i}`,
        cwd: "/tmp",
        runInBackground: true,
      });
      records.push(record);
      pendingRuns[i].callbacks.onSessionCreated?.({
        dispose: disposers[i],
      } as never);
      pendingRuns[i].resolve({
        result: `result ${i}`,
        session: { dispose: disposers[i] },
        model: "provider/model",
        thinking: "low",
      });
      await record.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(
      manager.listAgents().filter((record) => record.status === "completed"),
    ).toHaveLength(50);
    expect(manager.getRecord(records[0].id)).toBeUndefined();
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(manager.getRecord(records[50].id)).toBe(records[50]);
  });
});
