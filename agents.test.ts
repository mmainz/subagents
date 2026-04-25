import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverSubagentRegistry,
  formatAgentCatalog,
  formatRegistryWarnings,
} from "./agents.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeAgent(dir: string, fileName: string, content: string) {
  writeFileSync(join(dir, fileName), content.trimStart());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverSubagentRegistry", () => {
  it("parses real-style snake_case metadata and YAML tool arrays", () => {
    const defaultAgentsDir = makeTempDir();
    const userAgentsDir = makeTempDir();
    writeAgent(
      defaultAgentsDir,
      "alpha.md",
      `---
name: alpha
description: Alpha agent
use_when: when alpha is useful
model: provider/model
thinking: minimal
tools: [read, bash, grep]
extensions: "true"
inherit_context: "false"
inherit_skills: "true"
prompt_mode: replace
conversation_context: fork
---
Alpha system prompt.
`,
    );

    const registry = discoverSubagentRegistry({
      defaultAgentsDir,
      userAgentsDir,
    });

    expect(registry.warnings).toEqual([]);
    expect(registry.disabledAgents).toEqual([]);
    expect(registry.agents).toHaveLength(1);
    expect(registry.agents[0]).toMatchObject({
      name: "alpha",
      description: "Alpha agent",
      useWhen: "when alpha is useful",
      model: "provider/model",
      thinking: "minimal",
      tools: ["read", "bash", "grep"],
      extensions: true,
      inheritContext: false,
      inheritSkills: true,
      promptMode: "replace",
      conversationContext: "fork",
      systemPrompt: "Alpha system prompt.",
      scope: "default",
    });
  });

  it("parses camelCase compatibility aliases and comma-separated tools", () => {
    const defaultAgentsDir = makeTempDir();
    const userAgentsDir = makeTempDir();
    writeAgent(
      defaultAgentsDir,
      "aliases.md",
      `---
name: aliases
description: Alias agent
useWhen: when aliases are useful
model: provider/model
thinking: high
tools: read, bash
inheritContext: false
inheritSkills: true
promptMode: replace
conversationContext: fork
---
Alias prompt.
`,
    );

    const registry = discoverSubagentRegistry({
      defaultAgentsDir,
      userAgentsDir,
    });

    expect(registry.agents[0]).toMatchObject({
      name: "aliases",
      useWhen: "when aliases are useful",
      tools: ["read", "bash"],
      inheritContext: false,
      inheritSkills: true,
      promptMode: "replace",
      conversationContext: "fork",
    });
  });

  it("lets user agents override or disable default agents", () => {
    const defaultAgentsDir = makeTempDir();
    const userAgentsDir = makeTempDir();
    writeAgent(
      defaultAgentsDir,
      "explore.md",
      `---
name: explore
description: Default explore
model: provider/model
thinking: low
---
Default prompt.
`,
    );
    writeAgent(
      defaultAgentsDir,
      "research.md",
      `---
name: research
description: Default research
model: provider/model
thinking: low
---
Research prompt.
`,
    );
    writeAgent(
      userAgentsDir,
      "explore.md",
      `---
name: explore
description: User explore
model: provider/model
thinking: high
---
User prompt.
`,
    );
    writeAgent(
      userAgentsDir,
      "research.md",
      `---
name: research
enabled: false
---
`,
    );

    const registry = discoverSubagentRegistry({
      defaultAgentsDir,
      userAgentsDir,
    });

    expect(registry.agents.map((agent) => agent.name)).toEqual(["explore"]);
    expect(registry.agents[0]).toMatchObject({
      name: "explore",
      description: "User explore",
      thinking: "high",
      systemPrompt: "User prompt.",
      scope: "user",
    });
    expect(registry.disabledAgents).toEqual([
      expect.objectContaining({ name: "research", scope: "user" }),
    ]);
  });

  it("warns for invalid agents and keeps the later duplicate in a layer", () => {
    const defaultAgentsDir = makeTempDir();
    const userAgentsDir = makeTempDir();
    writeAgent(
      defaultAgentsDir,
      "01-missing-name.md",
      `---
description: Missing name
---
Prompt.
`,
    );
    writeAgent(
      defaultAgentsDir,
      "02-missing-description.md",
      `---
name: missing-description
---
Prompt.
`,
    );
    writeAgent(
      defaultAgentsDir,
      "03-invalid.md",
      `---
name: invalid
description: Invalid metadata
thinking: enormous
prompt_mode: merge
conversation_context: shared
---
`,
    );
    writeAgent(
      defaultAgentsDir,
      "04-duplicate.md",
      `---
name: duplicate
description: First duplicate
model: provider/model
thinking: low
---
First.
`,
    );
    writeAgent(
      defaultAgentsDir,
      "05-duplicate.md",
      `---
name: duplicate
description: Second duplicate
model: provider/model
thinking: medium
---
Second.
`,
    );

    const registry = discoverSubagentRegistry({
      defaultAgentsDir,
      userAgentsDir,
    });

    expect(registry.agents.map((agent) => agent.name)).toEqual([
      "duplicate",
      "invalid",
    ]);
    expect(
      registry.agents.find((agent) => agent.name === "duplicate"),
    ).toMatchObject({
      description: "Second duplicate",
      thinking: "medium",
      systemPrompt: "Second.",
    });
    expect(registry.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing required frontmatter field 'name'"),
        expect.stringContaining("missing required field 'description'"),
        expect.stringContaining("invalid thinking level 'enormous'"),
        expect.stringContaining("has no model configured"),
        expect.stringContaining("has no thinking level configured"),
        expect.stringContaining("has an empty prompt body"),
        expect.stringContaining("invalid prompt_mode 'merge'"),
        expect.stringContaining("invalid conversation_context 'shared'"),
        expect.stringContaining("Duplicate default subagent 'duplicate'"),
      ]),
    );
  });
});

describe("formatAgentCatalog", () => {
  it("formats configured agents and marks explicit-only agents", () => {
    expect(
      formatAgentCatalog([
        {
          name: "explore",
          description: "Explore repo",
          useWhen: "repository mapping is needed",
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
        },
        {
          name: "general",
          description: "General helper",
          tools: [],
          extensions: false,
          enabled: true,
          inheritContext: true,
          inheritSkills: false,
          promptMode: "append",
          conversationContext: "isolated",
          systemPrompt: "Prompt.",
          filePath: "/tmp/general.md",
          scope: "default",
        },
      ]),
    ).toBe(
      [
        "- explore — Explore repo",
        "  use_when: repository mapping is needed",
        "- general — General helper",
        "  no use_when: use only when the user explicitly requests it.",
      ].join("\n"),
    );
  });

  it("formats empty catalogs and warnings", () => {
    expect(formatAgentCatalog([])).toBe("No subagents are configured.");
    expect(formatRegistryWarnings([])).toBe("No validation warnings.");
    expect(formatRegistryWarnings(["one", "two"])).toBe("- one\n- two");
  });
});
