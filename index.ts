import {
  DynamicBorder,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentManager } from "./runtime/agent-manager.js";
import { formatAgentConversation } from "./runtime/agent-runner.js";
import type { AgentActivity, AgentRecord } from "./runtime/types.js";
import { AgentWidget } from "./ui/agent-widget.js";
import { showConversationViewer } from "./ui/conversation-viewer.js";
import {
  discoverSubagentRegistry,
  formatAgentCatalog,
  formatRegistryWarnings,
  type DisabledSubagentConfig,
  type SubagentConfig,
} from "./agents.js";

interface SingleRunResult {
  agent: string;
  task: string;
  cwd: string;
  exitCode: number;
  finalText: string;
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  thinking?: string;
  agentId?: string;
}

function truncateLine(text: string, max = 120): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max - 1)}…`;
}

function displayAgentName(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function padVisible(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current >= width) return truncateToWidth(text, width, "");
  return `${text}${" ".repeat(width - current)}`;
}

function subagentCallCard(lines: string[]): Component {
  return {
    render(width: number): string[] {
      if (width <= 2)
        return lines.map((line) => truncateToWidth(line, width, ""));
      const contentWidth = width - 2;
      return lines.map((line) => {
        const content = truncateToWidth(line, contentWidth, "");
        return ` ${padVisible(content, contentWidth)} `;
      });
    },
    invalidate() {},
  };
}

function formatCallTitle(agent: string, task: string, theme: any): string {
  return `${theme.fg("toolTitle", theme.bold(displayAgentName(agent)))} ${theme.fg("muted", truncateLine(task, 140))}`;
}

function didRunFail(result: SingleRunResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

function getRunBody(result: SingleRunResult): string {
  return (
    result.finalText ||
    result.errorMessage ||
    result.stderr ||
    `${result.agent} produced no output.`
  );
}

function formatRunResult(result: SingleRunResult): string {
  const metadata = [
    `## ${result.agent}`,
    `- Task: ${result.task}`,
    `- Status: ${didRunFail(result) ? "failed" : "done"}`,
  ];

  if (result.model) metadata.push(`- Model: ${result.model}`);
  if (result.thinking) metadata.push(`- Thinking: ${result.thinking}`);
  if (result.agentId) metadata.push(`- Agent ID: ${result.agentId}`);

  return [
    metadata.join("\n"),
    "",
    "### Output",
    getRunBody(result),
    "",
    "This handoff is the primary evidence for your next response.",
    "If this resolves the remaining question, answer the user now without more tools.",
    "Do not repeat the same evidence-gathering. If the handoff is missing, contradictory, low-confidence, or the subagent changed files, inspect the relevant context or diff and run targeted validation before finalizing. Otherwise, only do follow-up validation if one critical detail is still ambiguous.",
  ].join("\n");
}

function formatRunResultPreview(result: SingleRunResult): string {
  return truncateLine(getRunBody(result), 180) || "No handoff text returned.";
}

function shortenInspectorPath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) return "...";
  const home = process.env.HOME;
  if (home && rawPath.startsWith(home)) return `~${rawPath.slice(home.length)}`;
  return rawPath;
}

function formatBoolean(value: boolean): string {
  return value ? "true" : "false";
}

function formatAgentRuntime(agent: SubagentConfig): string[] {
  return [
    `model: ${agent.model || "not configured"}`,
    `thinking: ${agent.thinking || "not configured"}`,
    `tools: ${agent.tools.join(", ") || "none"}`,
    `prompt_mode: ${agent.promptMode}`,
    `conversation_context: ${agent.conversationContext}`,
    `extensions: ${formatBoolean(agent.extensions)}`,
    `inherit_context: ${formatBoolean(agent.inheritContext)}`,
    `inherit_skills: ${formatBoolean(agent.inheritSkills)}`,
    `source: ${agent.scope}`,
    `path: ${shortenInspectorPath(agent.filePath)}`,
  ];
}

function formatDisabledAgentsList(
  disabledAgents: DisabledSubagentConfig[],
): string {
  if (disabledAgents.length === 0) return "No disabled subagents.";

  return [
    "Disabled subagents:",
    "",
    ...disabledAgents.map(
      (agent) =>
        `${agent.name}\n  disabled by: ${shortenInspectorPath(agent.filePath)}`,
    ),
  ].join("\n");
}

function formatAgentDetails(agent: SubagentConfig): string {
  const promptLines = agent.systemPrompt.split("\n");
  const promptPreview =
    promptLines.length > 80
      ? `${promptLines.slice(0, 80).join("\n")}\n... ${promptLines.length - 80} more lines`
      : agent.systemPrompt;
  const lines = [agent.name, "", "Description:", agent.description, ""];

  if (agent.useWhen) {
    lines.push("Use when:", agent.useWhen, "");
  } else {
    lines.push("Use when:", "explicit-only", "");
  }

  lines.push(
    "Runtime:",
    ...formatAgentRuntime(agent).map((line) => `  ${line}`),
  );

  if (agent.systemPrompt) {
    lines.push("", "Prompt:", promptPreview);
  }

  return lines.join("\n");
}

async function showSubagentTextDialog(
  ctx: any,
  title: string,
  body: string,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui: any, theme: any, _keybindings: unknown, done: () => void) => {
      let scrollOffset = 0;
      const maxBodyLines = Math.max(
        6,
        Math.min(30, (process.stdout.rows || 30) - 8),
      );

      const getWrappedBodyLines = (width: number): string[] => {
        const contentWidth = Math.max(20, width - 2);
        return body
          .split("\n")
          .flatMap((line) =>
            line.trim() ? wrapTextWithAnsi(line, contentWidth) : [""],
          );
      };

      const scrollBy = (amount: number, maxScroll: number) => {
        scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset + amount));
        tui.requestRender();
      };

      return {
        render: (width: number) => {
          const safeWidth = Math.max(24, width);
          const contentWidth = safeWidth - 2;
          const border = theme.fg("accent", "─".repeat(safeWidth));
          const bodyLines = getWrappedBodyLines(safeWidth);
          const maxScroll = Math.max(0, bodyLines.length - maxBodyLines);
          scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset));
          const visibleLines = bodyLines.slice(
            scrollOffset,
            scrollOffset + maxBodyLines,
          );
          const linesBelow = Math.max(
            0,
            bodyLines.length - (scrollOffset + visibleLines.length),
          );
          const scrollInfo =
            maxScroll > 0
              ? ` (${scrollOffset + 1}-${scrollOffset + visibleLines.length}/${bodyLines.length})`
              : "";
          const help =
            maxScroll > 0
              ? "↑↓/j/k scroll • pgup/pgdn page • home/end • esc/q close"
              : "esc/q close";

          return [
            border,
            truncateToWidth(
              ` ${theme.fg("accent", theme.bold(title))}${theme.fg("dim", scrollInfo)}`,
              safeWidth,
              "",
            ),
            ...(scrollOffset > 0
              ? [theme.fg("dim", ` ↑ ${scrollOffset} more`)]
              : []),
            ...visibleLines.map((line) =>
              truncateToWidth(` ${line}`, safeWidth, ""),
            ),
            ...(linesBelow > 0
              ? [theme.fg("dim", ` ↓ ${linesBelow} more`)]
              : []),
            truncateToWidth(` ${theme.fg("dim", help)}`, safeWidth, ""),
            border,
          ].map((line) => truncateToWidth(line, safeWidth, ""));
        },
        invalidate: () => {},
        handleInput: (data: string) => {
          const bodyLines = getWrappedBodyLines(process.stdout.columns || 80);
          const maxScroll = Math.max(0, bodyLines.length - maxBodyLines);

          if (matchesKey(data, Key.escape) || data === "q") {
            done();
            return;
          }
          if (matchesKey(data, Key.up) || data === "k") {
            scrollBy(-1, maxScroll);
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            scrollBy(1, maxScroll);
            return;
          }
          if (matchesKey(data, Key.pageUp)) {
            scrollBy(-maxBodyLines, maxScroll);
            return;
          }
          if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
            scrollBy(maxBodyLines, maxScroll);
            return;
          }
          if (matchesKey(data, Key.home)) {
            scrollOffset = 0;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.end)) {
            scrollOffset = maxScroll;
            tui.requestRender();
          }
        },
      };
    },
    { overlay: true },
  );
}

function recordToRunResult(record: AgentRecord): SingleRunResult {
  return {
    agent: record.agent.name,
    task: record.task,
    cwd: record.cwd,
    exitCode: record.status === "completed" ? 0 : 1,
    finalText: record.result || "",
    stderr: "",
    errorMessage: record.error,
    stopReason:
      record.stopReason ||
      (record.status === "aborted"
        ? "aborted"
        : record.status === "error"
          ? "error"
          : undefined),
    model: record.model,
    thinking: record.thinking,
    agentId: record.id,
  };
}

function summarizeRecord(record: AgentRecord) {
  return {
    id: record.id,
    agent: record.agent.name,
    task: record.task,
    cwd: record.cwd,
    status: record.status,
    stopReason: record.stopReason,
    model: record.model,
    thinking: record.thinking,
    toolUses: record.toolUses,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

function formatBackgroundStart(record: AgentRecord): string {
  return [
    `Started ${record.agent.name} subagent in background.`,
    "",
    `- Agent ID: ${record.id}`,
    `- Task: ${record.task}`,
    `- Status: ${record.status}`,
    "",
    `Use get_subagent_result with agent_id: ${record.id} to retrieve the result.`,
  ].join("\n");
}

async function showAgentsPicker(
  ctx: any,
  agents: SubagentConfig[],
  disabledAgents: DisabledSubagentConfig[],
): Promise<string | null> {
  const items: SelectItem[] = agents.map((agent) => ({
    value: `agent:${agent.name}`,
    label: agent.name,
    description: `${agent.useWhen ? "routable" : "explicit-only"} · ${agent.description}`,
  }));

  if (disabledAgents.length > 0) {
    items.push({
      value: "disabled",
      label: "disabled subagents",
      description: `${disabledAgents.length} disabled`,
    });
  }

  if (items.length === 0) return null;

  return await ctx.ui.custom<string | null>(
    (
      tui: any,
      theme: any,
      _keybindings: unknown,
      done: (value: string | null) => void,
    ) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Subagents")), 1, 0),
      );

      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg("dim", "↑↓ navigate • enter view • esc cancel"),
          1,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}

async function showRunningAgentsPicker(
  ctx: any,
  manager: AgentManager,
): Promise<string | null> {
  const records = manager.listAgents();
  if (records.length === 0) {
    await showSubagentTextDialog(
      ctx,
      "Subagents",
      "No running or completed subagents.",
    );
    return null;
  }

  const items: SelectItem[] = records.map((record) => ({
    value: record.id,
    label: `${record.agent.name} ${record.id}`,
    description: `${record.status} · ${record.task}`,
  }));

  return await ctx.ui.custom<string | null>(
    (
      tui: any,
      theme: any,
      _keybindings: unknown,
      done: (value: string | null) => void,
    ) => {
      const container = new Container();
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      container.addChild(
        new Text(
          theme.fg("accent", theme.bold("Running/completed subagents")),
          1,
          0,
        ),
      );
      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg("dim", "↑↓ navigate • enter view conversation • esc cancel"),
          1,
          0,
        ),
      );
      container.addChild(
        new DynamicBorder((text: string) => theme.fg("accent", text)),
      );
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}

export default function subagentsMinimal(pi: ExtensionAPI) {
  const agentActivity = new Map<string, AgentActivity>();
  let widget: AgentWidget;
  const manager = new AgentManager({
    activity: agentActivity,
    maxConcurrent:
      Number.parseInt(process.env.PI_SUBAGENT_MAX_CONCURRENT || "4", 10) || 4,
    onUpdate: () => widget?.update(),
    onComplete: (record) => {
      widget?.markFinished(record.id);
      widget?.update();
    },
  });
  widget = new AgentWidget(manager, agentActivity);

  pi.on("session_start", (_event, ctx) => {
    widget.setContext(ctx);
  });
  pi.on("tool_execution_start", (_event, ctx) => {
    widget.setContext(ctx);
    widget.onTurnStart();
  });
  pi.on("session_before_switch", () => {
    manager.clearCompleted();
  });
  pi.on("session_shutdown", () => {
    manager.abortAll();
    widget.dispose();
  });

  pi.registerCommand("agents", {
    description: "List configured subagents",
    getArgumentCompletions: (prefix) => {
      const { agents } = discoverSubagentRegistry();
      const values = [
        "running",
        "disabled",
        ...agents.map((agent) => `show ${agent.name}`),
      ];
      const filtered = values.filter((value) => value.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const { agents, disabledAgents } = discoverSubagentRegistry();

      if (!trimmed) {
        const selection = await showAgentsPicker(ctx, agents, disabledAgents);
        if (!selection) return;
        if (selection === "disabled") {
          await showSubagentTextDialog(
            ctx,
            "Disabled subagents",
            formatDisabledAgentsList(disabledAgents),
          );
          return;
        }

        const name = selection.replace(/^agent:/, "");
        const agent = agents.find((candidate) => candidate.name === name);
        if (agent) {
          await showSubagentTextDialog(
            ctx,
            `Subagent: ${agent.name}`,
            formatAgentDetails(agent),
          );
        }
        return;
      }

      if (trimmed === "disabled") {
        await showSubagentTextDialog(
          ctx,
          "Disabled subagents",
          formatDisabledAgentsList(disabledAgents),
        );
        return;
      }

      if (trimmed === "running") {
        const id = await showRunningAgentsPicker(ctx, manager);
        const record = id ? manager.getRecord(id) : undefined;
        if (record) await showConversationViewer(ctx, record);
        return;
      }

      const showMatch = trimmed.match(/^show\s+(.+)$/);
      if (showMatch) {
        const name = showMatch[1].trim();
        const agent = agents.find((candidate) => candidate.name === name);
        const disabledAgent = disabledAgents.find(
          (candidate) => candidate.name === name,
        );
        if (agent) {
          await showSubagentTextDialog(
            ctx,
            `Subagent: ${agent.name}`,
            formatAgentDetails(agent),
          );
          return;
        }
        if (disabledAgent) {
          await showSubagentTextDialog(
            ctx,
            `Subagent: ${name}`,
            `${name} is disabled by ${shortenInspectorPath(disabledAgent.filePath)}`,
          );
          return;
        }
        await showSubagentTextDialog(
          ctx,
          "Subagents",
          `Unknown subagent: ${name}`,
        );
        return;
      }

      await showSubagentTextDialog(
        ctx,
        "Subagents",
        "Usage: /agents [running|disabled|show <name>]",
      );
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one configured subagent in an in-process session. Foreground runs return a handoff; background runs return an agent ID for get_subagent_result.",
    promptSnippet:
      "Run one focused subagent with a compact delegation brief. Use run_in_background only for independent long-running or parallel work.",
    promptGuidelines: [
      "Choose the agent from the injected enabled-subagent list and its use_when guidance. Provide a compact, focused task with clear boundaries. Use foreground runs by default; use run_in_background only for independent long-running or parallel work. After starting a background run, retrieve it with get_subagent_result before overlapping main-thread evidence gathering.",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: "The configured subagent to run.",
      }),
      task: Type.String({
        description:
          "A compact, self-contained delegation brief. Include the user's decision-critical concern, named concepts, relevant keywords, and later objective needed for final synthesis in each relevant subagent brief. Prefer an exact task, focused scope, minimal necessary context, and clear boundaries.",
      }),
      cwd: Type.Optional(
        Type.String({
          description: "Optional working directory override for the subagent.",
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description:
            "Start the subagent asynchronously and return an agent ID immediately.",
        }),
      ),
      description: Type.Optional(
        Type.String({
          description: "Short user-facing description for this subagent run.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { agents, disabledAgents, warnings } = discoverSubagentRegistry();
      const agent = agents.find((candidate) => candidate.name === params.agent);
      const disabledAgent = disabledAgents.find(
        (candidate) => candidate.name === params.agent,
      );

      if (!agent) {
        const available =
          agents.map((candidate) => candidate.name).join(", ") || "none";
        const message = disabledAgent
          ? `Subagent '${params.agent}' is disabled by ${disabledAgent.filePath}. Available subagents: ${available}.`
          : `Unknown subagent: ${params.agent}. Available subagents: ${available}.`;
        return {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
          details: {
            availableAgents: agents.map((candidate) => candidate.name),
            disabledAgents: disabledAgents.map((candidate) => candidate.name),
            registryWarnings: warnings,
          },
        };
      }

      widget.setContext(ctx);
      widget.ensureTimer();

      if (params.run_in_background) {
        const record = manager.spawn({
          ctx,
          agent,
          task: params.task,
          cwd: params.cwd || ctx.cwd,
          description: params.description,
          runInBackground: true,
          signal,
        });
        return {
          content: [{ type: "text", text: formatBackgroundStart(record) }],
          details: {
            record: { ...summarizeRecord(record), runInBackground: true },
            registryWarnings: warnings,
          },
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Running ${params.agent} subagent...`,
          },
        ],
        details: { agent: params.agent, task: params.task },
      });

      const record = await manager.spawnAndWait({
        ctx,
        agent,
        task: params.task,
        cwd: params.cwd || ctx.cwd,
        description: params.description,
        runInBackground: false,
        signal,
      });
      const result = recordToRunResult(record);
      return {
        content: [{ type: "text", text: formatRunResult(result) }],
        isError: didRunFail(result),
        details: {
          result,
          record: summarizeRecord(record),
          registryWarnings: warnings,
        },
      };
    },
    renderCall(args, theme) {
      const agent = String(args.agent || "subagent");
      const task = String(args.description || args.task || "");
      return subagentCallCard([
        `${theme.fg("accent", "▸")} ${formatCallTitle(agent, task, theme)}`,
      ]);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const runResult = result.details?.result as SingleRunResult | undefined;
      const record = result.details?.record as
        | {
            agent?: string;
            task?: string;
            id?: string;
            status?: string;
            runInBackground?: boolean;
          }
        | undefined;

      if (isPartial) {
        return subagentCallCard([
          `  ${theme.fg("borderMuted", "└")} ${theme.fg("dim", "running…")}`,
        ]);
      }

      if (!runResult) {
        if (record) {
          const status = record.runInBackground
            ? `${record.status === "queued" ? "Queued" : "Running"} in background${record.id ? ` (ID: ${record.id})` : ""}`
            : record.status || "started";
          return subagentCallCard([
            `  ${theme.fg("borderMuted", "└")} ${theme.fg("dim", status)}`,
          ]);
        }
        return subagentCallCard([
          `  ${theme.fg("borderMuted", "└")} ${theme.fg("error", "No subagent result")}`,
        ]);
      }

      const failed = didRunFail(runResult);
      const lines = [
        `  ${theme.fg("borderMuted", "└")} ${theme.fg(failed ? "error" : "success", failed ? "failed" : "done")}${runResult.agentId ? theme.fg("dim", ` (ID: ${runResult.agentId})`) : ""}`,
        `    ${theme.fg("muted", formatRunResultPreview(runResult))}`,
      ];

      if (expanded) {
        const resultLines = formatRunResult(runResult).split("\n");
        const previewLines = resultLines.slice(0, 14);
        for (const line of previewLines)
          lines.push(`    ${theme.fg("dim", line)}`);
        if (resultLines.length > previewLines.length) {
          lines.push(
            `    ${theme.fg("muted", `... ${resultLines.length - previewLines.length} more lines`)}`,
          );
        }
      }

      return subagentCallCard(lines);
    },
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description:
      "Get the status, result, or verbose conversation for an in-process subagent run.",
    promptSnippet:
      "Use get_subagent_result to retrieve a background subagent result by agent_id.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The background subagent ID returned by subagent.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "Wait for the subagent to finish before returning.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "Include the full subagent conversation when available.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return {
          content: [
            { type: "text", text: `Unknown subagent id: ${params.agent_id}` },
          ],
          isError: true,
        };
      }

      if (
        params.wait &&
        record.promise &&
        (record.status === "running" || record.status === "queued")
      ) {
        try {
          await record.promise;
        } catch {
          // record captures failure state
        }
      }

      const lines = [
        `## ${record.agent.name} (${record.id})`,
        `- Status: ${record.status}`,
        `- Task: ${record.task}`,
        `- Tool uses: ${record.toolUses}`,
      ];
      if (record.model) lines.push(`- Model: ${record.model}`);
      if (record.thinking) lines.push(`- Thinking: ${record.thinking}`);
      if (record.startedAt)
        lines.push(
          `- Elapsed: ${Math.max(1, Math.round(((record.completedAt || Date.now()) - record.startedAt) / 1000))}s`,
        );
      lines.push(
        "",
        "### Output",
        record.result ||
          record.error ||
          (record.status === "queued"
            ? "Subagent is queued."
            : record.status === "running"
              ? "Subagent is still running."
              : `Subagent ${record.status}.`),
      );
      if (params.verbose && record.session) {
        lines.push(
          "",
          "### Conversation",
          formatAgentConversation(record.session),
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: record.status === "error" || record.status === "aborted",
        details: { record: summarizeRecord(record) },
      };
    },
    renderCall(args, theme) {
      return subagentCallCard([
        `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold("Get Subagent Result"))} ${theme.fg("muted", String(args.agent_id || ""))}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const record = result.details?.record as
        | {
            agent?: string;
            id?: string;
            status?: string;
            toolUses?: number;
          }
        | undefined;
      const text =
        result.content?.[0]?.type === "text" ? result.content[0].text : "";
      const status = record?.status || (result.isError ? "error" : "done");
      const label = result.isError
        ? theme.fg("error", status)
        : status === "completed"
          ? theme.fg("success", "completed")
          : theme.fg("dim", status);
      const detail = record?.agent
        ? `${record.agent}${record.toolUses ? ` · ${record.toolUses} tools` : ""}`
        : truncateLine(text, 120);
      return subagentCallCard([
        `  ${theme.fg("borderMuted", "└")} ${label}${record?.id ? theme.fg("dim", ` (ID: ${record.id})`) : ""}`,
        `    ${theme.fg("muted", detail)}`,
      ]);
    },
  });

  pi.on("before_agent_start", async (event) => {
    const { agents, warnings } = discoverSubagentRegistry();
    if (agents.length === 0 && warnings.length === 0) return;

    const sections = [
      event.systemPrompt,
      "",
      "Subagents:",
      "Use the subagent tool for focused helper work. Choose from the enabled agents below.",
      "- Delegate matching work when it is broad/noisy, parallelizable, specialized (for example media/visual inspection or external research), or the user asks for an independent review/second opinion.",
      "- Use main-thread tools for tiny, linear local checks and implementation when no specialized agent is needed; do not inspect local images/screenshots/diagrams/video directly when a visual/media agent is enabled.",
      "- Use foreground subagent runs by default. Use background runs only for independent long-running or parallel work; after starting one, call get_subagent_result before doing overlapping grep/find/read/webfetch/websearch work.",
      "- For mapping/survey work across independent areas, split the work into focused subagents; use background runs when those threads are independent.",
      "- Keep final synthesis, planning, recommendations, and implementation strategy in the main thread unless the user explicitly asks a subagent to own those outputs.",
      "- Write delegation briefs with the user's decision-critical concerns, named concepts, relevant keywords, and later objective so handoffs contain enough evidence for final synthesis.",
      "- After delegation, use handoffs as primary evidence. Reading a few cited files or validating changed files is fine; avoid redoing broad search/mapping. If a handoff is missing, contradictory, low-confidence, or omits a decision-critical concern, use one focused follow-up subagent or targeted validation.",
      "",
      formatAgentCatalog(agents),
    ];

    if (warnings.length > 0) {
      sections.push(
        `Subagent config validation warnings:
${formatRegistryWarnings(warnings)}`,
      );
    }

    return {
      systemPrompt: sections.filter(Boolean).join("\n"),
    };
  });
}
