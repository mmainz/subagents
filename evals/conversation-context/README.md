# Conversation context eval

Lightweight checks for `conversation_context` support in Markdown subagents.

This eval does not call an LLM. It verifies that:

- `conversation_context: fork` parses from a user Markdown agent,
- `conversation_context: isolated` parses from a user Markdown agent,
- omitted `conversation_context` defaults to `isolated`,
- all built-in default agents are currently `isolated`,
- the in-process runner contains the fork code path that copies the parent session context into the child session.

Run:

```bash
bun evals/conversation-context/run.ts
```

This is intentionally a small regression check. A fuller behavioral test would require a scripted multi-turn agent run and should verify that a forked subagent sees prior parent conversation while an isolated subagent does not.
