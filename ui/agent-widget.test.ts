import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentConfig } from "../agents.js";
import type { AgentManager } from "../runtime/agent-manager.js";
import type { AgentRecord } from "../runtime/types.js";
import { AgentWidget } from "./agent-widget.js";

let widget: AgentWidget | undefined;

afterEach(() => {
  widget?.dispose();
  widget = undefined;
});

function makeAgent(): SubagentConfig {
  return {
    name: "explore",
    description: "Explore repository",
    tools: [],
    extensions: false,
    enabled: true,
    inheritContext: true,
    inheritSkills: false,
    promptMode: "append",
    conversationContext: "isolated",
    systemPrompt: "Prompt.",
    filePath: "/tmp/explore.md",
    scope: "default",
  };
}

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "ag_1",
    agent: makeAgent(),
    task: "Map the repository",
    cwd: "/repo",
    status: "running",
    runInBackground: true,
    startedAt: Date.now() - 1000,
    abortController: new AbortController(),
    toolUses: 0,
    ...overrides,
  };
}

function makeTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

describe("AgentWidget", () => {
  it("renders active subagent state and clears itself when no records remain visible", () => {
    const records = [
      makeRecord({
        id: "ag_running",
        status: "running",
        task: "Map the repository",
      }),
      makeRecord({
        id: "ag_queued",
        status: "queued",
        task: "Queued task",
      }),
    ];
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const ctx = {
      hasUI: true,
      ui: {
        setWidget,
        setStatus,
      },
    };
    const manager = {
      listAgents: vi.fn(() => records),
    } as unknown as AgentManager;
    widget = new AgentWidget(manager, new Map());

    widget.setContext(ctx as never);
    widget.update();

    const factory = setWidget.mock.calls[0][1];
    const component = factory({ requestRender: vi.fn() }, makeTheme());
    const output = component.render(80).join("\n");

    expect(output).toContain("Agents");
    expect(output).toContain("1 running");
    expect(output).toContain("1 queued");
    expect(output).toContain("Explore");
    expect(output).toContain("Map the repository");
    expect(output).toContain("thinking");
    expect(output).toContain("1 queued");
    expect(setStatus).toHaveBeenLastCalledWith(
      "subagents",
      "1 running, 1 queued subagents",
    );

    records.splice(0);
    widget.update();

    expect(setWidget).toHaveBeenLastCalledWith("subagents", undefined);
    expect(setStatus).toHaveBeenLastCalledWith("subagents", undefined);
  });
});
