# AGENTS.md

Guidance for coding agents working in this repository.

## Project

This repository contains the `subagents` Pi extension. Its main differentiator is automatic delegation: Markdown agent files define `use_when` routing hints, and the main Pi agent is guided to delegate matching focused work to subagents. It also provides in-process subagent execution, background result retrieval, active-agent UI, and orchestration evals.

## Tooling

- Prefer `bun` for running scripts and evals.
- Use `bun run <script>` for package scripts.
- Use `bunx prettier --write <files>` for formatting when needed.
- `node --experimental-strip-types --check ...` is currently used for syntax validation because it is a fast check for these TypeScript extension files.

## Common commands

```bash
bun run format
bun run check
bun run eval:conversation-context
bun run eval:orchestration -- --case fastapi-no-delegate-single-file
bun run eval:orchestration
```

The orchestration eval defaults to auto parallelism. Use `--jobs 1` only for debugging a flaky single case or when readable logs matter.

## Code style

- Keep changes small and focused.
- Preserve the extension's current simple file layout unless a larger restructuring is explicitly requested.
- Prefer direct, readable TypeScript over extra abstraction.
- Keep prompt text concise and avoid duplicating guidance across tool metadata, system prompt injection, and agent Markdown.
- Markdown agent files are the source of truth for agent routing metadata and prompt bodies.

## Validation

Before considering changes done, run the smallest relevant validation:

- TypeScript/syntax-only changes:
  ```bash
  bun run check:syntax
  ```
- Agent discovery or `conversation_context` changes:
  ```bash
  bun run eval:conversation-context
  ```
- Orchestration/prompt/routing changes:
  ```bash
  bun run eval:orchestration -- --case <affected-case>
  ```

Do not commit generated eval artifacts under `evals/orchestration/results/`.
