import { initTheme } from "@mariozechner/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { showConversationViewer } from "./conversation-viewer.js";

beforeAll(() => {
  initTheme();
});

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

type ViewerFactory = (
  tui: { requestRender(): void },
  theme: typeof theme,
  keybindings: undefined,
  done: () => void,
) => { render(width: number): string[] };

function makeRecord() {
  return {
    id: "ag_test",
    agent: { name: "test" },
    cwd: process.cwd(),
    status: "completed",
    result: "Fallback result",
    abortController: new AbortController(),
    toolUses: 0,
    session: {
      messages: [
        { role: "user", content: "Task text" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Answer text" }],
          stopReason: "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          api: "test",
          provider: "test",
          model: "test",
          timestamp: Date.now(),
        },
      ],
    },
  };
}

describe("showConversationViewer", () => {
  it("renders subagent messages with Pi conversation components instead of transcript headings", async () => {
    let component: { render(width: number): string[] } | undefined;

    await showConversationViewer(
      {
        ui: {
          custom: async (factory: ViewerFactory) => {
            component = factory(
              { requestRender: vi.fn() },
              theme,
              undefined,
              vi.fn(),
            );
          },
        },
      },
      makeRecord() as any,
    );

    const rendered = component?.render(100).join("\n") ?? "";
    expect(rendered).toContain("Task text");
    expect(rendered).toContain("Answer text");
    expect(rendered).not.toContain("## User");
    expect(rendered).not.toContain("## Assistant");
  });
});
