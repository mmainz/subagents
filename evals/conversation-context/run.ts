import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

function writeAgent(dir: string, name: string, conversationContext?: string) {
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${name} conversation context probe.`,
    "model: openai-codex/gpt-5.5",
    "thinking: minimal",
    "tools: []",
    "extensions: false",
    "inherit_context: false",
    "inherit_skills: false",
    "prompt_mode: replace",
  ];
  if (conversationContext)
    lines.push(`conversation_context: ${conversationContext}`);
  lines.push(
    "---",
    "",
    "Report whether prior parent conversation context is visible.",
  );
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

async function main() {
  const tempAgentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-subagent-context-eval-"),
  );
  const subagentsDir = path.join(tempAgentDir, "subagents");
  fs.mkdirSync(subagentsDir, { recursive: true });
  writeAgent(subagentsDir, "context-fork-probe", "fork");
  writeAgent(subagentsDir, "context-isolated-probe", "isolated");
  writeAgent(subagentsDir, "context-default-probe");

  process.env.PI_CODING_AGENT_DIR = tempAgentDir;

  const { discoverSubagentRegistry } = await import("../../agents.ts");
  const registry = discoverSubagentRegistry();
  const byName = new Map(registry.agents.map((agent) => [agent.name, agent]));
  const runnerSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../runtime/agent-runner.ts"),
    "utf8",
  );

  const builtInNonIsolated = registry.agents
    .filter((agent) => agent.scope === "default")
    .filter((agent) => agent.conversationContext !== "isolated")
    .map((agent) => agent.name);

  const checks: Check[] = [
    {
      name: "fork-frontmatter-parses",
      pass: byName.get("context-fork-probe")?.conversationContext === "fork",
      detail: `observed=${byName.get("context-fork-probe")?.conversationContext ?? "missing"}`,
    },
    {
      name: "isolated-frontmatter-parses",
      pass:
        byName.get("context-isolated-probe")?.conversationContext ===
        "isolated",
      detail: `observed=${byName.get("context-isolated-probe")?.conversationContext ?? "missing"}`,
    },
    {
      name: "default-is-isolated",
      pass:
        byName.get("context-default-probe")?.conversationContext === "isolated",
      detail: `observed=${byName.get("context-default-probe")?.conversationContext ?? "missing"}`,
    },
    {
      name: "built-ins-are-isolated",
      pass: builtInNonIsolated.length === 0,
      detail: builtInNonIsolated.length
        ? `non-isolated=${builtInNonIsolated.join(", ")}`
        : "all default agents isolated",
    },
    {
      name: "fork-runtime-copies-parent-session-context",
      pass:
        runnerSource.includes('agent.conversationContext === "fork"') &&
        runnerSource.includes(
          "ctx.sessionManager.buildSessionContext().messages",
        ) &&
        runnerSource.includes("sessionManager.appendMessage(message)") &&
        !runnerSource.includes("session.messages = structuredClone"),
      detail:
        "agent-runner.ts should seed the child session manager only for fork agents",
    },
  ];

  const passed = checks.filter((check) => check.pass).length;
  for (const check of checks) {
    console.log(
      `${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
    );
  }
  console.log(
    `\nConversation context checks: ${passed}/${checks.length} passed`,
  );

  fs.rmSync(tempAgentDir, { recursive: true, force: true });
  if (passed !== checks.length) process.exit(1);
}

await main();
