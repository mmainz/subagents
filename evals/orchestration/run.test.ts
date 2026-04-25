import { describe, expect, it } from "vitest";
import type { EvalCase } from "./cases.ts";
import {
  countDelegatedPlanningCalls,
  parseArgs,
  parseObservation,
  scoreCase,
  type ToolCallRecord,
} from "./run.ts";

function jsonl(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

function makeCase(expected: EvalCase["expected"]): EvalCase {
  return {
    id: "case-id",
    repoId: "repo-id",
    prompt: "Prompt",
    expected,
  };
}

describe("parseArgs", () => {
  it("parses case selection and path/job flags", () => {
    const parsed = parseArgs([
      "--case",
      "one",
      "--case=two",
      "--base-dir",
      "/base",
      "--results-dir=/results",
      "--jobs",
      "2",
      "--list",
      "--strict-soft",
    ]);

    expect([...parsed.selectedCaseIds]).toEqual(["one", "two"]);
    expect(parsed.baseDir).toBe("/base");
    expect(parsed.resultsDir).toBe("/results");
    expect(parsed.jobs).toBe(2);
    expect(parsed.listOnly).toBe(true);
    expect(parsed.strictSoft).toBe(true);
  });
});

describe("parseObservation", () => {
  it("tracks foreground and background subagent handoffs", () => {
    const stdout = jsonl([
      {
        type: "tool_execution_start",
        toolCallId: "sub-1",
        toolName: "subagent",
        args: {
          agent: "explore",
          task: "Gather FastAPI router evidence to inform a later plan.",
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "sub-1",
        toolName: "subagent",
        isError: false,
        result: {
          content: [
            {
              type: "text",
              text: "Handoff covers FastAPI router and dependency injection.",
            },
          ],
          details: {
            result: {
              agent: "explore",
              agentId: "ag_fg",
              exitCode: 0,
              finalText:
                "Handoff covers FastAPI router and dependency injection.",
            },
            record: {
              id: "ag_fg",
              agent: "explore",
              status: "completed",
              runInBackground: false,
            },
          },
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "sub-2",
        toolName: "subagent",
        args: {
          agent: "research",
          task: "Research current dependency injection best practices.",
          run_in_background: true,
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "sub-2",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "Started in background." }],
          details: {
            record: {
              id: "ag_bg",
              agent: "research",
              status: "running",
              runInBackground: true,
            },
          },
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "get-1",
        toolName: "get_subagent_result",
        args: { agent_id: "ag_bg", wait: true },
      },
      {
        type: "tool_execution_end",
        toolCallId: "get-1",
        toolName: "get_subagent_result",
        isError: false,
        result: {
          content: [
            {
              type: "text",
              text: "Research handoff covers dependency injection layers.",
            },
          ],
          details: {
            record: {
              id: "ag_bg",
              agent: "research",
              status: "completed",
            },
          },
        },
      },
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            model: "provider/model",
            content: [{ type: "text", text: "Final synthesis." }],
          },
        ],
      },
    ]);

    const observation = parseObservation(
      stdout,
      "",
      0,
      "/tmp/events.jsonl",
      "FastAPI router dependency injection",
    );

    expect(observation.attemptedSubagentCalls).toBe(2);
    expect(observation.subagentCalls).toBe(2);
    expect(observation.backgroundSubagentCalls).toBe(1);
    expect(observation.getSubagentResultCalls).toBe(1);
    expect(observation.completedSubagentRuns).toBe(2);
    expect(observation.attemptedAgentsUsed).toEqual(["explore", "research"]);
    expect(observation.agentsUsed).toEqual(["explore", "research"]);
    expect(observation.subagentRuns[1]).toMatchObject({
      agentId: "ag_bg",
      retrieved: true,
      completed: true,
      status: "completed",
    });
    expect(observation.handoffCoverageMissingKeywords).toEqual([]);
    expect(observation.finalAnswer).toBe("Final synthesis.");
    expect(observation.assistantModel).toBe("provider/model");
  });
});

describe("countDelegatedPlanningCalls", () => {
  it("counts delegated final planning but ignores evidence for later main-thread planning", () => {
    const calls: ToolCallRecord[] = [
      {
        name: "subagent",
        arguments: { task: "Propose the final implementation plan." },
      },
      {
        name: "subagent",
        arguments: {
          task: "Gather evidence and constraints to inform a later plan.",
        },
      },
      {
        name: "subagent",
        arguments: {
          task: "Map options. Do not produce the final recommendation.",
        },
      },
    ];

    expect(countDelegatedPlanningCalls(calls)).toBe(1);
  });
});

describe("scoreCase", () => {
  it("passes hard gates and scores required coordination checks", () => {
    const observation = parseObservation(
      jsonl([
        {
          type: "tool_execution_start",
          toolCallId: "sub-1",
          toolName: "subagent",
          args: { agent: "explore", task: "Gather evidence." },
        },
        {
          type: "tool_execution_end",
          toolCallId: "sub-1",
          toolName: "subagent",
          isError: false,
          result: {
            content: [{ type: "text", text: "Handoff." }],
            details: {
              result: { agent: "explore", exitCode: 0, finalText: "Handoff." },
              record: { id: "ag", agent: "explore", status: "completed" },
            },
          },
        },
        {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Final." }],
            },
          ],
        },
      ]),
      "",
      0,
      "/tmp/events.jsonl",
      "Prompt",
    );

    const score = scoreCase(
      makeCase({
        shouldDelegate: true,
        requiredAgents: ["explore"],
        minSubagentCalls: 1,
        requireCompletedSubagentResults: true,
        shouldKeepPlanningInMainThread: true,
      }),
      observation,
    );

    expect(score.pass).toBe(true);
    expect(score.allChecksPass).toBe(true);
    expect(score.hardGateFailures).toEqual([]);
    expect(score.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "delegate-threshold",
        "required-agent:explore",
        "min-subagent-calls",
        "completed-subagent-results",
        "limit-post-delegation-validation",
        "keep-planning-in-main-thread",
        "final-answer-present",
        "process-exit",
      ]),
    );
    expect(
      score.checks.find(
        (check) => check.name === "limit-post-delegation-validation",
      ),
    ).toMatchObject({ pass: true, dimension: "coordination" });
    expect(
      score.checks.find(
        (check) => check.name === "keep-planning-in-main-thread",
      ),
    ).toMatchObject({ pass: true, dimension: "coordination" });
  });

  it("fails hard gates for unnecessary delegation and missing final answer", () => {
    const observation = parseObservation(
      jsonl([
        {
          type: "tool_execution_start",
          toolCallId: "sub-1",
          toolName: "subagent",
          args: { agent: "explore", task: "Look around." },
        },
        {
          type: "tool_execution_end",
          toolCallId: "sub-1",
          toolName: "subagent",
          isError: true,
          result: { content: [{ type: "text", text: "failed" }], details: {} },
        },
      ]),
      "stderr",
      1,
      "/tmp/events.jsonl",
      "Prompt",
    );

    const score = scoreCase(
      makeCase({ shouldDelegate: false, forbiddenAgents: ["explore"] }),
      observation,
    );

    expect(score.pass).toBe(false);
    expect(score.hardGateFailures).toEqual(
      expect.arrayContaining([
        "delegate-threshold",
        "final-answer-present",
        "process-exit",
      ]),
    );
    expect(
      score.checks.find((check) => check.name === "forbidden-agent:explore")
        ?.pass,
    ).toBe(false);
  });
});
