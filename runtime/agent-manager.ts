import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SubagentConfig } from "../agents.js";
import { runAgentInProcess } from "./agent-runner.js";
import type { AgentActivity, AgentRecord } from "./types.js";

function makeId(): string {
  return `ag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function compactJson(value: unknown, max = 90): string {
  const text = JSON.stringify(value) || "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatToolActivity(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "bash" && typeof args.command === "string") {
    return `bash ${args.command}`;
  }
  if (toolName === "read" && typeof args.path === "string") {
    return `read ${args.path}`;
  }
  if (
    (toolName === "grep" || toolName === "find") &&
    typeof args.pattern === "string"
  ) {
    const where = typeof args.path === "string" ? ` in ${args.path}` : "";
    return `${toolName} ${args.pattern}${where}`;
  }
  if (toolName === "ls" && typeof args.path === "string") {
    return `ls ${args.path}`;
  }
  if (
    (toolName === "webfetch" || toolName === "websearch") &&
    typeof args.url === "string"
  ) {
    return `${toolName} ${args.url}`;
  }
  if (toolName === "websearch" && typeof args.query === "string") {
    return `websearch ${args.query}`;
  }
  return `${toolName} ${compactJson(args)}`;
}

export interface AgentManagerOptions {
  maxConcurrent?: number;
  activity: Map<string, AgentActivity>;
  onUpdate?: () => void;
  onComplete?: (record: AgentRecord) => void;
}

interface SpawnInput {
  ctx: ExtensionContext;
  agent: SubagentConfig;
  task: string;
  cwd: string;
  description?: string;
  runInBackground: boolean;
  signal?: AbortSignal;
}

interface QueuedRun {
  record: AgentRecord;
  input: SpawnInput;
}

export class AgentManager {
  private records = new Map<string, AgentRecord>();
  private queue: QueuedRun[] = [];
  private runningBackground = 0;
  private maxConcurrent: number;
  private maxCompletedRecords = 50;
  private nextCompletedSequence = 0;
  private options: AgentManagerOptions;

  constructor(options: AgentManagerOptions) {
    this.options = options;
    this.maxConcurrent = options.maxConcurrent || 4;
  }

  listAgents(): AgentRecord[] {
    return [...this.records.values()].sort(
      (a, b) => (b.startedAt || 0) - (a.startedAt || 0),
    );
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.records.get(id);
  }

  spawn(input: SpawnInput): AgentRecord {
    const record = this.createRecord(input);
    this.records.set(record.id, record);
    this.abortQueuedWhenParentAborts(record, input.signal);
    if (record.status === "aborted") return record;
    if (this.runningBackground >= this.maxConcurrent) {
      record.status = "queued";
      this.queue.push({ record, input });
      this.options.onUpdate?.();
      return record;
    }
    this.start(record, input);
    return record;
  }

  async spawnAndWait(input: SpawnInput): Promise<AgentRecord> {
    const record = this.createRecord({ ...input, runInBackground: false });
    this.records.set(record.id, record);
    this.abortQueuedWhenParentAborts(record, input.signal);
    if (record.status !== "aborted") {
      this.start(record, { ...input, runInBackground: false });
    }
    try {
      await record.promise;
    } catch {
      // record already captures the error
    }
    return record;
  }

  abort(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    record.abortController.abort();
    this.queue = this.queue.filter((queued) => queued.record.id !== id);
    this.markAborted(record);
    this.options.activity.delete(id);
    this.options.onUpdate?.();
    return true;
  }

  abortAll() {
    for (const record of this.records.values()) {
      if (record.status === "running" || record.status === "queued") {
        record.abortController.abort();
        this.markAborted(record);
      }
    }
    this.queue = [];
    this.options.activity.clear();
    this.options.onUpdate?.();
  }

  clearCompleted() {
    for (const [id, record] of this.records) {
      if (record.status !== "running" && record.status !== "queued") {
        record.session?.dispose?.();
        this.records.delete(id);
        this.options.activity.delete(id);
      }
    }
    this.options.onUpdate?.();
  }

  private abortQueuedWhenParentAborts(
    record: AgentRecord,
    signal: AbortSignal | undefined,
  ) {
    if (!signal) return;
    const abortIfQueued = () => {
      if (record.status === "queued") this.abort(record.id);
    };
    if (signal.aborted) abortIfQueued();
    else signal.addEventListener("abort", abortIfQueued, { once: true });
  }

  private markAborted(record: AgentRecord) {
    record.status = "aborted";
    record.stopReason = "aborted";
    record.error ||= "Subagent was aborted.";
    record.completedAt = Date.now();
    record.completedSequence = ++this.nextCompletedSequence;
    record.completionResolve?.(record.result || "");
  }

  private createRecord(input: SpawnInput): AgentRecord {
    const abortController = new AbortController();
    if (input.signal) {
      input.signal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });
    }

    let completionResolve: (value: string) => void = () => {};
    const promise = new Promise<string>((resolve) => {
      completionResolve = resolve;
    });

    return {
      id: makeId(),
      agent: input.agent,
      task: input.task,
      cwd: input.cwd,
      description: input.description,
      status: "queued",
      runInBackground: input.runInBackground,
      abortController,
      promise,
      completionResolve,
      toolUses: 0,
      model: input.agent.model,
      thinking: input.agent.thinking,
    };
  }

  private start(record: AgentRecord, input: SpawnInput) {
    record.status = "running";
    record.startedAt = Date.now();
    if (record.runInBackground) this.runningBackground++;

    this.options.activity.set(record.id, {
      id: record.id,
      agentName: record.agent.name,
      toolUses: 0,
      startedAt: record.startedAt,
      updatedAt: record.startedAt,
    });
    this.options.onUpdate?.();

    void runAgentInProcess(
      input.ctx,
      input.agent,
      {
        task: input.task,
        cwd: input.cwd,
        signal: record.abortController.signal,
      },
      {
        onSessionCreated: (session) => {
          record.session = session;
        },
        onToolActivity: (toolName, args) => {
          record.toolUses++;
          const activity = this.options.activity.get(record.id);
          if (activity) {
            activity.toolUses = record.toolUses;
            activity.activeTool = formatToolActivity(toolName, args);
            activity.updatedAt = Date.now();
          }
          this.options.onUpdate?.();
        },
        onTextUpdate: (text) => {
          const activity = this.options.activity.get(record.id);
          if (activity) {
            activity.latestText = text
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 160);
            activity.updatedAt = Date.now();
          }
          this.options.onUpdate?.();
        },
      },
    )
      .then((output) => {
        record.result = output.result;
        record.model = output.model;
        record.thinking = output.thinking;
        record.stopReason = output.stopReason;
        record.error = output.errorMessage;
        record.status = "completed";
        record.completionResolve?.(output.result);
      })
      .catch((error) => {
        const stopReason =
          typeof (error as { stopReason?: unknown }).stopReason === "string"
            ? String((error as { stopReason?: unknown }).stopReason)
            : record.abortController.signal.aborted
              ? "aborted"
              : "error";
        record.error = error instanceof Error ? error.message : String(error);
        record.stopReason = stopReason;
        record.status = stopReason === "aborted" ? "aborted" : "error";
        record.completionResolve?.("");
      })
      .finally(() => {
        record.completedAt = Date.now();
        record.completedSequence = ++this.nextCompletedSequence;
        if (record.runInBackground)
          this.runningBackground = Math.max(0, this.runningBackground - 1);
        this.options.activity.delete(record.id);
        this.options.onComplete?.(record);
        this.pruneCompleted();
        this.options.onUpdate?.();
        this.drainQueue();
      });
  }

  private pruneCompleted() {
    const completed = [...this.records.values()]
      .filter(
        (record) => record.status !== "running" && record.status !== "queued",
      )
      .sort(
        (a, b) =>
          (b.completedAt || 0) - (a.completedAt || 0) ||
          (b.completedSequence || 0) - (a.completedSequence || 0),
      );
    for (const record of completed.slice(this.maxCompletedRecords)) {
      record.session?.dispose?.();
      this.records.delete(record.id);
      this.options.activity.delete(record.id);
    }
  }

  private drainQueue() {
    while (
      this.runningBackground < this.maxConcurrent &&
      this.queue.length > 0
    ) {
      const queued = this.queue.shift()!;
      if (queued.record.abortController.signal.aborted) {
        this.markAborted(queued.record);
        continue;
      }
      this.start(queued.record, queued.input);
    }
  }
}
