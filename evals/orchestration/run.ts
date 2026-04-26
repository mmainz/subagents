import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { cases, repos, type EvalCase, type EvalRepo } from "./cases.ts";

export interface ToolCallRecord {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
  handoffTextBeforeCall?: string;
}

interface SubagentRunRecord {
  toolCallId?: string;
  agent?: string;
  agentId?: string;
  runInBackground: boolean;
  status?: string;
  isError: boolean;
  completed: boolean;
  retrieved: boolean;
  finalTextLength: number;
}

interface GetSubagentResultRecord {
  toolCallId?: string;
  agentId?: string;
  status?: string;
  isError: boolean;
  completed: boolean;
}

export interface EvalObservation {
  toolCalls: ToolCallRecord[];
  attemptedSubagentCalls: number;
  subagentCalls: number;
  backgroundSubagentCalls: number;
  getSubagentResultCalls: number;
  completedSubagentRuns: number;
  subagentRuns: SubagentRunRecord[];
  getSubagentResults: GetSubagentResultRecord[];
  attemptedAgentsUsed: string[];
  agentsUsed: string[];
  handoffCoverageMissingKeywords: string[];
  postDelegationValidation: number;
  delegatedPlanningCount: number;
  finalAnswer: string;
  assistantModel?: string;
  exitCode: number;
  stderr: string;
  rawEventsPath: string;
}

type ScoreDimension = "delegation" | "routing" | "coordination" | "execution";

export interface ScoreCheck {
  name: string;
  pass: boolean;
  detail: string;
  weight: number;
  hardGate: boolean;
  dimension: ScoreDimension;
}

interface DimensionScore {
  earned: number;
  max: number;
}

export interface EvalScore {
  pass: boolean;
  allChecksPass: boolean;
  scoreEarned: number;
  scoreMax: number;
  percentage: number;
  hardGateFailures: string[];
  dimensions: Record<ScoreDimension, DimensionScore>;
  checks: ScoreCheck[];
}

interface EvalResult {
  caseId: string;
  repoId: string;
  repoDir: string;
  observation: EvalObservation;
  score: EvalScore;
}

interface RunSummaryCase {
  caseId: string;
  repoId: string;
  pass: boolean;
  allChecksPass: boolean;
  scoreEarned: number;
  scoreMax: number;
  percentage: number;
  delegated: boolean;
  attemptedSubagentCalls: number;
  subagentCalls: number;
  backgroundSubagentCalls: number;
  getSubagentResultCalls: number;
  completedSubagentRuns: number;
  agentsUsed: string[];
  postDelegationValidation: number;
  delegatedPlanningCount: number;
  hardGateFailures: string[];
  failedChecks: string[];
  dimensions: Record<ScoreDimension, DimensionScore>;
  rawEventsPath: string;
}

interface RunSummary {
  schemaVersion: 1;
  generatedAt: string;
  runId: string;
  runDir: string;
  caseCount: number;
  passed: number;
  perfect: number;
  suiteEarned: number;
  suiteMax: number;
  suitePercentage: number;
  dimensions: Record<ScoreDimension, DimensionScore>;
  repos: string[];
  cases: RunSummaryCase[];
}

interface SummaryArtifactPaths {
  runSummaryJsonPath: string;
  runSummaryMarkdownPath: string;
  latestSummaryJsonPath: string;
  latestSummaryMarkdownPath: string;
  historyJsonlPath: string;
}

const DEFAULT_BASE_DIR = path.join("/tmp", "pi-subagent-evals");
const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS_DIR = path.join(EVAL_DIR, "results");
const REPO_ROOT = path.resolve(EVAL_DIR, "../..");
const EXTENSION_PATH = path.join(REPO_ROOT, "index.ts");
const SOURCE_AGENT_DIR = getAgentDir();
const AGENT_DIR =
  process.env.PI_SUBAGENT_EVAL_AGENT_DIR ||
  path.join(os.tmpdir(), "pi-subagent-evals-agent");
const DOTFILES_ROOT = process.env.DOTFILES_ROOT || os.homedir();

const CHECK_WEIGHTS = {
  delegateDecision: 30,
  routing: 35,
  coordination: 10,
  minSubagentCalls: 10,
  backgroundRetrieval: 10,
  completedSubagents: 10,
  finalAnswer: 5,
  processExit: 5,
} as const;

const DIMENSION_ORDER: ScoreDimension[] = [
  "delegation",
  "routing",
  "coordination",
  "execution",
];

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDefaultJobs(): number {
  const cpuCount = os.availableParallelism?.() || os.cpus().length || 6;
  return Math.max(3, Math.min(6, cpuCount));
}

function parseJobs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  if (value === "auto") return getDefaultJobs();
  return parsePositiveInt(value, fallback);
}

function resolvePromptTemplate(prompt: string): string {
  return prompt.replaceAll("{{DOTFILES_ROOT}}", DOTFILES_ROOT);
}

function copyIfExists(source: string, destination: string) {
  if (fs.existsSync(source)) fs.copyFileSync(source, destination);
}

function prepareEvalAgentDir() {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  copyIfExists(
    path.join(SOURCE_AGENT_DIR, "auth.json"),
    path.join(AGENT_DIR, "auth.json"),
  );
  copyIfExists(
    path.join(SOURCE_AGENT_DIR, "models.json"),
    path.join(AGENT_DIR, "models.json"),
  );

  const sourceSettingsPath = path.join(SOURCE_AGENT_DIR, "settings.json");
  if (!fs.existsSync(sourceSettingsPath)) return;

  try {
    const settings = JSON.parse(fs.readFileSync(sourceSettingsPath, "utf8"));
    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
      delete settings.packages;
      delete settings.extensions;
      fs.writeFileSync(
        path.join(AGENT_DIR, "settings.json"),
        `${JSON.stringify(settings, null, 2)}\n`,
        "utf8",
      );
    }
  } catch {
    // Eval runs can proceed with default settings if local settings are invalid.
  }
}

export function countDelegatedPlanningCalls(
  toolCalls: ToolCallRecord[],
): number {
  const planningPattern =
    /\b(plan|planning|implementation plan|investigation plan|recommend|recommendation|design direction|propose|proposal)\b/i;
  const evidenceOnlyPlanningPattern =
    /\b(gather|collect|provide|return)\b.{0,80}\b(evidence|findings|constraints|integration points)\b.{0,80}\b(plan|planning|recommendation|design)\b|\b(for|to inform)\b.{0,40}\b(a|the|later|future)?\b.{0,20}\b(plan|planning|recommendation|design)\b/i;
  const explicitNoFinalPlanningPattern =
    /\bdo not\b.{0,40}\b(propose|produce|provide|write|own)\b.{0,80}\b(final )?(plan|planning|recommendation|proposal|design)\b/i;

  return toolCalls.filter((call) => {
    if (call.name !== "subagent") return false;
    const task =
      typeof call.arguments.task === "string" ? call.arguments.task : "";
    return (
      planningPattern.test(task) &&
      !evidenceOnlyPlanningPattern.test(task) &&
      !explicitNoFinalPlanningPattern.test(task)
    );
  }).length;
}

export function parseArgs(argv: string[]) {
  const selectedCaseIds = new Set<string>();
  let baseDir = process.env.PI_SUBAGENT_EVAL_BASE_DIR || DEFAULT_BASE_DIR;
  let resultsDir =
    process.env.PI_SUBAGENT_EVAL_RESULTS_DIR || DEFAULT_RESULTS_DIR;
  let jobs = parseJobs(process.env.PI_SUBAGENT_EVAL_JOBS, getDefaultJobs());
  let listOnly = false;
  let strictSoft = process.env.PI_SUBAGENT_EVAL_STRICT_SOFT === "1";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--case" && argv[i + 1]) {
      selectedCaseIds.add(argv[++i]);
      continue;
    }
    if (arg.startsWith("--case=")) {
      selectedCaseIds.add(arg.slice("--case=".length));
      continue;
    }
    if (arg === "--base-dir" && argv[i + 1]) {
      baseDir = argv[++i];
      continue;
    }
    if (arg.startsWith("--base-dir=")) {
      baseDir = arg.slice("--base-dir=".length);
      continue;
    }
    if (arg === "--results-dir" && argv[i + 1]) {
      resultsDir = argv[++i];
      continue;
    }
    if (arg.startsWith("--results-dir=")) {
      resultsDir = arg.slice("--results-dir=".length);
      continue;
    }
    if (arg === "--jobs" && argv[i + 1]) {
      jobs = parseJobs(argv[++i], jobs);
      continue;
    }
    if (arg.startsWith("--jobs=")) {
      jobs = parseJobs(arg.slice("--jobs=".length), jobs);
      continue;
    }
    if (arg === "--list") {
      listOnly = true;
      continue;
    }
    if (arg === "--strict-soft") {
      strictSoft = true;
      continue;
    }
  }

  return { selectedCaseIds, baseDir, resultsDir, jobs, listOnly, strictSoft };
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutSeconds?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: options.env,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timeout = options.timeoutSeconds
      ? setTimeout(() => {
          killed = true;
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 3000);
        }, options.timeoutSeconds * 1000)
      : undefined;

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        exitCode: killed ? 124 : (code ?? 0),
        stdout,
        stderr,
      });
    });
    proc.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: 1, stdout, stderr: stderr || String(error) });
    });
  });
}

async function isGitRepo(repoDir: string): Promise<boolean> {
  if (!fs.existsSync(repoDir)) return false;
  const result = await runCommand(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { cwd: repoDir, timeoutSeconds: 30 },
  );
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function ensureRepo(repo: EvalRepo, baseDir: string): Promise<string> {
  const repoDir = path.join(baseDir, repo.checkoutDirName);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  if (fs.existsSync(repoDir) && !(await isGitRepo(repoDir))) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  if (!fs.existsSync(repoDir)) {
    const clone = await runCommand(
      "git",
      ["clone", "--filter=blob:none", repo.url, repoDir],
      {
        timeoutSeconds: 900,
      },
    );
    if (clone.exitCode !== 0) {
      throw new Error(
        `git clone failed for ${repo.id}: ${clone.stderr || clone.stdout}`,
      );
    }
  }

  const hasCommit = await runCommand(
    "git",
    ["cat-file", "-e", `${repo.commit}^{commit}`],
    { cwd: repoDir, timeoutSeconds: 60 },
  );

  if (hasCommit.exitCode !== 0) {
    const fetch = await runCommand(
      "git",
      ["fetch", "--depth", "1", "origin", repo.commit],
      { cwd: repoDir, timeoutSeconds: 600 },
    );
    if (fetch.exitCode !== 0) {
      throw new Error(
        `git fetch failed for ${repo.id}: ${fetch.stderr || fetch.stdout}`,
      );
    }
  }

  const checkout = await runCommand(
    "git",
    ["checkout", "--detach", repo.commit],
    { cwd: repoDir, timeoutSeconds: 300 },
  );
  if (checkout.exitCode !== 0) {
    throw new Error(
      `git checkout failed for ${repo.id}: ${checkout.stderr || checkout.stdout}`,
    );
  }

  return repoDir;
}

function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        "type" in block &&
        (block as { type?: string }).type === "text" &&
        "text" in block &&
        typeof (block as { text?: string }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function getNestedRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(value?.[key]);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isSuccessfulForegroundSubagentResult(
  details: Record<string, unknown> | undefined,
  isError: boolean,
): boolean {
  const result = getNestedRecord(details, "result");
  return (
    !isError &&
    getNumber(result?.exitCode) === 0 &&
    (getString(result?.finalText) || "").trim().length > 0
  );
}

function extractAgentsFromToolArgs(args: Record<string, unknown>): string[] {
  const agents: string[] = [];
  if (typeof args.agent === "string") agents.push(args.agent);
  if (Array.isArray(args.tasks)) {
    for (const task of args.tasks) {
      const agent = getString(asRecord(task)?.agent);
      if (agent) agents.push(agent);
    }
  }
  return agents;
}

function isReadOfHandoffCitedPath(call: ToolCallRecord): boolean {
  const readPath = getString(call.arguments.path);
  const handoffText = call.handoffTextBeforeCall || "";
  return Boolean(readPath && handoffText.includes(readPath));
}

function isTargetedHandoffFollowup(call: ToolCallRecord): boolean {
  const handoffText = (call.handoffTextBeforeCall || "").toLowerCase();
  if (!handoffText) return false;

  const pathArg = getString(call.arguments.path);
  if (pathArg && handoffText.includes(pathArg.toLowerCase())) return true;

  const patternArg = getString(call.arguments.pattern) || "";
  const tokens = patternArg.toLowerCase().match(/[a-z][a-z0-9-]{5,}/g) || [];
  return tokens.some((token) => handoffText.includes(token));
}

function getExplorationScore(
  toolCalls: ToolCallRecord[],
  startExclusive: number,
  endExclusive: number,
  readAllowance: number,
): number {
  let score = 0;
  let readCount = 0;

  for (const call of toolCalls.slice(startExclusive + 1, endExclusive)) {
    if (call.name === "read") {
      if (!isReadOfHandoffCitedPath(call)) readCount += 1;
      continue;
    }

    if (call.name === "bash") {
      const command =
        typeof call.arguments.command === "string"
          ? call.arguments.command
          : "";
      if (/\brg\b|\bgrep\b|\bfind\b|\bls\b/.test(command)) {
        score += 2;
      }
      continue;
    }

    if (call.name === "grep") {
      score += isTargetedHandoffFollowup(call) ? 0.25 : 0.5;
      continue;
    }

    if (call.name === "find") {
      score += isTargetedHandoffFollowup(call) ? 0.5 : 1;
      continue;
    }

    if (call.name === "ls") {
      score += 1;
    }
  }

  if (readCount > readAllowance) {
    score += readCount - readAllowance;
  }

  return score;
}

function getPostDelegationValidationScore(toolCalls: ToolCallRecord[]): number {
  const subagentIndexes = toolCalls
    .map((call, index) => ({ call, index }))
    .filter((entry) => entry.call.name === "subagent")
    .map((entry) => entry.index);

  if (subagentIndexes.length === 0) return 0;

  let score = 0;
  for (let i = 0; i < subagentIndexes.length; i++) {
    const startIndex = subagentIndexes[i];
    const endIndex = subagentIndexes[i + 1] ?? toolCalls.length;
    score += getExplorationScore(toolCalls, startIndex, endIndex, 2);
  }

  return score;
}

function extractCoverageKeywords(prompt: string): string[] {
  const stopwords = new Set([
    "about",
    "after",
    "areas",
    "before",
    "brief",
    "broad",
    "current",
    "exploratory",
    "framework",
    "large",
    "main",
    "major",
    "modern",
    "needs",
    "primitive",
    "primitives",
    "repository",
    "source",
    "three",
    "through",
    "where",
    "work",
  ]);

  const tokens =
    prompt
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{4,}/g)
      ?.filter((token) => !stopwords.has(token)) || [];

  return unique(tokens).slice(0, 20);
}

function getMissingHandoffCoverageKeywords(
  prompt: string,
  handoffText: string,
): string[] {
  if (!handoffText.trim()) return [];
  const normalizedHandoff = handoffText.toLowerCase();
  return extractCoverageKeywords(prompt).filter(
    (keyword) => !normalizedHandoff.includes(keyword),
  );
}

export function parseObservation(
  stdout: string,
  stderr: string,
  exitCode: number,
  rawEventsPath: string,
  prompt: string,
): EvalObservation {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const events = lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  const toolCalls: ToolCallRecord[] = [];
  const toolCallsById = new Map<string, ToolCallRecord>();
  const subagentRuns: SubagentRunRecord[] = [];
  const getSubagentResults: GetSubagentResultRecord[] = [];
  const attemptedAgentsUsed: string[] = [];
  const agentsUsed: string[] = [];
  const completedSubagentHandoffs: string[] = [];
  let accumulatedHandoffText = "";
  let finalAnswer = "";
  let assistantModel: string | undefined;

  for (const event of events) {
    if (event.type === "agent_end") {
      const messages = Array.isArray(event.messages)
        ? (event.messages as Array<Record<string, unknown>>)
        : [];
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        if (typeof message.model === "string") assistantModel = message.model;
        const text = extractTextContent(message.content);
        if (text) finalAnswer = text;
      }
      continue;
    }

    if (event.type === "tool_execution_start") {
      const name = getString(event.toolName);
      if (!name) continue;
      const id = getString(event.toolCallId);
      const args = asRecord(event.args) || {};
      const record: ToolCallRecord = {
        id,
        name,
        arguments: args,
        handoffTextBeforeCall: accumulatedHandoffText,
      };
      toolCalls.push(record);
      if (id) toolCallsById.set(id, record);
      if (name === "subagent") {
        attemptedAgentsUsed.push(...extractAgentsFromToolArgs(args));
      }
      continue;
    }

    if (event.type !== "tool_execution_end") continue;

    const toolCallId = getString(event.toolCallId);
    const toolName = getString(event.toolName);
    const resultPayload = asRecord(event.result);
    const isError = event.isError === true || resultPayload?.isError === true;
    const details = asRecord(resultPayload?.details);
    const call = toolCallId ? toolCallsById.get(toolCallId) : undefined;

    if (toolName === "subagent") {
      const result = getNestedRecord(details, "result");
      const record = getNestedRecord(details, "record");
      const agent =
        getString(result?.agent) ||
        getString(record?.agent) ||
        getString(call?.arguments.agent);
      const runInBackground =
        record?.runInBackground === true ||
        call?.arguments.run_in_background === true;
      const successfulForeground = isSuccessfulForegroundSubagentResult(
        details,
        isError,
      );
      const run: SubagentRunRecord = {
        toolCallId,
        agent,
        agentId: getString(result?.agentId) || getString(record?.id),
        runInBackground,
        status:
          getString(record?.status) ||
          (successfulForeground ? "completed" : undefined),
        isError,
        completed: successfulForeground,
        retrieved: !runInBackground && successfulForeground,
        finalTextLength: (getString(result?.finalText) || "").trim().length,
      };
      subagentRuns.push(run);
      if (successfulForeground && agent) {
        agentsUsed.push(agent);
        const handoffText = extractTextContent(resultPayload?.content);
        if (handoffText.trim()) {
          completedSubagentHandoffs.push(handoffText);
          accumulatedHandoffText = completedSubagentHandoffs.join("\n\n");
        }
      }
      continue;
    }

    if (toolName === "get_subagent_result") {
      const record = getNestedRecord(details, "record");
      const agentId =
        getString(record?.id) || getString(call?.arguments.agent_id);
      const status = getString(record?.status);
      const completed = !isError && status === "completed";
      const getResult: GetSubagentResultRecord = {
        toolCallId,
        agentId,
        status,
        isError,
        completed,
      };
      getSubagentResults.push(getResult);

      const matchingRun = subagentRuns.find((run) => run.agentId === agentId);
      if (matchingRun) {
        matchingRun.retrieved = true;
        matchingRun.status = status || matchingRun.status;
        matchingRun.completed = completed;
        matchingRun.isError = matchingRun.isError || isError;
        if (completed && matchingRun.agent) {
          agentsUsed.push(matchingRun.agent);
          const handoffText = extractTextContent(resultPayload?.content);
          if (handoffText.trim()) {
            completedSubagentHandoffs.push(handoffText);
            accumulatedHandoffText = completedSubagentHandoffs.join("\n\n");
          }
        }
      }
    }
  }

  const attemptedSubagentCalls = toolCalls.filter(
    (call) => call.name === "subagent",
  ).length;
  const successfulSubagentRuns = subagentRuns.filter((run) => run.completed);
  const subagentCalls = successfulSubagentRuns.length;
  const backgroundSubagentCalls = subagentRuns.filter(
    (run) => run.runInBackground,
  ).length;
  const getSubagentResultCalls = toolCalls.filter(
    (call) => call.name === "get_subagent_result",
  ).length;
  const completedSubagentRuns = successfulSubagentRuns.length;
  const postDelegationValidation = getPostDelegationValidationScore(toolCalls);
  const delegatedPlanningCount = countDelegatedPlanningCalls(toolCalls);

  return {
    toolCalls,
    attemptedSubagentCalls,
    subagentCalls,
    backgroundSubagentCalls,
    getSubagentResultCalls,
    completedSubagentRuns,
    subagentRuns,
    getSubagentResults,
    attemptedAgentsUsed: unique(attemptedAgentsUsed),
    agentsUsed: unique(agentsUsed),
    handoffCoverageMissingKeywords: getMissingHandoffCoverageKeywords(
      prompt,
      accumulatedHandoffText,
    ),
    postDelegationValidation,
    delegatedPlanningCount,
    finalAnswer,
    assistantModel,
    exitCode,
    stderr,
    rawEventsPath,
  };
}

function createEmptyDimensions(): Record<ScoreDimension, DimensionScore> {
  return {
    delegation: { earned: 0, max: 0 },
    routing: { earned: 0, max: 0 },
    coordination: { earned: 0, max: 0 },
    execution: { earned: 0, max: 0 },
  };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function roundDimensions(
  dimensions: Record<ScoreDimension, DimensionScore>,
): Record<ScoreDimension, DimensionScore> {
  return {
    delegation: {
      earned: roundMetric(dimensions.delegation.earned),
      max: roundMetric(dimensions.delegation.max),
    },
    routing: {
      earned: roundMetric(dimensions.routing.earned),
      max: roundMetric(dimensions.routing.max),
    },
    coordination: {
      earned: roundMetric(dimensions.coordination.earned),
      max: roundMetric(dimensions.coordination.max),
    },
    execution: {
      earned: roundMetric(dimensions.execution.earned),
      max: roundMetric(dimensions.execution.max),
    },
  };
}

function distributeWeight(total: number, count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => total / count);
}

function buildChecks(
  evalCase: EvalCase,
  observation: EvalObservation,
): ScoreCheck[] {
  const checks: ScoreCheck[] = [];
  const delegated = observation.subagentCalls > 0;
  const delegateDecisionPass = evalCase.expected.shouldDelegate
    ? delegated
    : observation.attemptedSubagentCalls === 0;

  checks.push({
    name: "delegate-threshold",
    pass: delegateDecisionPass,
    detail: `expected delegate=${evalCase.expected.shouldDelegate}, observed successfulSubagentRuns=${observation.subagentCalls}, attemptedSubagentCalls=${observation.attemptedSubagentCalls}`,
    weight: CHECK_WEIGHTS.delegateDecision,
    hardGate: true,
    dimension: "delegation",
  });

  const agentChecks: Array<{
    name: string;
    pass: boolean;
    detail: string;
  }> = [];

  for (const agent of evalCase.expected.requiredAgents || []) {
    agentChecks.push({
      name: `required-agent:${agent}`,
      pass: observation.agentsUsed.includes(agent),
      detail: `observed agents=${observation.agentsUsed.join(", ") || "none"}`,
    });
  }

  for (const agent of evalCase.expected.forbiddenAgents || []) {
    agentChecks.push({
      name: `forbidden-agent:${agent}`,
      pass: !observation.attemptedAgentsUsed.includes(agent),
      detail: `attempted agents=${observation.attemptedAgentsUsed.join(", ") || "none"}; successful agents=${observation.agentsUsed.join(", ") || "none"}`,
    });
  }

  const agentWeights = distributeWeight(
    CHECK_WEIGHTS.routing,
    agentChecks.length,
  );
  agentChecks.forEach((check, index) => {
    checks.push({
      ...check,
      weight: agentWeights[index] || 0,
      hardGate: false,
      dimension: "routing",
    });
  });

  if (evalCase.expected.shouldDelegate) {
    const maxPostDelegationValidation =
      typeof evalCase.expected.maxPostDelegationValidation === "number"
        ? evalCase.expected.maxPostDelegationValidation
        : 6;

    checks.push({
      name: "limit-post-delegation-validation",
      pass: observation.postDelegationValidation <= maxPostDelegationValidation,
      detail: `expected <= ${maxPostDelegationValidation}, observed post-delegation validation score=${observation.postDelegationValidation} after subagent calls`,
      weight: CHECK_WEIGHTS.coordination,
      hardGate: false,
      dimension: "coordination",
    });
  }

  if (evalCase.expected.shouldKeepPlanningInMainThread) {
    checks.push({
      name: "keep-planning-in-main-thread",
      pass: observation.delegatedPlanningCount === 0,
      detail: `expected delegatedPlanningCount=0, observed=${observation.delegatedPlanningCount}`,
      weight: CHECK_WEIGHTS.coordination,
      hardGate: false,
      dimension: "coordination",
    });
  }

  if (typeof evalCase.expected.minSubagentCalls === "number") {
    checks.push({
      name: "min-subagent-calls",
      pass: observation.subagentCalls >= evalCase.expected.minSubagentCalls,
      detail: `expected successful runs >= ${evalCase.expected.minSubagentCalls}, observed=${observation.subagentCalls}`,
      weight: CHECK_WEIGHTS.minSubagentCalls,
      hardGate: false,
      dimension: "delegation",
    });
  }

  if (typeof evalCase.expected.minBackgroundSubagentCalls === "number") {
    checks.push({
      name: "min-background-subagent-calls",
      pass:
        observation.backgroundSubagentCalls >=
        evalCase.expected.minBackgroundSubagentCalls,
      detail: `expected background launches >= ${evalCase.expected.minBackgroundSubagentCalls}, observed=${observation.backgroundSubagentCalls}`,
      weight: CHECK_WEIGHTS.backgroundRetrieval,
      hardGate: false,
      dimension: "coordination",
    });
  }

  if (typeof evalCase.expected.requiredGetResultCalls === "number") {
    checks.push({
      name: "required-get-subagent-result-calls",
      pass:
        observation.getSubagentResultCalls >=
        evalCase.expected.requiredGetResultCalls,
      detail: `expected get_subagent_result calls >= ${evalCase.expected.requiredGetResultCalls}, observed=${observation.getSubagentResultCalls}`,
      weight: CHECK_WEIGHTS.backgroundRetrieval,
      hardGate: false,
      dimension: "coordination",
    });
  }

  if (evalCase.expected.requireAllBackgroundResultsRetrieved) {
    const unretrieved = observation.subagentRuns.filter(
      (run) => run.runInBackground && !run.retrieved,
    );
    checks.push({
      name: "all-background-results-retrieved",
      pass: unretrieved.length === 0,
      detail: `unretrieved background runs=${unretrieved.length}`,
      weight: CHECK_WEIGHTS.backgroundRetrieval,
      hardGate: false,
      dimension: "coordination",
    });
  }

  if (evalCase.expected.requireCompletedSubagentResults) {
    const incomplete = observation.subagentRuns.filter((run) => !run.completed);
    checks.push({
      name: "completed-subagent-results",
      pass: incomplete.length === 0 && observation.subagentRuns.length > 0,
      detail: `completed=${observation.completedSubagentRuns}, total=${observation.subagentRuns.length}`,
      weight: CHECK_WEIGHTS.completedSubagents,
      hardGate: false,
      dimension: "execution",
    });
  }

  checks.push({
    name: "final-answer-present",
    pass: observation.finalAnswer.trim().length > 0,
    detail: `final answer length=${observation.finalAnswer.trim().length}`,
    weight: CHECK_WEIGHTS.finalAnswer,
    hardGate: true,
    dimension: "execution",
  });

  checks.push({
    name: "process-exit",
    pass: observation.exitCode === 0,
    detail: `exitCode=${observation.exitCode}${observation.stderr ? ` stderr=${observation.stderr.slice(0, 160)}` : ""}`,
    weight: CHECK_WEIGHTS.processExit,
    hardGate: true,
    dimension: "execution",
  });

  return checks;
}

export function scoreCase(
  evalCase: EvalCase,
  observation: EvalObservation,
): EvalScore {
  const checks = buildChecks(evalCase, observation);
  const dimensions = createEmptyDimensions();

  for (const check of checks) {
    dimensions[check.dimension].max += check.weight;
    if (check.pass) {
      dimensions[check.dimension].earned += check.weight;
    }
  }

  const scoreMax = checks.reduce((sum, check) => sum + check.weight, 0);
  const scoreEarned = checks.reduce(
    (sum, check) => sum + (check.pass ? check.weight : 0),
    0,
  );
  const hardGateFailures = checks
    .filter((check) => check.hardGate && !check.pass)
    .map((check) => check.name);

  return {
    pass: hardGateFailures.length === 0,
    allChecksPass: checks.every((check) => check.pass),
    scoreEarned: roundMetric(scoreEarned),
    scoreMax: roundMetric(scoreMax),
    percentage: roundMetric(scoreMax > 0 ? (scoreEarned / scoreMax) * 100 : 0),
    hardGateFailures,
    dimensions: roundDimensions(dimensions),
    checks,
  };
}

async function runEvalCase(
  evalCase: EvalCase,
  repo: EvalRepo,
  repoDir: string,
  resultsDir: string,
): Promise<EvalResult> {
  const caseResultDir = path.join(resultsDir, evalCase.id);
  fs.mkdirSync(caseResultDir, { recursive: true });
  const rawEventsPath = path.join(caseResultDir, "events.jsonl");

  const run = await runCommand(
    "pi",
    [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--extension",
      EXTENSION_PATH,
      resolvePromptTemplate(evalCase.prompt),
    ],
    {
      cwd: repoDir,
      timeoutSeconds: evalCase.timeoutSeconds ?? 300,
      env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
    },
  );

  fs.writeFileSync(rawEventsPath, run.stdout, "utf8");
  fs.writeFileSync(path.join(caseResultDir, "stderr.txt"), run.stderr, "utf8");
  fs.writeFileSync(
    path.join(caseResultDir, "case.json"),
    JSON.stringify(evalCase, null, 2),
    "utf8",
  );

  const observation = parseObservation(
    run.stdout,
    run.stderr,
    run.exitCode,
    rawEventsPath,
    resolvePromptTemplate(evalCase.prompt),
  );
  const score = scoreCase(evalCase, observation);

  const result: EvalResult = {
    caseId: evalCase.id,
    repoId: repo.id,
    repoDir,
    observation,
    score,
  };

  fs.writeFileSync(
    path.join(caseResultDir, "result.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );

  return result;
}

async function runWithConcurrency<T>(
  jobs: number,
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
) {
  const concurrency = Math.max(1, Math.min(jobs, items.length || 1));
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) return;
        await worker(items[currentIndex], currentIndex);
      }
    }),
  );
}

function formatScoreNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(1).replace(/\.0$/, "");
}

function formatDimensionSummary(score: EvalScore): string {
  return DIMENSION_ORDER.filter(
    (dimension) => score.dimensions[dimension].max > 0,
  )
    .map((dimension) => {
      const dimensionScore = score.dimensions[dimension];
      return `${dimension}=${formatScoreNumber(dimensionScore.earned)}/${formatScoreNumber(dimensionScore.max)}`;
    })
    .join(" ");
}

function buildRunSummary(
  results: EvalResult[],
  runResultsDir: string,
): RunSummary {
  const dimensions = createEmptyDimensions();

  for (const result of results) {
    for (const dimension of DIMENSION_ORDER) {
      dimensions[dimension].earned += result.score.dimensions[dimension].earned;
      dimensions[dimension].max += result.score.dimensions[dimension].max;
    }
  }

  const suiteEarned = results.reduce(
    (sum, result) => sum + result.score.scoreEarned,
    0,
  );
  const suiteMax = results.reduce(
    (sum, result) => sum + result.score.scoreMax,
    0,
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runId: path.basename(runResultsDir),
    runDir: runResultsDir,
    caseCount: results.length,
    passed: results.filter((result) => result.score.pass).length,
    perfect: results.filter((result) => result.score.allChecksPass).length,
    suiteEarned: roundMetric(suiteEarned),
    suiteMax: roundMetric(suiteMax),
    suitePercentage: roundMetric(
      suiteMax > 0 ? (suiteEarned / suiteMax) * 100 : 0,
    ),
    dimensions: roundDimensions(dimensions),
    repos: unique(results.map((result) => result.repoId)),
    cases: results.map((result) => ({
      caseId: result.caseId,
      repoId: result.repoId,
      pass: result.score.pass,
      allChecksPass: result.score.allChecksPass,
      scoreEarned: result.score.scoreEarned,
      scoreMax: result.score.scoreMax,
      percentage: result.score.percentage,
      delegated: result.observation.subagentCalls > 0,
      attemptedSubagentCalls: result.observation.attemptedSubagentCalls,
      subagentCalls: result.observation.subagentCalls,
      backgroundSubagentCalls: result.observation.backgroundSubagentCalls,
      getSubagentResultCalls: result.observation.getSubagentResultCalls,
      completedSubagentRuns: result.observation.completedSubagentRuns,
      agentsUsed: result.observation.agentsUsed,
      postDelegationValidation: result.observation.postDelegationValidation,
      delegatedPlanningCount: result.observation.delegatedPlanningCount,
      hardGateFailures: result.score.hardGateFailures,
      failedChecks: result.score.checks
        .filter((check) => !check.pass)
        .map((check) => check.name),
      dimensions: result.score.dimensions,
      rawEventsPath: result.observation.rawEventsPath,
    })),
  };
}

function formatDimensionTotalsMarkdown(summary: RunSummary): string[] {
  const lines = [
    "| Dimension | Earned | Max | % |",
    "| --- | ---: | ---: | ---: |",
  ];

  for (const dimension of DIMENSION_ORDER) {
    const dimensionScore = summary.dimensions[dimension];
    if (dimensionScore.max <= 0) continue;
    const percentage = (dimensionScore.earned / dimensionScore.max) * 100;
    lines.push(
      `| ${dimension} | ${formatScoreNumber(dimensionScore.earned)} | ${formatScoreNumber(dimensionScore.max)} | ${formatScoreNumber(percentage)}% |`,
    );
  }

  return lines;
}

function formatCaseTableMarkdown(summary: RunSummary): string[] {
  const lines = [
    "| Case | Repo | Pass | Perfect | Score | Successful/attempted | Background/results | Agents | Failed checks |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |",
  ];

  for (const result of summary.cases) {
    lines.push(
      `| ${result.caseId} | ${result.repoId} | ${result.pass ? "yes" : "no"} | ${result.allChecksPass ? "yes" : "no"} | ${formatScoreNumber(result.percentage)}% | ${result.subagentCalls}/${result.attemptedSubagentCalls} | ${result.backgroundSubagentCalls}/${result.getSubagentResultCalls} | ${result.agentsUsed.join(", ") || "-"} | ${result.failedChecks.join(", ") || "-"} |`,
    );
  }

  return lines;
}

function buildSummaryMarkdown(summary: RunSummary): string {
  const lines = [
    "# Orchestration eval run summary",
    "",
    `- Run: \`${summary.runId}\``,
    `- Generated: ${summary.generatedAt}`,
    `- Cases: ${summary.caseCount}`,
    `- Hard-gate passed: ${summary.passed}/${summary.caseCount}`,
    `- Perfect cases: ${summary.perfect}/${summary.caseCount}`,
    `- Suite score: ${formatScoreNumber(summary.suiteEarned)}/${formatScoreNumber(summary.suiteMax)} (${formatScoreNumber(summary.suitePercentage)}%)`,
    `- Repos: ${summary.repos.join(", ")}`,
    "",
    "## Dimension totals",
    "",
    ...formatDimensionTotalsMarkdown(summary),
    "",
    "## Case summary",
    "",
    ...formatCaseTableMarkdown(summary),
    "",
  ];

  return lines.join("\n");
}

function writeSummaryArtifacts(
  summary: RunSummary,
  resultsDir: string,
): SummaryArtifactPaths {
  const runSummaryJsonPath = path.join(summary.runDir, "summary.json");
  const runSummaryMarkdownPath = path.join(summary.runDir, "summary.md");
  const latestSummaryJsonPath = path.join(resultsDir, "latest-summary.json");
  const latestSummaryMarkdownPath = path.join(resultsDir, "latest-summary.md");
  const historyJsonlPath = path.join(resultsDir, "history.jsonl");
  const summaryMarkdown = buildSummaryMarkdown(summary);

  fs.writeFileSync(
    runSummaryJsonPath,
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  fs.writeFileSync(runSummaryMarkdownPath, summaryMarkdown, "utf8");
  fs.writeFileSync(
    latestSummaryJsonPath,
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  fs.writeFileSync(latestSummaryMarkdownPath, summaryMarkdown, "utf8");
  fs.appendFileSync(
    historyJsonlPath,
    `${JSON.stringify({
      schemaVersion: summary.schemaVersion,
      generatedAt: summary.generatedAt,
      runId: summary.runId,
      runDir: summary.runDir,
      caseCount: summary.caseCount,
      passed: summary.passed,
      perfect: summary.perfect,
      suiteEarned: summary.suiteEarned,
      suiteMax: summary.suiteMax,
      suitePercentage: summary.suitePercentage,
      repos: summary.repos,
    })}\n`,
  );

  return {
    runSummaryJsonPath,
    runSummaryMarkdownPath,
    latestSummaryJsonPath,
    latestSummaryMarkdownPath,
    historyJsonlPath,
  };
}

function printCaseList() {
  console.log("Available orchestration eval cases:\n");
  for (const evalCase of cases) {
    console.log(`- ${evalCase.id} (${evalCase.repoId})`);
    console.log(`  prompt: ${evalCase.prompt}`);
    if (evalCase.notes) console.log(`  notes: ${evalCase.notes}`);
    console.log("");
  }
}

function printSummary(
  results: EvalResult[],
  summary: RunSummary,
  artifactPaths: SummaryArtifactPaths,
) {
  const lines = [
    "",
    "Orchestration eval summary",
    "==========================",
    "",
  ];

  for (const result of results) {
    lines.push(
      `${result.score.pass ? "PASS" : "FAIL"} ${result.caseId} (${result.repoId}) score=${formatScoreNumber(result.score.scoreEarned)}/${formatScoreNumber(result.score.scoreMax)} (${formatScoreNumber(result.score.percentage)}%) allChecksPass=${result.score.allChecksPass}`,
    );
    lines.push(
      `  delegated=${result.observation.subagentCalls > 0} successfulSubagentRuns=${result.observation.subagentCalls} attemptedSubagentCalls=${result.observation.attemptedSubagentCalls} background=${result.observation.backgroundSubagentCalls} getResults=${result.observation.getSubagentResultCalls} agents=${result.observation.agentsUsed.join(", ") || "none"} postDelegationValidation=${result.observation.postDelegationValidation} delegatedPlanning=${result.observation.delegatedPlanningCount}`,
    );
    lines.push(`  dimensions: ${formatDimensionSummary(result.score)}`);
    lines.push(
      `  hard gates: ${result.score.hardGateFailures.length ? result.score.hardGateFailures.join(", ") : "none"}`,
    );
    for (const check of result.score.checks) {
      lines.push(
        `  - ${check.pass ? "ok" : "xx"} [${check.hardGate ? "gate" : "soft"}] ${check.name} (${formatScoreNumber(check.weight)}): ${check.detail}`,
      );
    }
    lines.push(`  raw events: ${result.observation.rawEventsPath}`);
    lines.push("");
  }

  lines.push(`Hard-gate passed ${summary.passed}/${summary.caseCount} cases.`);
  lines.push(`Perfect cases ${summary.perfect}/${summary.caseCount}.`);
  lines.push(
    `Suite score ${formatScoreNumber(summary.suiteEarned)}/${formatScoreNumber(summary.suiteMax)} (${formatScoreNumber(summary.suitePercentage)}%).`,
  );
  lines.push(`Run summary JSON: ${artifactPaths.runSummaryJsonPath}`);
  lines.push(`Run summary Markdown: ${artifactPaths.runSummaryMarkdownPath}`);
  lines.push(`Latest summary JSON: ${artifactPaths.latestSummaryJsonPath}`);
  lines.push(
    `Latest summary Markdown: ${artifactPaths.latestSummaryMarkdownPath}`,
  );
  lines.push(`History JSONL: ${artifactPaths.historyJsonlPath}`);
  lines.push(`Results dir: ${summary.runDir}`);

  console.log(lines.join("\n"));
}

async function main() {
  const { selectedCaseIds, baseDir, resultsDir, jobs, listOnly, strictSoft } =
    parseArgs(process.argv.slice(2));

  if (listOnly) {
    printCaseList();
    return;
  }

  const selectedCases =
    selectedCaseIds.size === 0
      ? cases
      : cases.filter((evalCase) => selectedCaseIds.has(evalCase.id));

  if (selectedCases.length === 0) {
    console.error(
      "No eval cases selected. Use --list to inspect available cases.",
    );
    process.exit(1);
  }

  if (!fs.existsSync(EXTENSION_PATH)) {
    throw new Error(`Subagents extension not found at ${EXTENSION_PATH}`);
  }

  prepareEvalAgentDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runResultsDir = path.join(resultsDir, timestamp);
  fs.mkdirSync(runResultsDir, { recursive: true });

  const reposToPrepare = repos.filter((repo) =>
    selectedCases.some((evalCase) => evalCase.repoId === repo.id),
  );
  const repoDirs = new Map<string, string>();

  await runWithConcurrency(
    Math.min(jobs, reposToPrepare.length || 1),
    reposToPrepare,
    async (repo) => {
      console.log(`Preparing repo ${repo.id} @ ${repo.commit}...`);
      repoDirs.set(repo.id, await ensureRepo(repo, baseDir));
    },
  );

  console.log(
    `Running ${selectedCases.length} case(s) with ${Math.min(jobs, selectedCases.length)} worker(s)...`,
  );

  const results = new Array<EvalResult>(selectedCases.length);
  await runWithConcurrency(jobs, selectedCases, async (evalCase, index) => {
    const repo = repos.find((candidate) => candidate.id === evalCase.repoId);
    const repoDir = repo && repoDirs.get(repo.id);
    if (!repo || !repoDir) {
      throw new Error(`Missing prepared repo for case ${evalCase.id}.`);
    }

    console.log(`Running ${evalCase.id} in ${repo.id}...`);
    results[index] = await runEvalCase(evalCase, repo, repoDir, runResultsDir);
  });

  const summary = buildRunSummary(results, runResultsDir);
  const artifactPaths = writeSummaryArtifacts(summary, resultsDir);
  printSummary(results, summary, artifactPaths);

  const hardGateFailed = results.some((result) => !result.score.pass);
  const softFailed = results.some((result) => !result.score.allChecksPass);

  if (!hardGateFailed && softFailed && !strictSoft) {
    console.log(
      "Soft-check failures were present. Re-run with --strict-soft (or PI_SUBAGENT_EVAL_STRICT_SOFT=1) to fail on non-perfect orchestration runs.",
    );
  }

  if (hardGateFailed || (strictSoft && softFailed)) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
