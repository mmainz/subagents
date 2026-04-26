import {
  AssistantMessageComponent,
  getMarkdownTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  Spacer,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@mariozechner/pi-tui";
import type { AgentRecord } from "../runtime/types.js";

type ContentBlock = Record<string, unknown>;

function isContentBlock(block: unknown): block is ContentBlock {
  return block !== null && typeof block === "object";
}

function getUserMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is ContentBlock & { text: string } =>
        isContentBlock(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

function getToolCalls(message: {
  content?: unknown;
}): Array<{ id: string; name: string; arguments: unknown }> {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (block): block is { id: string; name: string; arguments: unknown } =>
      isContentBlock(block) &&
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string",
  );
}

function buildConversationComponent(
  session: { messages?: unknown[] },
  tui: TUI,
  cwd: string,
): Component {
  const container = new Container();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const markdownTheme = getMarkdownTheme();

  for (const rawMessage of session.messages ?? []) {
    if (!rawMessage || typeof rawMessage !== "object") continue;
    const message = rawMessage as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      stopReason?: string;
      errorMessage?: string;
    };

    if (message.role === "user") {
      const textContent = getUserMessageText(message);
      if (!textContent) continue;
      if (container.children.length > 0) container.addChild(new Spacer(1));

      const skillBlock = parseSkillBlock(textContent);
      if (skillBlock) {
        container.addChild(
          new SkillInvocationMessageComponent(skillBlock, markdownTheme),
        );
        if (skillBlock.userMessage) {
          container.addChild(
            new UserMessageComponent(skillBlock.userMessage, markdownTheme),
          );
        }
      } else {
        container.addChild(
          new UserMessageComponent(textContent, markdownTheme),
        );
      }
      continue;
    }

    if (message.role === "assistant") {
      container.addChild(
        new AssistantMessageComponent(rawMessage as any, false, markdownTheme),
      );

      for (const toolCall of getToolCalls(message)) {
        const component = new ToolExecutionComponent(
          toolCall.name,
          toolCall.id,
          toolCall.arguments,
          undefined,
          undefined,
          tui,
          cwd,
        );
        container.addChild(component);
        pendingTools.set(toolCall.id, component);

        if (
          message.stopReason === "aborted" ||
          message.stopReason === "error"
        ) {
          const defaultMessage =
            message.stopReason === "aborted" ? "Operation aborted" : "Error";
          component.updateResult({
            content: [
              {
                type: "text",
                text: message.errorMessage || defaultMessage,
              },
            ],
            isError: true,
          });
          pendingTools.delete(toolCall.id);
        }
      }
      continue;
    }

    if (message.role === "toolResult" && message.toolCallId) {
      const component = pendingTools.get(message.toolCallId);
      if (component) {
        component.updateResult(rawMessage as any);
        pendingTools.delete(message.toolCallId);
      }
    }
  }

  return container;
}

function fallbackLines(text: string, width: number): string[] {
  return text
    .split("\n")
    .flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
}

export async function showConversationViewer(
  ctx: any,
  record: AgentRecord,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui: TUI, theme: any, _keybindings: unknown, done: () => void) => {
      let scrollOffset = 0;
      let autoScroll = true;
      let cachedSessionComponent: Component | undefined;
      let cachedMessages: unknown[] | undefined;

      const invalidateSessionComponent = () => {
        cachedSessionComponent = undefined;
        cachedMessages = undefined;
      };
      const unsubscribe = record.session?.subscribe?.(() => {
        invalidateSessionComponent();
        if (autoScroll) scrollOffset = Number.MAX_SAFE_INTEGER;
        tui.requestRender();
      });

      const maxBodyLines = Math.max(
        8,
        Math.min(32, (process.stdout.rows || 32) - 8),
      );
      const getLines = (width: number): string[] => {
        if (!record.session) {
          return fallbackLines(
            record.result || record.error || "No conversation available.",
            Math.max(20, width),
          );
        }

        if (
          !cachedSessionComponent ||
          cachedMessages !== record.session.messages
        ) {
          cachedSessionComponent = buildConversationComponent(
            record.session,
            tui,
            record.cwd,
          );
          cachedMessages = record.session.messages;
        }

        const lines = cachedSessionComponent.render(width);
        return lines.length
          ? lines
          : fallbackLines("No conversation available.", Math.max(20, width));
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
            ...visible.map((line) => truncateToWidth(line, safeWidth, "")),
            ...(below > 0 ? [theme.fg("dim", ` ↓ ${below} more`)] : []),
            truncateToWidth(
              ` ${theme.fg("dim", "↑↓/j/k scroll • pgup/pgdn page • home/end • esc/q close")}`,
              safeWidth,
              "",
            ),
            border,
          ];
        },
        invalidate() {
          cachedSessionComponent?.invalidate();
          invalidateSessionComponent();
        },
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
