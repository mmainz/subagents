import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { formatAgentConversation } from "../runtime/agent-runner.js";
import type { AgentRecord } from "../runtime/types.js";

export async function showConversationViewer(
  ctx: any,
  record: AgentRecord,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui: any, theme: any, _keybindings: unknown, done: () => void) => {
      let scrollOffset = 0;
      let autoScroll = true;
      const unsubscribe = record.session?.subscribe?.(() => {
        if (autoScroll) scrollOffset = Number.MAX_SAFE_INTEGER;
        tui.requestRender();
      });

      const maxBodyLines = Math.max(
        8,
        Math.min(32, (process.stdout.rows || 32) - 8),
      );
      const getLines = (width: number): string[] => {
        const text = record.session
          ? formatAgentConversation(record.session)
          : record.result || record.error || "No conversation available.";
        const contentWidth = Math.max(20, width - 2);
        return text
          .split("\n")
          .flatMap((line) =>
            line ? wrapTextWithAnsi(line, contentWidth) : [""],
          );
      };

      return {
        render(width: number) {
          const safeWidth = Math.max(24, width);
          const border = theme.fg("accent", "─".repeat(safeWidth));
          const lines = getLines(safeWidth);
          const maxScroll = Math.max(0, lines.length - maxBodyLines);
          if (scrollOffset === Number.MAX_SAFE_INTEGER)
            scrollOffset = maxScroll;
          scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset));
          const visible = lines.slice(
            scrollOffset,
            scrollOffset + maxBodyLines,
          );
          const below = Math.max(
            0,
            lines.length - (scrollOffset + visible.length),
          );
          return [
            border,
            truncateToWidth(
              ` ${theme.fg("accent", theme.bold(`${record.agent.name} ${record.id}`))} ${theme.fg("dim", record.status)}`,
              safeWidth,
              "",
            ),
            ...(scrollOffset > 0
              ? [theme.fg("dim", ` ↑ ${scrollOffset} more`)]
              : []),
            ...visible.map((line) =>
              truncateToWidth(` ${line}`, safeWidth, ""),
            ),
            ...(below > 0 ? [theme.fg("dim", ` ↓ ${below} more`)] : []),
            truncateToWidth(
              ` ${theme.fg("dim", "↑↓/j/k scroll • pgup/pgdn page • home/end • esc/q close")}`,
              safeWidth,
              "",
            ),
            border,
          ];
        },
        invalidate() {},
        handleInput(data: string) {
          const maxScroll = Math.max(
            0,
            getLines(process.stdout.columns || 80).length - maxBodyLines,
          );
          const scrollBy = (amount: number) => {
            autoScroll = false;
            scrollOffset = Math.max(
              0,
              Math.min(maxScroll, scrollOffset + amount),
            );
            tui.requestRender();
          };
          if (matchesKey(data, Key.escape) || data === "q") {
            unsubscribe?.();
            done();
          } else if (matchesKey(data, Key.up) || data === "k") scrollBy(-1);
          else if (matchesKey(data, Key.down) || data === "j") scrollBy(1);
          else if (matchesKey(data, Key.pageUp)) scrollBy(-maxBodyLines);
          else if (
            matchesKey(data, Key.pageDown) ||
            matchesKey(data, Key.space)
          )
            scrollBy(maxBodyLines);
          else if (matchesKey(data, Key.home)) {
            autoScroll = false;
            scrollOffset = 0;
            tui.requestRender();
          } else if (matchesKey(data, Key.end)) {
            autoScroll = true;
            scrollOffset = maxScroll;
            tui.requestRender();
          }
        },
        dispose() {
          unsubscribe?.();
        },
      };
    },
    { overlay: true },
  );
}
