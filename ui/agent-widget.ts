import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Loader, truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentManager } from "../runtime/agent-manager.js";
import type { AgentActivity, AgentRecord } from "../runtime/types.js";

const MAX_LINES = 12;
const FINISHED_TTL_MS = 5000;

function formatMs(start?: number, end = Date.now()): string {
  if (!start) return "0s";
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function displayAgentName(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayTask(record: AgentRecord): string {
  return (record.description || record.task).replace(/\s+/g, " ").trim();
}

function formatCounts(
  running: number,
  queued: number,
  finished: number,
): string {
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  if (finished > 0) parts.push(`${finished} finished`);
  return parts.join(" · ");
}

function isTerminal(record: AgentRecord): boolean {
  return (
    record.status === "completed" ||
    record.status === "error" ||
    record.status === "aborted" ||
    record.status === "stopped"
  );
}

function groupVisibleRecords(
  records: AgentRecord[],
  finished: Map<string, number>,
) {
  return {
    running: records.filter((record) => record.status === "running"),
    queued: records.filter((record) => record.status === "queued"),
    finished: records.filter(
      (record) => isTerminal(record) && finished.has(record.id),
    ),
  };
}

export class AgentWidget {
  private ctx?: ExtensionContext;
  private timer?: NodeJS.Timeout;
  private loader?: Loader;
  private finished = new Map<string, number>();
  private widgetRegistered = false;
  private tui?: { requestRender(): void };
  private manager: AgentManager;
  private activity: Map<string, AgentActivity>;

  constructor(manager: AgentManager, activity: Map<string, AgentActivity>) {
    this.manager = manager;
    this.activity = activity;
  }

  setContext(ctx: ExtensionContext) {
    if (this.ctx !== ctx) {
      this.ctx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.stopLoader();
    }
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.update(), 1000);
    this.timer.unref?.();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ctx?.ui.setWidget("subagents", undefined);
    this.ctx?.ui.setStatus("subagents", undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.stopLoader();
  }

  markFinished(id: string) {
    this.finished.set(id, Date.now() + FINISHED_TTL_MS);
  }

  onTurnStart() {
    this.pruneFinished();
    this.update();
  }

  private pruneFinished(now = Date.now()) {
    for (const [id, expiresAt] of this.finished) {
      if (expiresAt <= now) this.finished.delete(id);
    }
  }

  update() {
    if (!this.ctx?.hasUI) return;
    this.pruneFinished();
    const { running, queued, finished } = groupVisibleRecords(
      this.manager.listAgents(),
      this.finished,
    );

    if (running.length === 0 && queued.length === 0 && finished.length === 0) {
      this.ctx.ui.setWidget("subagents", undefined);
      this.ctx.ui.setStatus("subagents", undefined);
      this.widgetRegistered = false;
      this.tui = undefined;
      this.stopLoader();
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      return;
    }

    this.ctx.ui.setStatus(
      "subagents",
      `${running.length} running${queued.length ? `, ${queued.length} queued` : ""} subagents`,
    );
    if (!this.widgetRegistered) {
      this.ctx.ui.setWidget(
        "subagents",
        (tui, theme) => {
          this.tui = tui;
          this.stopLoader();
          this.loader = new Loader(
            tui,
            (spinner) => theme.fg("accent", spinner),
            (text) => theme.fg("muted", text),
            "",
          );
          return {
            render: (width: number) => this.render(width, theme),
            invalidate: () => {},
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  private stopLoader() {
    this.loader?.stop();
    this.loader = undefined;
  }

  private renderRunningIcon(theme: any): string {
    const indicator = this.loader
      ?.render(8)
      .find((line) => line.trim())
      ?.trim();
    return indicator || theme.fg("accent", "⠋");
  }

  private render(width: number, theme: any): string[] {
    const { running, queued, finished } = groupVisibleRecords(
      this.manager.listAgents(),
      this.finished,
    );

    const countText = formatCounts(
      running.length,
      queued.length,
      finished.length,
    );
    const lines: string[] = [
      `${theme.fg("accent", "● Agents")}${countText ? ` ${theme.fg("dim", countText)}` : ""}`,
    ];

    const entries: AgentRecord[] = [...running, ...finished];
    const hasQueuedSummary = queued.length > 0;
    const maxLinesBeforeQueue = hasQueuedSummary ? MAX_LINES - 1 : MAX_LINES;

    for (let index = 0; index < entries.length; index++) {
      if (lines.length + 2 > maxLinesBeforeQueue) break;
      const record = entries[index];
      const activity = this.activity.get(record.id);
      const isLast = index === entries.length - 1 && !hasQueuedSummary;
      const branch = theme.fg("borderMuted", isLast ? "└" : "├");
      const childPrefix = theme.fg("borderMuted", isLast ? "  " : "│ ");
      const isRunning = record.status === "running";
      const icon = isRunning
        ? this.renderRunningIcon(theme)
        : record.status === "completed"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
      const name = theme.fg(
        "toolTitle",
        theme.bold(displayAgentName(record.agent.name)),
      );
      const title = theme.fg(
        "muted",
        truncateToWidth(displayTask(record), Math.max(12, width - 28), ""),
      );
      const elapsed = theme.fg(
        "dim",
        formatMs(record.startedAt, record.completedAt),
      );
      const status = isRunning
        ? activity?.activeTool || activity?.latestText || "thinking…"
        : `${record.status}${record.status === "completed" ? "" : record.error ? ` · ${record.error}` : ""}`;
      const toolCount =
        record.toolUses > 0 ? ` · ${record.toolUses} tools` : "";

      lines.push(
        `${branch} ${icon} ${name} ${title} ${theme.fg("dim", "·")} ${elapsed}`,
      );
      lines.push(
        `${childPrefix} ${theme.fg("borderMuted", "└")} ${theme.fg("dim", truncateToWidth(`${status}${toolCount}`, Math.max(10, width - 4), ""))}`,
      );
    }

    if (hasQueuedSummary) {
      const branch = theme.fg("borderMuted", "└");
      lines.push(
        `${branch} ${theme.fg("muted", "○")} ${theme.fg("muted", `${queued.length} queued`)}`,
      );
    }

    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}
