/**
 * Model advisor for claude-bridge: suggests Haiku, Sonnet, Opus or Fable plus a
 * thinking level for a task, following Anthropic's model selection guidance.
 *
 * On the first prompt of a claude-bridge session it offers a switch before the
 * first request, when the switch is free. `/model-advice` gives the same advice
 * on demand. See model-advisor-plan.md.
 *
 * Config: ~/.pi/agent/model-advisor.json
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

const PROVIDER = "claude-bridge";
const FAMILIES = ["haiku", "sonnet", "opus", "fable"] as const;
const LEVELS = ["low", "medium", "high"] as const;
const PROMPT_MAX_CHARS = 4000;
const CONFIG_PATH = join(getAgentDir(), "model-advisor.json");
const STATUS_KEY = "model-advisor";

type Family = (typeof FAMILIES)[number];
type Level = (typeof LEVELS)[number];

interface AdvisorConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  allowFable: boolean;
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

const DEFAULT_CONFIG: AdvisorConfig = {
  enabled: true,
  model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
  timeoutMs: 4000,
  allowFable: true,
};

// Distilled from Anthropic's "Choosing the right model" page and the Claude Code
// model-config docs (sources in model-advisor-plan.md).
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

function loadConfig(): AdvisorConfig {
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
  return { ...DEFAULT_CONFIG, ...(raw as Partial<AdvisorConfig>) };
}

/** Newest claude-bridge model per family from the scoped models (enabledModels). */
function familyModels(ctx: ExtensionContext, config: AdvisorConfig): Map<Family, Model<any>> {
  const found = new Map<Family, Model<any>>();
  const candidates = ctx.scopedModels
    .map((scoped) => scoped.model)
    .filter((model) => model.provider === PROVIDER)
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  for (const model of candidates) {
    const family = FAMILIES.find((name) => model.id.includes(name));
    if (!family || found.has(family)) continue;
    if (family === "fable" && !config.allowFable) continue;
    found.set(family, model);
  }
  return found;
}

function advisorModel(ctx: ExtensionContext, config: AdvisorConfig): Model<any> {
  const slash = config.model.indexOf("/");
  if (slash <= 0) throw new Error(`invalid model "${config.model}"`);
  const model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
  if (!model) throw new Error(`model ${config.model} not found`);
  // Side calls through claude-bridge would draw on the Claude quota.
  if (model.provider === PROVIDER) throw new Error(`advisor model must not use ${PROVIDER}`);
  return model;
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
  config: AdvisorConfig,
  prompt: string,
  families: Family[],
): Promise<{ family: Family; level: Level; reason: string }> {
  const model = advisorModel(ctx, config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
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

async function suggest(ctx: ExtensionContext, config: AdvisorConfig, prompt: string): Promise<Suggestion> {
  const models = familyModels(ctx, config);
  const families = FAMILIES.filter((family) => models.has(family));
  if (families.length === 0) throw new Error(`no ${PROVIDER} models in enabledModels`);

  const started = Date.now();
  let picked: { family: Family; level: Level; reason: string };
  let source: Suggestion["source"] = "model";
  let error: string | undefined;
  try {
    picked = await askModel(ctx, config, prompt, families);
  } catch (err) {
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
    const choice = await ctx.ui.select(`Model advisor: ${describe(suggestion)}`, [switchLabel, keepLabel]);
    if (choice !== switchLabel) {
      ctx.ui.setStatus(STATUS_KEY, `advisor: kept, suggested ${target}`);
      return false;
    }
    if (!(await pi.setModel(suggestion.model))) {
      ctx.ui.notify(`model-advisor: no credentials for ${suggestion.model.id}`, "error");
      return false;
    }
    // setModel resets the level to the model default, so set it afterwards.
    pi.setThinkingLevel(suggestion.level);
    ctx.ui.setStatus(STATUS_KEY, `advisor: switched to ${target}`);
    return true;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("input", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER || !ctx.hasUI) return;
    if (event.source !== "interactive" || event.streamingBehavior) return;
    const text = event.text.trim();
    if (!text || text.startsWith("/") || userPrompts(ctx).length > 0) return;
    if (modelChosenElsewhere()) return;

    let config: AdvisorConfig;
    let suggestion: Suggestion;
    try {
      config = loadConfig();
      if (!config.enabled) return;
      ctx.ui.setStatus(STATUS_KEY, "advisor: choosing a model...");
      suggestion = await suggest(ctx, config, text);
    } catch (err) {
      ctx.ui.setStatus(STATUS_KEY, `advisor: ${errorText(err)}`);
      return;
    }

    const target = `${modelName(suggestion.model)} · ${suggestion.level}`;
    if (isCurrent(ctx, suggestion)) {
      ctx.ui.setStatus(STATUS_KEY, `advisor: ${target} fits`);
      return;
    }
    // A keyword guess is too weak to interrupt for; show it without asking.
    if (suggestion.source === "fallback") {
      ctx.ui.setStatus(STATUS_KEY, `advisor: guess ${target} (${suggestion.error})`);
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

      let config: AdvisorConfig;
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
