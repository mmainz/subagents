# Orchestration evals

Lightweight end-to-end evals for the custom Pi subagent orchestration layer.

## Goal

These evals focus on **orchestration behavior**, not exact factual correctness.
They test whether the main agent:

- delegates noisy exploration, research, or media inspection when a task would otherwise bloat the main context window
- keeps planning and final recommendations in the main thread unless a second-opinion review is explicitly warranted
- avoids delegation for tiny, single-file lookups
- chooses the expected subagents
- launches multiple focused subagent runs when broad exploration should be split
- launches and retrieves background subagent runs when a case explicitly asks for background fanout
- treats the strongest fanout prompts more strictly than generic broad-exploration prompts
- scores successful subagent results, not just attempted tool calls
- synthesizes returned subagent handoffs instead of doing excessive post-delegation re-exploration

## Repositories

The starter suite uses two pinned public repositories:

- `fastapi/fastapi` @ `eba8942c81dbf990d25fbae34e6601bdbc21e74b`
- `vercel/next.js` @ `8e5a36f6347528d8968da97262f372f908897bac`

By default, the runner clones them into `/tmp/pi-subagent-evals` and checks out the pinned commits.
It also sets `PI_CODING_AGENT_DIR` to this repo's `.pi/agent` directory so eval runs do not depend on the ambient `~/.pi/agent` state.

## Files

- `cases.ts` — repository metadata and eval cases
- `run.ts` — clone/checkout, eval runner, event parsing, and scoring
- `../conversation-context/run.ts` — lightweight non-LLM checks for `conversation_context` parsing/defaults and the fork runtime code path

## Running

List cases:

```bash
bun evals/orchestration/run.ts --list
```

Run all cases:

```bash
bun evals/orchestration/run.ts
```

Fail on any soft-check regression, in addition to hard-gate failures:

```bash
bun evals/orchestration/run.ts --strict-soft
```

By default, the runner uses up to `6` parallel workers (`auto`, capped by CPU count and selected cases). Override this if needed:

```bash
bun evals/orchestration/run.ts --jobs 8
bun evals/orchestration/run.ts --jobs auto
```

Higher values reduce wall-clock time but start more full `pi` processes and can hit provider/model rate or usage limits faster.

Run a single case:

```bash
bun evals/orchestration/run.ts --case nextjs-fanout-explore-main-plan
```

Run the conversation-context checks:

```bash
bun evals/conversation-context/run.ts
```

Override the clone directory:

```bash
bun evals/orchestration/run.ts --base-dir /tmp/my-eval-repos
```

Override the results directory:

```bash
bun evals/orchestration/run.ts --results-dir /tmp/my-eval-results
```

You can also set parallelism with an environment variable:

```bash
PI_SUBAGENT_EVAL_JOBS=2 bun evals/orchestration/run.ts
```

You can also enforce soft checks in automation with an environment variable:

```bash
PI_SUBAGENT_EVAL_STRICT_SOFT=1 bun evals/orchestration/run.ts
```

## What gets scored

The runner reports both **pass/fail** and a **weighted score**.

### Hard gates

A case is marked `PASS` only if all hard gates pass:

- correct delegate-vs.-no-delegate decision
- final answer present
- `pi` process exited successfully

### Soft scored checks

The remaining orchestration checks contribute weighted partial credit:

- required agents complete successfully
- forbidden agents do not complete successfully
- the minimum number of successful subagent runs is met, when a case requires it
- background subagent launches are retrieved with `get_subagent_result`, when a case requires it
- required background subagent results complete successfully
- post-delegation validation stays reasonably narrow across the whole delegated flow, not just after the last subagent call
- planning stays in the main thread for cases that are supposed to delegate exploration but not synthesis or planning
- stricter post-delegation validation budgets are followed for informational or discovery cases

### Score shape

Each case reports:

- `pass` — hard gates only
- `allChecksPass` — a strict perfect run across all checks
- `scoreEarned/scoreMax`
- weighted percentage
- dimension subscores for:
  - `delegation`
  - `routing`
  - `coordination`
  - `execution`

`scoreMax` can vary by case depending on which expectations apply, so the percentage is the most comparable metric across cases.

## Artifacts

Each run writes timestamped artifacts under:

- `evals/orchestration/results/<timestamp>/`

For each run, the runner also writes:

- `summary.json` — machine-readable suite summary for that run
- `summary.md` — human-readable suite summary table for that run

At the results root, it maintains:

- `latest-summary.json` — latest run summary snapshot
- `latest-summary.md` — latest run summary snapshot in Markdown
- `history.jsonl` — append-only one-line summary per run for trend comparison

Each case gets:

- `events.jsonl` — raw Pi JSON event stream
- `stderr.txt` — stderr from the run
- `case.json` — the case definition
- `result.json` — parsed observation, weighted score, and dimension breakdown

## Notes

- These evals intentionally prioritize **routing and delegation behavior**.
- The current suite focuses on `explore`, `research`, `multimodal`, and the narrower second-opinion use of `review`.
- They provide a good first layer before adding richer quality grading or LLM-as-judge checks.
- If a case proves too brittle, prefer weakening the exact agent expectation over deleting the case entirely.
- The suite distinguishes between broad exploration cases, where one strong `explore` run may be acceptable; intermediate fanout cases, where the task naturally spans multiple independent areas and should usually be split even without explicit instruction; and stronger fanout stress cases, which explicitly call for several focused subagent runs.
- For quick before-and-after comparisons, use `summary.md` for a single run and `history.jsonl` for run-to-run tracking.
- Eval runs can reduce wall-clock time substantially, and each worker starts a full `pi` process. This repo defaults to `auto` parallelism capped at `6` workers; override that with `--jobs` or `PI_SUBAGENT_EVAL_JOBS` if you want to tune it. Higher values are faster when quota allows, but can hit provider/model rate or usage limits sooner.
