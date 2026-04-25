export interface EvalRepo {
  id: string;
  url: string;
  commit: string;
  checkoutDirName: string;
  description: string;
}

export interface EvalCase {
  id: string;
  repoId: string;
  prompt: string;
  timeoutSeconds?: number;
  expected: {
    shouldDelegate: boolean;
    requiredAgents?: string[];
    forbiddenAgents?: string[];
    minSubagentCalls?: number;
    minBackgroundSubagentCalls?: number;
    requiredGetResultCalls?: number;
    requireAllBackgroundResultsRetrieved?: boolean;
    requireCompletedSubagentResults?: boolean;
    maxPostDelegationValidation?: number;
    shouldKeepPlanningInMainThread?: boolean;
  };
  notes?: string;
}

export const repos: EvalRepo[] = [
  {
    id: "fastapi",
    url: "https://github.com/fastapi/fastapi.git",
    commit: "eba8942c81dbf990d25fbae34e6601bdbc21e74b",
    checkoutDirName: "fastapi-eba8942",
    description: "Medium-sized Python web framework repository.",
  },
  {
    id: "nextjs",
    url: "https://github.com/vercel/next.js.git",
    commit: "8e5a36f6347528d8968da97262f372f908897bac",
    checkoutDirName: "nextjs-8e5a36f",
    description: "Large TypeScript/JavaScript framework repository.",
  },
];

export const cases: EvalCase[] = [
  {
    id: "fastapi-explore-main-plan",
    repoId: "fastapi",
    prompt:
      "Understand how dependency injection and request handling are structured in this repository, then propose a concise plan for adding a new cross-cutting authentication dependency safely.",
    timeoutSeconds: 420,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["explore"],
      maxPostDelegationValidation: 2,
      shouldKeepPlanningInMainThread: true,
    },
    notes:
      "Should offload repository exploration, then synthesize the plan in the main thread rather than delegating planning.",
  },
  {
    id: "fastapi-research-explore",
    repoId: "fastapi",
    prompt:
      "What are current best practices for structuring dependency injection layers in Python web frameworks, and how does this repository seem to organize that kind of logic? Recommend an approach the maintainers would likely accept.",
    timeoutSeconds: 480,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["research", "explore"],
      maxPostDelegationValidation: 3,
      shouldKeepPlanningInMainThread: true,
    },
    notes:
      "Should combine external best-practice research with repository exploration, then synthesize in the main thread.",
  },
  {
    id: "fastapi-no-delegate-single-file",
    repoId: "fastapi",
    prompt:
      "Read the root pyproject.toml file and tell me the declared Python version range for this repository. Keep it brief.",
    timeoutSeconds: 180,
    expected: {
      shouldDelegate: false,
      forbiddenAgents: [
        "explore",
        "research",
        "review",
        "multimodal",
        "general",
      ],
    },
    notes:
      "Simple single-file lookup. Good check against unnecessary delegation.",
  },
  {
    id: "fastapi-review-second-opinion",
    repoId: "fastapi",
    prompt:
      "I think FastAPI's dependency-injection machinery is mostly isolated under dedicated dependency modules and not spread across the routing layer. Give me an independent skeptical second opinion on that claim. Look for counterexamples or important exceptions before agreeing.",
    timeoutSeconds: 420,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["review"],
      maxPostDelegationValidation: 2,
    },
    notes:
      "Explicit second-opinion task. Should prefer the review agent instead of direct main-thread checking.",
  },
  {
    id: "nextjs-fanout-explore-main-plan",
    repoId: "nextjs",
    prompt:
      "Map where routing, middleware, and server rendering boundaries are implemented in the Next.js source tree, then propose a framework-level investigation plan for adding auth-aware route protection primitives. This is broad exploratory work.",
    timeoutSeconds: 900,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["explore"],
      maxPostDelegationValidation: 3,
      shouldKeepPlanningInMainThread: true,
    },
    notes:
      "Large framework repo and broad exploration task. One strong explore run is acceptable, though multiple focused runs may also be reasonable.",
  },
  {
    id: "nextjs-implicit-fanout-explore-main-plan",
    repoId: "nextjs",
    prompt:
      "Understand how a request moves through three major Next.js framework areas: route matching / route tree resolution, middleware interception, and server rendering entrypoints. Map the main code paths for each area and where they connect, then propose a framework-level investigation plan for adding auth-aware route protection primitives that would need to interact with all three. This is broad exploratory work in a large source repository.",
    timeoutSeconds: 900,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["explore"],
      minSubagentCalls: 2,
      maxPostDelegationValidation: 3,
      shouldKeepPlanningInMainThread: true,
    },
    notes:
      "Intermediate fanout case. The prompt does not explicitly tell the agent to split work, but the task naturally spans multiple largely independent framework subsystems, so failing to fan out should count against orchestration quality.",
  },
  {
    id: "nextjs-strong-fanout-explore-main-plan",
    repoId: "nextjs",
    prompt:
      "This is broad exploratory work across three fairly independent Next.js subsystems. Map (1) route matching and route tree construction, (2) middleware / request interception boundaries, and (3) server rendering and request-context boundaries in the Next.js source tree. Then propose a framework-level investigation plan for auth-aware route protection primitives that would need to interact with all three areas. Keep planning in the main thread, but split the exploration into separate focused subagent runs rather than one monolithic search.",
    timeoutSeconds: 900,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["explore"],
      minSubagentCalls: 3,
      maxPostDelegationValidation: 3,
      shouldKeepPlanningInMainThread: true,
    },
    notes:
      "This is the stricter fanout stress case: the prompt names three independent exploration threads and explicitly asks for split focused subagent runs before main-thread synthesis.",
  },
  {
    id: "nextjs-background-fanout-retrieve",
    repoId: "nextjs",
    prompt:
      "Run two independent background exploration subagents before answering: one should map route matching / route tree resolution, and one should map middleware interception boundaries. Retrieve both background results with get_subagent_result using wait=true, then synthesize a concise comparison of where those two areas connect. Do not do broad main-thread searching before the subagents finish.",
    timeoutSeconds: 900,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["explore"],
      minSubagentCalls: 2,
      minBackgroundSubagentCalls: 2,
      requiredGetResultCalls: 2,
      requireAllBackgroundResultsRetrieved: true,
      requireCompletedSubagentResults: true,
      maxPostDelegationValidation: 3,
      shouldKeepPlanningInMainThread: true,
    },
    notes:
      "Exercises in-process background fanout plus explicit get_subagent_result retrieval before synthesis.",
  },
  {
    id: "nextjs-research-explore-main-plan",
    repoId: "nextjs",
    prompt:
      "Research how modern web frameworks expose route-protection and auth-boundary primitives, then inspect how the Next.js source tree is organized around routing, middleware, and rendering so you can recommend a framework-level design direction that would fit this repository.",
    timeoutSeconds: 720,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["research", "explore"],
      maxPostDelegationValidation: 4,
      shouldKeepPlanningInMainThread: true,
    },
    notes:
      "Should trigger both external research and framework-source exploration; final recommendation can stay in the main thread.",
  },
  {
    id: "nextjs-no-delegate-single-file",
    repoId: "nextjs",
    prompt:
      "Read the root package.json and tell me the package manager field and one sign that this repository uses workspaces. Keep it brief.",
    timeoutSeconds: 180,
    expected: {
      shouldDelegate: false,
      forbiddenAgents: [
        "explore",
        "research",
        "review",
        "multimodal",
        "general",
      ],
    },
    notes:
      "Simple root-file lookup. Another check against over-delegation in a large repo.",
  },
  {
    id: "nextjs-multimodal-local-image",
    repoId: "nextjs",
    prompt:
      "Inspect the image at {{DOTFILES_ROOT}}/.config/tmux/plugins/tmux/assets/config1.png and briefly describe what kind of interface or configuration screenshot it appears to show. Keep the answer concise.",
    timeoutSeconds: 240,
    expected: {
      shouldDelegate: true,
      requiredAgents: ["multimodal"],
      maxPostDelegationValidation: 1,
    },
    notes:
      "Image-inspection task using a stable local asset from this repo. Should exercise the multimodal agent rather than direct main-thread inspection.",
  },
];
