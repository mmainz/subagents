# Pi Subagents

Automatic Markdown-configured subagent delegation for Pi coding-agent workflows.

This extension teaches the main Pi agent when to hand focused work to specialist subagents. Each subagent is defined as a Markdown file with a `use_when` routing hint. When a user request matches an enabled agent's `use_when`, the main agent is prompted to delegate that focused work instead of filling its own context with broad repository exploration, web research, visual inspection, or independent review.

## What it does

- Injects a concise catalog of enabled subagents into the main agent prompt.
- Routes work using each agent's Markdown `use_when` guidance.
- Runs subagents in-process, either foreground or background.
- Returns compact handoffs that the main agent can use for final synthesis.
- Supports background runs through `get_subagent_result`.
- Shows active/running agents in the UI and provides `/agents` inspection commands.
- Lets users fully override or disable built-in agents with `~/.pi/agent/subagents/*.md`.

The goal is not to create autonomous agent swarms. The main agent still owns final synthesis, planning, recommendations, and implementation unless the user explicitly asks otherwise. Subagents are used to keep focused helper work out of the main context window.

## Built-in agents

Built-in agents live in [`agents/`](agents/):

- `explore` — broad repository exploration, codebase mapping, and evidence gathering.
- `research` — external web research, official docs, best practices, APIs, and ecosystem guidance.
- `multimodal` — focused local image/screenshot/diagram/video or visual web page inspection.
- `review` — explicit independent second-opinion review or high-risk validation.
- `simplify` — small behavior-preserving cleanup of recently changed code.
- `general` — explicit-only general-purpose helper.

Agents without `use_when` are treated as explicit-only: the main agent should use them only when the user explicitly requests that agent.

## Use locally

Load the extension directly with Pi:

```bash
pi --extension ~/code/subagents/index.ts
```

For a one-off non-interactive run:

```bash
pi -p --extension ~/code/subagents/index.ts "Map this repository and summarize the major components."
```

You can also add this extension path to your Pi configuration if you want it loaded by default.

## Tools and commands

The extension registers:

- `subagent` — run a configured subagent. Foreground runs return a handoff; background runs return an agent ID.
- `get_subagent_result` — retrieve or await a background subagent result.
- `/agents` — inspect enabled, disabled, and running agents.

## Agent definitions

Each agent is a Markdown file with frontmatter metadata and a prompt body. The Markdown body is the actual subagent prompt.

Example:

```md
---
name: explore
description: Fast repository exploration, codebase mapping, and evidence gathering.
use_when: the task needs broad repository-specific exploration, codebase mapping, finding many uses, locating related files/symbols across an area, or understanding how code is structured before planning or editing.
model: openai-codex/gpt-5.5
thinking: minimal
tools: [read, grep, find, ls, bash]
prompt_mode: replace
conversation_context: isolated
---

This is a read-only exploration and evidence-gathering task, not implementation or final planning.
```

Common frontmatter fields:

- `name` — agent name used by the `subagent` tool.
- `description` — short catalog description shown to the main agent.
- `use_when` — routing hint used for automatic delegation.
- `model` / `thinking` — model configuration.
- `tools` — tools available to the subagent.
- `extensions` — whether to load extensions in the child session.
- `inherit_context` — whether AGENTS/CLAUDE context files are loaded.
- `inherit_skills` — whether skills are loaded.
- `prompt_mode` — `append` or `replace`.
- `conversation_context` — `isolated` or `fork`.

## User overrides and disables

User overrides are read from:

```text
~/.pi/agent/subagents/*.md
```

A user agent with the same `name` fully replaces a built-in agent.

To disable a built-in agent:

```md
---
name: research
enabled: false
---
```

There is intentionally no partial inheritance or `extends` mechanism. Overrides are full replacements so the active behavior stays transparent.

## Runtime notes

- Foreground subagents return a handoff directly to the main agent.
- Background subagents return an agent ID and should be retrieved with `get_subagent_result`.
- Nested subagents are blocked by default.
- Built-in agents currently use `conversation_context: isolated`.
- `conversation_context: fork` starts the subagent from a snapshot of the parent conversation.

## Requirements

For using the extension:

- Pi with local TypeScript extension support.
- A model/provider configuration available to Pi for the models referenced by your agents.

For working on this repository:

- Bun, for scripts and evals.
- Node.js new enough to support `node --experimental-strip-types --check` for the current syntax check script.

If you want to run repo scripts or install dependencies locally:

```bash
bun install
```

## Development

Prefer Bun for repository scripts:

```bash
bun run format
bun run check
bun run eval:conversation-context
bun run eval:orchestration -- --case fastapi-no-delegate-single-file
```

Useful scripts:

- `bun run format` — format the repo with Prettier.
- `bun run check:syntax` — fast syntax validation for TypeScript files.
- `bun run check` — syntax validation plus conversation-context eval.
- `bun run eval:conversation-context` — lightweight non-LLM config/runtime checks.
- `bun run eval:orchestration` — full orchestration eval suite.
- `bun run eval:list` — list orchestration eval cases.

The orchestration eval defaults to auto parallelism capped at 6 workers. Override with:

```bash
bun run eval:orchestration -- --jobs 8
bun run eval:orchestration -- --jobs 1 # useful for debugging a single flaky case
```

Generated orchestration eval artifacts are written under `evals/orchestration/results/` and ignored by Git.

## Repository layout

```text
agents/                         Built-in Markdown agent definitions
runtime/                        In-process subagent runner/manager
ui/                             Active-agent widget and conversation viewer
evals/conversation-context/     Lightweight config/runtime checks
evals/orchestration/            End-to-end orchestration evals
index.ts                        Pi extension entrypoint
agents.ts                       Agent discovery and registry formatting
```
