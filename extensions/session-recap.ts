/**
 * Claude Code style away recap: a dim "※ recap:" line above the editor after
 * you have been away from the session.
 *
 * Based on tmustier's session-recap (MIT):
 * https://github.com/tmustier/pi-extensions/tree/main/session-recap
 *
 * Config: ~/.pi/agent/session-recap.json (see session-recap.md).
 */

import { readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  getAgentDir,
  type ContextEditEntry,
  type ExtensionAPI,
  type ExtensionContext,
  type ProjectedSessionEntry,
  type SessionEntry
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type Model = NonNullable<ExtensionContext["model"]>;

type RecapConfig = {
  enabled: boolean;
  model?: string;
  awaySeconds: number;
  idleSeconds: number;
  focusReporting: boolean;
  duringActive: boolean;
};

type RecapContext = {
  transcript: string;
  broaderContext?: string;
};

type RecapReason = "idle" | "manual" | "resume" | "focus";

type SavedRecap = {
  text: string;
  model: string;
};

const RECAP_KEY = "session-recap";
const CONFIG_PATH = join(getAgentDir(), "session-recap.json");

const DEFAULT_CONFIG: RecapConfig = {
  enabled: true,
  awaySeconds: 90,
  idleSeconds: 120,
  focusReporting: true,
  duringActive: false
};

// claude-bridge only accepts system prompts captured from the main session.
const SKIPPED_PROVIDERS = new Set(["claude-bridge"]);

const RECAP_PROMPT =
  "The user stepped away and is coming back. Write exactly 1-3 short sentences. " +
  "Start by stating the high-level task — what they are building or debugging, not " +
  "implementation details. Next: the concrete next step. Skip status reports and commit recaps.";

// Debounce after a turn ends while blurred, so mid-loop turn_ends (which are
// immediately followed by the next turn_start) don't trigger drafts.
const POST_TURN_DEBOUNCE_MS = 3000;

const RECENT_MESSAGE_WINDOW = 30;
const MIN_ASSISTANT_WORDS = 30;
const INITIAL_TASK_EDGE_CHARS = 4000;
const MESSAGE_EDGE_CHARS = 2000;
const TOOL_ARGS_MAX_CHARS = 300;

// DECSET 1004 focus reporting — https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";
const FOCUS_IN_SEQ = "\x1b[I";
const FOCUS_OUT_SEQ = "\x1b[O";

function loadConfig(): RecapConfig {
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
  return { ...DEFAULT_CONFIG, ...(raw as Partial<RecapConfig>) };
}

function seconds(value: number): number {
  return Math.max(5, Number.isFinite(value) ? value : 5) * 1000;
}

function clip(text: string, edge: number, label: string): string {
  if (text.length <= edge * 2) return text;
  return `${text.slice(0, edge)}\n… [${label}] …\n${text.slice(-edge)}`;
}

function extractText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// Tool calls become short text markers and tool results are dropped, so no
// tool output leaves the machine and no provider sees a call without its result.
function formatMessage(message: Message): string {
  if (message.role === "user") return extractText(message.content).trim();
  if (message.role !== "assistant") return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    if (block.type === "toolCall") {
      const args = JSON.stringify(block.arguments ?? {});
      const shortArgs =
        args.length > TOOL_ARGS_MAX_CHARS ? `${args.slice(0, TOOL_ARGS_MAX_CHARS)}…` : args;
      parts.push(`[tool: ${block.name} ${shortArgs}]`);
    }
  }
  return parts.join("\n").trim();
}

function findInitialTask(entries: SessionEntry[]): string | undefined {
  const edits = new Map<string, ContextEditEntry["replacement"]>();
  for (const entry of entries) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement);
  }

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const replacement = edits.get(entry.id);
    if (replacement === null) continue;
    const initialTask = extractText(replacement?.content ?? entry.message.content).trim();
    if (initialTask) return initialTask;
  }
  return undefined;
}

function buildRecapContext(
  entries: ProjectedSessionEntry[],
  branchEntries: SessionEntry[]
): RecapContext {
  let summary: string | undefined;
  for (const { sourceEntry, messages } of entries) {
    if (sourceEntry.type !== "compaction" && sourceEntry.type !== "branch_summary") continue;
    if (messages.length > 0) summary = sourceEntry.summary.trim() || summary;
  }
  const initialTask = findInitialTask(branchEntries);

  const messages = convertToLlm(
    entries
      .filter(
        ({ sourceEntry }) =>
          sourceEntry.type !== "compaction" && sourceEntry.type !== "branch_summary"
      )
      .flatMap((entry) => entry.messages)
  )
    .map((message) => ({ role: message.role, text: formatMessage(message) }))
    .filter((message) => message.text);

  const recent = messages.slice(-RECENT_MESSAGE_WINDOW);
  const lines = recent.map(
    ({ role, text }) =>
      `${role === "user" ? "User" : "Assistant"}: ${clip(text, MESSAGE_EDGE_CHARS, "message truncated for recap")}`
  );
  if (messages.length > recent.length) lines.unshift("(Earlier conversation omitted.)");

  const broader: string[] = [];
  const initialTaskInRecent = recent.some(
    (message) => message.role === "user" && message.text === initialTask
  );
  if (initialTask && !initialTaskInRecent) {
    broader.push(
      `Initial user request:\n${clip(initialTask, INITIAL_TASK_EDGE_CHARS, "middle of initial request omitted for recap")}`
    );
  }
  if (summary) broader.push(`Session summary:\n${summary}`);

  return {
    transcript: recent.length > 0 ? lines.join("\n\n") : "",
    broaderContext: broader.length > 0 ? broader.join("\n\n") : undefined
  };
}

function hasMeaningfulActivity(entries: ProjectedSessionEntry[]): boolean {
  const messages = convertToLlm(entries.flatMap((entry) => entry.messages));
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const tail = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
  let assistantWords = 0;
  for (const message of tail) {
    if (message.role !== "assistant") continue;
    if (message.content.some((block) => block.type === "toolCall")) return true;
    assistantWords += extractText(message.content).split(/\s+/).filter(Boolean).length;
  }
  return assistantWords >= MIN_ASSISTANT_WORDS;
}

function selectRecapModel(ctx: ExtensionContext, config: RecapConfig): Model | undefined {
  if (config.model) {
    const slash = config.model.indexOf("/");
    if (slash <= 0) return undefined;
    const model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
    return model && !SKIPPED_PROVIDERS.has(model.provider) ? model : undefined;
  }
  const active = ctx.model;
  return active && !SKIPPED_PROVIDERS.has(active.provider) ? active : undefined;
}

async function generateRecap(
  recapContext: RecapContext,
  ctx: ExtensionContext,
  model: Model,
  signal: AbortSignal
): Promise<SavedRecap | undefined> {
  const prompt =
    (recapContext.broaderContext
      ? `Broader session context:\n${recapContext.broaderContext}\n\n`
      : "") +
    (recapContext.transcript ? `Recent conversation:\n${recapContext.transcript}\n\n` : "") +
    RECAP_PROMPT;

  // No reasoning option: omitting it disables thinking on the APIs used here.
  const response = await ctx.modelRegistry
    .streamSimple(
      model,
      {
        systemPrompt: "",
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }]
      },
      {
        signal,
        cacheRetention: "none",
        maxTokens: 256,
        sessionId: ctx.sessionManager.getSessionId()
      }
    )
    .result();

  // A cut-off reply orients nobody, so only a complete response becomes a recap.
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || "the recap request failed mid-stream");
  }
  if (response.stopReason !== "stop") return undefined;

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text ? { text, model: `${model.provider}/${model.id}` } : undefined;
}

function isSavedRecap(data: unknown): data is SavedRecap {
  return (
    !!data && typeof data === "object" && typeof (data as SavedRecap).text === "string"
  );
}

function showRecap(ctx: ExtensionContext, recap: string) {
  ctx.ui.setWidget(
    RECAP_KEY,
    (_tui, theme) =>
      new Text(theme.fg("dim", `※ ${theme.bold("recap:")} ${theme.italic(recap)}`), 1, 0),
    { placement: "aboveEditor" }
  );
}

function clearRecap(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(RECAP_KEY, undefined);
  ctx.ui.setStatus(RECAP_KEY, undefined);
}

export default function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  let idleTimer: NodeJS.Timeout | undefined;
  let awayTimer: NodeJS.Timeout | undefined;
  let postTurnTimer: NodeJS.Timeout | undefined;
  let activeController: AbortController | undefined;
  let agentActive = false;
  let awayRecapPending = false;
  let focusListener: ((chunk: Buffer) => void) | undefined;
  let focusEnabled = false;
  let isBlurred = false;
  let focusEventsSeen = false;
  let lastDraftedContext: string | undefined;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const clearAwayTimer = () => {
    if (awayTimer) {
      clearTimeout(awayTimer);
      awayTimer = undefined;
    }
  };
  const clearPostTurnTimer = () => {
    if (postTurnTimer) {
      clearTimeout(postTurnTimer);
      postTurnTimer = undefined;
    }
  };

  const cancelActive = () => {
    activeController?.abort();
    activeController = undefined;
  };

  const generateAndShow = async (ctx: ExtensionContext, reason: RecapReason) => {
    if (!ctx.hasUI) return;
    const manual = reason === "manual";
    const projection = ctx.sessionManager.buildSessionProjection();
    if (!manual && !hasMeaningfulActivity(projection.entries)) return;

    const branch = ctx.sessionManager.getBranch();
    const recapContext = buildRecapContext(projection.entries, branch);
    if (!recapContext.transcript && !recapContext.broaderContext) return;

    const startContext = JSON.stringify(recapContext);
    if (!manual && lastDraftedContext === startContext) return;

    if (reason === "resume") {
      const latest = [...branch].reverse().find((entry) =>
        (entry.type === "custom" && entry.customType === RECAP_KEY) ||
        ["message", "custom_message", "compaction", "branch_summary", "context_edit"].includes(entry.type)
      );
      if (latest?.type === "custom" && isSavedRecap(latest.data)) {
        lastDraftedContext = startContext;
        showRecap(ctx, latest.data.text);
        return;
      }
    }

    const model = selectRecapModel(ctx, config);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
      if (manual) {
        ctx.ui.notify(
          `session-recap: no usable model${config.model ? ` (${config.model})` : ""}. Set "model" in ${CONFIG_PATH}.`,
          "warning"
        );
      }
      return;
    }

    cancelActive();
    const controller = new AbortController();
    activeController = controller;

    const showStatus = manual || reason === "idle";
    if (showStatus) ctx.ui.setStatus(RECAP_KEY, ctx.ui.theme.fg("dim", "※ drafting recap…"));

    try {
      const recap = await generateRecap(recapContext, ctx, model, controller.signal);
      if (controller.signal.aborted) return;
      if (!recap) {
        if (manual) ctx.ui.notify("session-recap: the model returned no complete recap.", "warning");
        return;
      }
      const currentContext = buildRecapContext(
        ctx.sessionManager.buildSessionProjection().entries,
        ctx.sessionManager.getBranch()
      );
      if (JSON.stringify(currentContext) !== startContext) return;

      lastDraftedContext = startContext;
      clearIdleTimer();
      clearPostTurnTimer();

      // Save only between runs, so a recap drawn during a run never lands
      // between that run's own entries.
      if (!agentActive) {
        // Preserve recency so a recap doesn't change which session `pi -c` reopens.
        const file = ctx.sessionManager.getSessionFile();
        const previous = file ? { file, times: statSync(file) } : undefined;
        pi.appendEntry<SavedRecap>(RECAP_KEY, recap);
        if (previous) utimesSync(previous.file, previous.times.atimeMs / 1000, previous.times.mtimeMs / 1000);
      }
      showRecap(ctx, recap.text);
    } catch (err) {
      // Never console.*: raw writes land mid-frame and corrupt the TUI.
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`session-recap: ${message}`, "error");
      }
    } finally {
      if (activeController === controller) {
        activeController = undefined;
        if (showStatus) ctx.ui.setStatus(RECAP_KEY, undefined);
      }
    }
  };

  const tryAwayRecap = (ctx: ExtensionContext) => {
    if (!config.enabled || !ctx.hasUI || !isBlurred) return;
    if (agentActive && !config.duringActive) {
      awayRecapPending = true;
      return;
    }
    if (!activeController) void generateAndShow(ctx, "focus");
  };

  const handleFocusOut = (ctx: ExtensionContext) => {
    focusEventsSeen = true;
    isBlurred = true;
    clearIdleTimer();
    if (!config.enabled) return;
    clearAwayTimer();
    awayTimer = setTimeout(() => {
      awayTimer = undefined;
      tryAwayRecap(ctx);
    }, seconds(config.awaySeconds));
  };

  // Typing proves focus even when a focus-in report was lost. Does not set
  // focusEventsSeen, so terminals without focus reporting keep the idle fallback.
  const markActive = () => {
    if (!isBlurred) return;
    isBlurred = false;
    awayRecapPending = false;
    clearAwayTimer();
    clearPostTurnTimer();
  };

  const handleFocusIn = () => {
    focusEventsSeen = true;
    markActive();
    clearIdleTimer();
    // Leave an in-flight recap to land as the user returns.
  };

  const attachFocusReporting = (ctx: ExtensionContext) => {
    if (focusEnabled || !config.focusReporting || !ctx.hasUI) return;
    if (!process.stdout.isTTY || !process.stdin.isTTY) return;

    try {
      process.stdout.write(FOCUS_ENABLE);
    } catch {
      return;
    }

    // Focus sequences may straddle input chunks, so retain a tail that could
    // still become one. Any other byte is user input.
    let buf = "";
    const listener = (chunk: Buffer) => {
      buf += chunk.toString("binary");
      let i = 0;
      while (i < buf.length) {
        if (buf.startsWith(FOCUS_IN_SEQ, i)) {
          handleFocusIn();
          i += FOCUS_IN_SEQ.length;
        } else if (buf.startsWith(FOCUS_OUT_SEQ, i)) {
          handleFocusOut(ctx);
          i += FOCUS_OUT_SEQ.length;
        } else {
          const rest = buf.slice(i);
          if (FOCUS_IN_SEQ.startsWith(rest) || FOCUS_OUT_SEQ.startsWith(rest)) break;
          markActive();
          i++;
        }
      }
      buf = buf.slice(i);
    };
    process.stdin.on("data", listener);
    focusListener = listener;
    focusEnabled = true;
  };

  const detachFocusReporting = () => {
    if (focusListener) {
      process.stdin.off("data", focusListener);
      focusListener = undefined;
    }
    if (focusEnabled) {
      try {
        process.stdout.write(FOCUS_DISABLE);
      } catch {}
      focusEnabled = false;
    }
    isBlurred = false;
    awayRecapPending = false;
  };

  pi.on("turn_end", (_event, ctx) => {
    if (!config.enabled || !ctx.hasUI) return;

    // Debounce mid-loop turn_end → turn_start pairs.
    if (isBlurred) {
      clearPostTurnTimer();
      postTurnTimer = setTimeout(() => {
        postTurnTimer = undefined;
        tryAwayRecap(ctx);
      }, POST_TURN_DEBOUNCE_MS);
    }

    if (!focusEventsSeen) {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (!focusEventsSeen) void generateAndShow(ctx, "idle");
      }, seconds(config.idleSeconds));
    }
  });

  pi.on("turn_start", () => {
    clearIdleTimer();
    clearPostTurnTimer();
    cancelActive();
  });

  pi.on("input", (_event, ctx) => {
    markActive();
    clearIdleTimer();
    clearPostTurnTimer();
    clearAwayTimer();
    cancelActive();
    awayRecapPending = false;
    clearRecap(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    agentActive = true;
    clearIdleTimer();
    clearPostTurnTimer();
    cancelActive();
    clearRecap(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    agentActive = false;
    if (awayRecapPending) {
      awayRecapPending = false;
      tryAwayRecap(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    agentActive = false;
    awayRecapPending = false;
    clearIdleTimer();
    clearAwayTimer();
    clearPostTurnTimer();
    cancelActive();
    detachFocusReporting();
  });

  pi.on("session_start", (event, ctx) => {
    try {
      config = loadConfig();
    } catch (err) {
      config = DEFAULT_CONFIG;
      if (ctx.hasUI) {
        ctx.ui.notify(`session-recap: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    }
    attachFocusReporting(ctx);
    if (!config.enabled || !ctx.hasUI) return;
    // A session opened from the command line (`pi -c`, `pi -r`, `--session`)
    // reports "startup"; an in-process switch reports "resume".
    if (event.reason === "startup" || event.reason === "resume" || event.reason === "fork") {
      setTimeout(() => {
        // `pi -c "<prompt>"` starts work at once; the recap would be stale on arrival.
        if (!agentActive) void generateAndShow(ctx, "resume");
      }, 300);
    }
  });

  pi.registerCommand("recap", {
    description: "Generate a recap of recent session activity",
    handler: (_args, ctx) => generateAndShow(ctx, "manual")
  });
}
