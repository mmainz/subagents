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
type ConversationMessage = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  stopReason?: string;
  errorMessage?: string;
};
type ToolCall = { id: string; name: string; arguments: unknown };

function isContentBlock(block: unknown): block is ContentBlock {
  return block !== null && typeof block === "object";
}

function asConversationMessage(
  message: unknown,
): ConversationMessage | undefined {
  return isContentBlock(message) ? (message as ConversationMessage) : undefined;
}

function getUserMessageText(message: ConversationMessage): string {
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

function getToolCalls(message: ConversationMessage): ToolCall[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (block): block is ToolCall =>
      isContentBlock(block) &&
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string",
  );
}

function addUserMessage(
  container: Container,
  message: ConversationMessage,
  markdownTheme: ReturnType<typeof getMarkdownTheme>,
) {
  const textContent = getUserMessageText(message);
  if (!textContent) return;
  if (container.children.length > 0) container.addChild(new Spacer(1));

  const skillBlock = parseSkillBlock(textContent);
  if (!skillBlock) {
    container.addChild(new UserMessageComponent(textContent, markdownTheme));
    return;
  }

  container.addChild(
    new SkillInvocationMessageComponent(skillBlock, markdownTheme),
  );
  if (skillBlock.userMessage) {
    container.addChild(
      new UserMessageComponent(skillBlock.userMessage, markdownTheme),
    );
  }
}

function addToolFailureResult(
  component: ToolExecutionComponent,
  message: ConversationMessage,
) {
  if (message.stopReason !== "aborted" && message.stopReason !== "error") {
    return;
  }

  const defaultMessage =
    message.stopReason === "aborted" ? "Operation aborted" : "Error";
  component.updateResult({
    content: [{ type: "text", text: message.errorMessage || defaultMessage }],
    isError: true,
  });
}

function addAssistantMessage(
  container: Container,
  pendingTools: Map<string, ToolExecutionComponent>,
  rawMessage: unknown,
  message: ConversationMessage,
  markdownTheme: ReturnType<typeof getMarkdownTheme>,
  tui: TUI,
  cwd: string,
) {
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
    addToolFailureResult(component, message);
    if (message.stopReason === "aborted" || message.stopReason === "error") {
      pendingTools.delete(toolCall.id);
    }
  }
}

function addToolResult(
  pendingTools: Map<string, ToolExecutionComponent>,
  rawMessage: unknown,
  message: ConversationMessage,
) {
  if (!message.toolCallId) return;
  const component = pendingTools.get(message.toolCallId);
  if (!component) return;

  component.updateResult(rawMessage as any);
  pendingTools.delete(message.toolCallId);
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
    const message = asConversationMessage(rawMessage);
    if (!message) continue;

    if (message.role === "user") {
      addUserMessage(container, message, markdownTheme);
    } else if (message.role === "assistant") {
      addAssistantMessage(
        container,
        pendingTools,
        rawMessage,
        message,
        markdownTheme,
        tui,
        cwd,
      );
    } else if (message.role === "toolResult") {
      addToolResult(pendingTools, rawMessage, message);
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
