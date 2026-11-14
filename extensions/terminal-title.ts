/**
 * Terminal (tmux pane) title: "π <state><label>".
 *
 * - label: the session name (/name, --name; subagents get "subagent: <name> (%N)"),
 *   else the first prompt shortened, else the working directory name.
 * - state: "● " while working, "? " while waiting on a UI prompt, nothing when idle.
 *
 * Pi resets its own title after session start, reload and renames, so those
 * events re-apply ours after a short delay.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type State = "idle" | "working" | "waiting";

const MARK: Record<State, string> = { idle: "", working: "● ", waiting: "? " };
const MAX_LABEL = 40;

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let timers: ReturnType<typeof setTimeout>[] = [];

  function firstPrompt(ctx: ExtensionContext): string | undefined {
    const branch = ctx.sessionManager.getBranch() as Array<{
      type: string;
      message?: { role?: string; content?: unknown };
    }>;
    for (const entry of branch) {
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((c): c is { type: "text"; text: string } => c?.type === "text")
                .map((c) => c.text)
                .join(" ")
            : "";
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean) return clean;
    }
    return undefined;
  }

  function shorten(text: string): string {
    if (text.length <= MAX_LABEL) return text;
    const cut = text.slice(0, MAX_LABEL - 1);
    const space = cut.lastIndexOf(" ");
    return `${(space > MAX_LABEL / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }

  function label(ctx: ExtensionContext): string {
    const name = pi.getSessionName();
    if (name) return name;
    const prompt = firstPrompt(ctx);
    return prompt ? shorten(prompt) : path.basename(ctx.cwd);
  }

  function apply(ctx: ExtensionContext) {
    try {
      ctx.ui.setTitle(`π ${MARK[state]}${label(ctx)}`);
    } catch {
      // Stale context after a session switch; the new instance takes over.
    }
  }

  function applyLater(ctx: ExtensionContext, delays: number[]) {
    for (const ms of delays) timers.push(setTimeout(() => apply(ctx), ms));
  }

  function setState(next: State, ctx: ExtensionContext) {
    state = next;
    apply(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    state = "idle";
    applyLater(ctx, [100, 1000]);
  });
  pi.on("session_info_changed", async (_event, ctx) => applyLater(ctx, [50]));

  pi.on("agent_start", async (_event, ctx) => setState("working", ctx));
  // The first prompt is in the session by the first turn, so the label can update.
  pi.on("turn_start", async (_event, ctx) => apply(ctx));
  pi.on("ui_prompt_start", async (_event, ctx) => setState("waiting", ctx));
  pi.on("ui_prompt_end", async (_event, ctx) => setState(ctx.isIdle() ? "idle" : "working", ctx));
  pi.on("agent_settled", async (_event, ctx) => setState("idle", ctx));

  pi.on("session_shutdown", async () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  });
}
