/**
 * Model router for claude-bridge: picks Haiku, Sonnet, Opus or Fable plus a
 * thinking level for a task, following Anthropic's model selection guidance.
 *
 * Registers the virtual model `claude-bridge/auto`, which picks a model on the
 * first prompt of a session and stays on it. With a physical claude-bridge
 * model selected, the first prompt instead offers a switch before the first
 * request, when the switch is free. `/model-advice` gives the same advice on
 * demand. See model-router-plan.md.
 *
 * Config: ~/.pi/agent/model-router.json
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

const PROVIDER = "claude-bridge";
const AUTO_ID = "auto";
// VIRTUAL_MODEL_API in core/virtual-models.ts, not exported from the package index.
const VIRTUAL_API = "pi-virtual";
const FAMILIES = ["haiku", "sonnet", "opus", "fable"] as const;
const LEVELS = ["low", "medium", "high"] as const;
const PROMPT_MAX_CHARS = 4000;
const CONFIG_PATH = join(getAgentDir(), "model-router.json");
const STATUS_KEY = "model-router";

type Family = (typeof FAMILIES)[number];
type Level = (typeof LEVELS)[number];

interface RouterConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  allowFable: boolean;
}

/** Router state of `claude-bridge/auto`, stored on the session branch. */
interface AutoState {
  modelId: string;
  level: Level;
  // reason and source are not read back; they explain the pick in the session file.
  reason: string;
  source: "model" | "fallback" | "kept";
}

interface Suggestion {
  family: Family;
  model: Model<any>;
  level: Level;
  reason: string;
  source: "model" | "fallback";
  /** Why the side model was not used, when source is "fallback". */
  error?: string;
  ms: number;
}

const DEFAULT_CONFIG: RouterConfig = {
  enabled: true,
  model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
  timeoutMs: 4000,
  allowFable: true,
};

// Distilled from Anthropic's "Choosing the right model" page and the Claude Code
// model-config docs (sources in model-router-plan.md).
const RUBRIC: Record<Family, string> = {
  haiku:
    "Simple, well-scoped tasks where speed matters: quick questions, lookups, explaining a " +
    "small snippet, renames, typo or formatting fixes, small one-file edits, summaries, " +
    "commit messages, repetitive work whose result is easy to check.",
  sonnet:
    "Everyday coding with a clear scope: implementing a feature, writing tests, fixing a bug " +
    "in a known area, code review, docs, data analysis, scripted tool use. Use 'high' when " +
    "verification matters or edge cases are likely (bug fixes in existing code).",
  opus:
    "Complex reasoning and agentic coding: multi-file or cross-module refactors, systems " +
    "engineering, debugging that spans several subsystems, designs with real tradeoffs, " +
    "long autonomous runs, unfamiliar large codebases.",
  fable:
    "Only the hardest, longest work: tasks larger than one sitting, ambiguous root-cause or " +
    "outage investigations, architecture decisions, multistep deep research ending in a " +
    "finished document. Billed to pay-as-you-go usage credits on this plan, so pick it only " +
    "when Opus at high effort would likely fall short.",
};

// The thinking level selected on `auto` is a budget: the families it may pick.
const BUDGET: Record<Level, readonly Family[]> = {
  low: ["haiku", "sonnet"],
  medium: ["haiku", "sonnet", "opus"],
  high: FAMILIES,
};

const LEVEL_GUIDE =
  "Thinking levels: 'low' for quick exchanges and trivial edits, 'medium' (the default) for " +
  "day-to-day work with a clear scope, 'high' when verification matters, edge cases are " +
  "likely, or the problem is hard. Anthropic notes that tuning effort is often a better " +
  "lever than switching models, so prefer a smaller model at a higher level over a larger " +
  "model when both would do.";

// Scored word lists for when the side model is unavailable. Never suggests Fable.
const KEYWORDS: Record<Exclude<Family, "fable">, RegExp[]> = {
  haiku: [
    /\b(what is|what's|what does|how do i|explain|summari[sz]e|list|show me|where is)\b/i,
    /\b(rename|typo|format|reword|translate|commit message|one-liner)\b/i,
  ],
  sonnet: [
    /\b(implement|add|write|create|build|test|fix|bug|update|review|document)\b/i,
    /\b(script|function|endpoint|component|feature)\b/i,
  ],
  opus: [
    /\b(refactor|architecture|architect|redesign|migrate|migration|design)\b/i,
    /\b(across|whole|entire|all (the )?(files|modules|services)|multi-?file|codebase)\b/i,
    /\b(root cause|investigate|race condition|deadlock|intermittent|performance)\b/i,
  ],
};

// =============================================================================
// Config and models
// =============================================================================

/** loadConfig for the router, which must not fail a request over a bad config file. */
function configOrDefaults(ctx: ExtensionContext): RouterConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (ctx.hasUI) ctx.ui.notify(`model-router: ${errorText(err)}, using defaults`, "warning");
    return DEFAULT_CONFIG;
  }
}

function loadConfig(): RouterConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw err;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }
  return { ...DEFAULT_CONFIG, ...(raw as Partial<RouterConfig>) };
}

/**
 * Newest claude-bridge model per family from the scoped models (enabledModels),
 * or from all available models when enabledModels lists none.
 */
function familyModels(ctx: ExtensionContext, config: RouterConfig): Map<Family, Model<any>> {
  const found = new Map<Family, Model<any>>();
  let candidates = ctx.scopedModels.map((scoped) => scoped.model).filter(isBridgeModel);
  if (candidates.length === 0) candidates = ctx.modelRegistry.getAvailable().filter(isBridgeModel);
  candidates.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  for (const model of candidates) {
    const family = FAMILIES.find((name) => model.id.includes(name));
    if (!family || found.has(family)) continue;
    if (family === "fable" && !config.allowFable) continue;
    found.set(family, model);
  }
  return found;
}

function sideModel(ctx: ExtensionContext, config: RouterConfig): Model<any> {
  const slash = config.model.indexOf("/");
  if (slash <= 0) throw new Error(`invalid model "${config.model}"`);
  const model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
  if (!model) throw new Error(`model ${config.model} not found`);
  // Side calls through claude-bridge would draw on the Claude quota.
  if (model.provider === PROVIDER) throw new Error(`side model must not use ${PROVIDER}`);
  return model;
}

/** Whether a model is a virtual catalog entry. Exported for claude-usage-band.ts. */
export function isVirtual(model: { api: string } | undefined): boolean {
  return model?.api === VIRTUAL_API;
}

function isBridgeModel(model: Model<any> | undefined): model is Model<any> {
  return model?.provider === PROVIDER && !isVirtual(model);
}

function clip(text: string): string {
  if (text.length <= PROMPT_MAX_CHARS) return text;
  const half = PROMPT_MAX_CHARS / 2;
  return `${text.slice(0, half)}\n[...]\n${text.slice(-half)}`;
}

// =============================================================================
// Suggestion
// =============================================================================

function systemPrompt(families: Family[]): string {
  const options = families.map((family) => `- ${family}: ${RUBRIC[family]}`).join("\n");
  return [
    "You pick which Claude model a coding agent should use for the task in the user's",
    "first message. Judge the size, ambiguity and risk of the task, not its wording.",
    "",
    "Options:",
    options,
    "",
    LEVEL_GUIDE,
    "",
    "Reply with only a JSON object, no prose, no code fence:",
    `{"family": one of ${JSON.stringify(families)}, "level": one of ${JSON.stringify(LEVELS)}, ` +
      `"reason": "under 12 words, names the deciding trait of the task"}`,
  ].join("\n");
}

function parseReply(text: string, families: Family[]): { family: Family; level: Level; reason: string } {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("reply had no JSON object");
  const data = JSON.parse(json) as Record<string, unknown>;
  const family = families.find((name) => name === data.family);
  const level = LEVELS.find((name) => name === data.level);
  if (!family) throw new Error(`invalid family ${JSON.stringify(data.family)}`);
  if (!level) throw new Error(`invalid level ${JSON.stringify(data.level)}`);
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  return { family, level, reason };
}

async function askModel(
  ctx: ExtensionContext,
  config: RouterConfig,
  prompt: string,
  families: Family[],
  signal?: AbortSignal,
): Promise<{ family: Family; level: Level; reason: string }> {
  const model = sideModel(ctx, config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw new Error("aborted");
    // No reasoning option: omitting it disables thinking on the APIs used here.
    const response = await ctx.modelRegistry
      .streamSimple(
        model,
        {
          systemPrompt: systemPrompt(families),
          messages: [{ role: "user", content: [{ type: "text", text: clip(prompt) }], timestamp: Date.now() }],
        },
        { signal: controller.signal, cacheRetention: "none", maxTokens: 200 },
      )
      .result();
    if (signal?.aborted) throw new Error("aborted");
    if (controller.signal.aborted) throw new Error(`timed out after ${config.timeoutMs} ms`);
    if (response.stopReason !== "stop") {
      throw new Error(response.errorMessage || `stopped with ${response.stopReason}`);
    }
    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    return parseReply(text, families);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function keywordFallback(prompt: string, families: Family[]): { family: Family; level: Level; reason: string } {
  let best: Family = families.includes("sonnet") ? "sonnet" : families[0]!;
  let bestScore = 0;
  for (const [family, patterns] of Object.entries(KEYWORDS) as [Family, RegExp[]][]) {
    if (!families.includes(family)) continue;
    const score = patterns.filter((pattern) => pattern.test(prompt)).length;
    if (score > bestScore) {
      best = family;
      bestScore = score;
    }
  }
  const level: Level = best === "haiku" ? "low" : best === "opus" ? "high" : "medium";
  return { family: best, level, reason: bestScore ? "keyword match" : "no strong signal, default" };
}

async function suggest(
  ctx: ExtensionContext,
  config: RouterConfig,
  prompt: string,
  allowed: readonly Family[] = FAMILIES,
  signal?: AbortSignal,
): Promise<Suggestion> {
  const models = familyModels(ctx, config);
  const available = FAMILIES.filter((family) => models.has(family));
  if (available.length === 0) throw new Error(`no ${PROVIDER} models available`);
  // FAMILIES runs smallest first: when the budget rules out every available family, take the smallest.
  const inBudget = available.filter((family) => allowed.includes(family));
  const families = inBudget.length > 0 ? inBudget : [available[0]!];

  const started = Date.now();
  let picked: { family: Family; level: Level; reason: string };
  let source: Suggestion["source"] = "model";
  let error: string | undefined;
  try {
    if (!prompt.trim()) throw new Error("empty prompt");
    picked = await askModel(ctx, config, prompt, families, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    picked = keywordFallback(prompt, families);
    source = "fallback";
    error = err instanceof Error ? err.message : String(err);
  }
  return { ...picked, model: models.get(picked.family)!, source, error, ms: Date.now() - started };
}

function modelName(model: Model<any>): string {
  return model.name ?? model.id;
}

function describe(suggestion: Suggestion): string {
  const credits = suggestion.family === "fable" ? " (usage credits)" : "";
  return `${modelName(suggestion.model)} · ${suggestion.level}${credits}: ${suggestion.reason}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function userPrompts(ctx: ExtensionContext): string[] {
  const prompts: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "user") {
      prompts.push(messageText(entry.message.content).trim());
    }
  }
  return prompts;
}

function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return messageText(message.content).trim();
  }
  return "";
}

function toLevel(level: string | undefined): Level {
  if (level === "off" || level === "minimal" || level === "low") return "low";
  if (level === "high" || level === "xhigh") return "high";
  return "medium";
}

/** Latest successful claude-bridge reply on the branch, for requests that carry no history. */
function lastBridgeReply(ctx: ExtensionContext): { model: Model<any>; thinkingLevel?: ModelThinkingLevel } | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const reply = entry.message;
    if (reply.provider !== PROVIDER || reply.stopReason === "error" || reply.stopReason === "aborted") continue;
    const model = ctx.modelRegistry.find(PROVIDER, reply.model);
    if (isBridgeModel(model)) return { model, thinkingLevel: reply.thinkingLevel };
  }
  return undefined;
}

/** Subagent children and sessions started with an explicit --model are left alone. */
function modelChosenElsewhere(): boolean {
  if (process.env.PI_SUBAGENT_ID) return true;
  return process.argv.some((arg) => arg === "--model" || arg.startsWith("--model="));
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
  function isCurrent(ctx: ExtensionContext, suggestion: Suggestion): boolean {
    return ctx.model?.id === suggestion.model.id && pi.getThinkingLevel() === suggestion.level;
  }

  function current(ctx: ExtensionContext): string {
    return `${ctx.model ? modelName(ctx.model) : "none"} · ${pi.getThinkingLevel()}`;
  }

  /** Asks whether to switch; returns true when the switch was made. */
  async function offer(ctx: ExtensionContext, suggestion: Suggestion, midSession: boolean): Promise<boolean> {
    const target = `${modelName(suggestion.model)} · ${suggestion.level}`;
    const switchLabel = `Switch to ${target}${midSession ? " (re-sends the history uncached)" : ""}`;
    const keepLabel = `Keep ${current(ctx)}`;
    const choice = await ctx.ui.select(`Model router: ${describe(suggestion)}`, [switchLabel, keepLabel]);
    if (choice !== switchLabel) {
      ctx.ui.setStatus(STATUS_KEY, `router: kept, suggested ${target}`);
      return false;
    }
    if (!(await pi.setModel(suggestion.model))) {
      ctx.ui.notify(`model-router: no credentials for ${suggestion.model.id}`, "error");
      return false;
    }
    // setModel resets the level to the model default, so set it afterwards.
    pi.setThinkingLevel(suggestion.level);
    ctx.ui.setStatus(STATUS_KEY, `router: switched to ${target}`);
    return true;
  }

  // Picks a model on the first prompt and stays on it: with claude-bridge every
  // model change imports the history into a fresh, uncached Claude Code session.
  pi.registerVirtualModel<AutoState>({
    provider: PROVIDER,
    id: AUTO_ID,
    name: "Auto",
    thinkingLevels: LEVELS,
    async route(request, ctx) {
      if (request.reason === "retry" && request.failed) {
        return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? "medium" };
      }
      if (request.reason === "direct") {
        // Compaction summaries and extension calls: no router state, so follow the bridge
        // model of the conversation. Callers that ask for no thinking (handoff) get none.
        const previous = isBridgeModel(request.previous?.model) ? request.previous : lastBridgeReply(ctx);
        const off = request.thinkingLevel === "off";
        if (previous) return { model: previous.model, thinkingLevel: off ? "off" : (previous.thinkingLevel ?? "medium") };
        const models = familyModels(ctx, configOrDefaults(ctx));
        const fallback = models.get("sonnet") ?? FAMILIES.map((family) => models.get(family)).find(Boolean);
        if (!fallback) throw new Error(`no ${PROVIDER} models available`);
        return { model: fallback, thinkingLevel: off ? "off" : "medium" };
      }

      // Keep the bridge model that answered last when the stored pick differs (auto selected
      // mid-session, or again after a detour to a physical model): a switch would re-import.
      const state = request.state;
      const previous = request.previous;
      if (previous && isBridgeModel(previous.model) && previous.model.id !== state?.modelId) {
        const level = toLevel(previous.thinkingLevel);
        const kept: AutoState = { modelId: previous.model.id, level, reason: "kept the model that answered", source: "kept" };
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `auto: kept ${modelName(previous.model)} · ${level}`);
        return { model: previous.model, thinkingLevel: level, state: kept };
      }
      const stored = state && ctx.modelRegistry.find(PROVIDER, state.modelId);
      if (state && isBridgeModel(stored)) return { model: stored, thinkingLevel: state.level };

      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "auto: choosing a model...");
      let suggestion: Suggestion;
      try {
        const allowed = BUDGET[toLevel(request.thinkingLevel)];
        suggestion = await suggest(ctx, configOrDefaults(ctx), lastUserText(request.messages), allowed, request.signal);
      } catch (err) {
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `auto: ${errorText(err)}`);
        throw err;
      }
      const target = `${modelName(suggestion.model)} · ${suggestion.level}`;
      if (ctx.hasUI) {
        const status =
          suggestion.source === "model"
            ? `auto: ${target}, ${suggestion.reason}`
            : `auto: guess ${target} (${suggestion.error})`;
        ctx.ui.setStatus(STATUS_KEY, status);
      }
      return {
        model: suggestion.model,
        thinkingLevel: suggestion.level,
        state: { modelId: suggestion.model.id, level: suggestion.level, reason: suggestion.reason, source: suggestion.source },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("input", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER || isVirtual(ctx.model) || !ctx.hasUI) return;
    if (event.source !== "interactive" || event.streamingBehavior) return;
    const text = event.text.trim();
    if (!text || text.startsWith("/") || userPrompts(ctx).length > 0) return;
    if (modelChosenElsewhere()) return;

    let config: RouterConfig;
    let suggestion: Suggestion;
    try {
      config = loadConfig();
      if (!config.enabled) return;
      ctx.ui.setStatus(STATUS_KEY, "router: choosing a model...");
      suggestion = await suggest(ctx, config, text);
    } catch (err) {
      ctx.ui.setStatus(STATUS_KEY, `router: ${errorText(err)}`);
      return;
    }

    const target = `${modelName(suggestion.model)} · ${suggestion.level}`;
    if (isCurrent(ctx, suggestion)) {
      ctx.ui.setStatus(STATUS_KEY, `router: ${target} fits`);
      return;
    }
    // A keyword guess is too weak to interrupt for; show it without asking.
    if (suggestion.source === "fallback") {
      ctx.ui.setStatus(STATUS_KEY, `router: guess ${target} (${suggestion.error})`);
      return;
    }
    await offer(ctx, suggestion, false);
  });

  pi.registerCommand("model-advice", {
    description:
      "Suggest a Claude model and thinking level. /model-advice <text> is a dry run; " +
      "without text it judges the last prompt and offers a switch.",
    handler: async (args, ctx) => {
      const dryRun = args.trim().length > 0;
      const text = dryRun ? args.trim() : userPrompts(ctx).filter(Boolean).at(-1);
      if (!text) {
        ctx.ui.notify("model-advice: no prompt yet. Usage: /model-advice <task text>", "warning");
        return;
      }

      let config: RouterConfig;
      let suggestion: Suggestion;
      try {
        config = loadConfig();
        suggestion = await suggest(ctx, config, text);
      } catch (err) {
        ctx.ui.notify(`model-advice: ${errorText(err)}`, "error");
        return;
      }
      const via =
        suggestion.source === "model"
          ? `${config.model}, ${suggestion.ms} ms`
          : `keyword fallback: ${suggestion.error}`;

      if (dryRun || ctx.model?.provider !== PROVIDER) {
        ctx.ui.notify(`model-advice: ${describe(suggestion)}\n(${via})`, "info");
        return;
      }
      if (isVirtual(ctx.model)) {
        ctx.ui.notify(
          `model-advice: ${describe(suggestion)}\n(${via})\nAuto keeps its pick; switch with /model.`,
          "info",
        );
        return;
      }
      if (isCurrent(ctx, suggestion)) {
        ctx.ui.notify(`model-advice: current model fits. ${describe(suggestion)}\n(${via})`, "info");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(`model-advice: ${describe(suggestion)}\nNot switching while the agent runs.`, "warning");
        return;
      }
      await offer(ctx, suggestion, true);
    },
  });
}
