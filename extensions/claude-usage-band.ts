/**
 * Claude usage band: plan usage left (5h, 7d) and prompt cache state for the
 * claude-bridge provider, shown as a widget above the editor.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROVIDER = "claude-bridge";
const WIDGET_KEY = "claude-usage-band";
const HEADER_PREFIX = "anthropic-ratelimit-unified-";
const CACHE_TTL_MIN = 60;
const LOW_AT = 15;
const CELLS = 10;
const TIGHT_CELLS = 6;
const TICK_MS = 30_000;

// =============================================================================
// Types
// =============================================================================

type Entries = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
type WindowKey = "7d" | "5h";
type Color = Parameters<Theme["fg"]>[0];
type Styler = Pick<Theme, "fg" | "bold">;

interface UsageWindow {
  /** Fraction used, 0..1. */
  utilization: number;
  /** Unix seconds. */
  resetsAt: number;
}

type Windows = Partial<Record<WindowKey, UsageWindow>>;

interface CacheState {
  /** Unix ms of the last request start. */
  lastAt: number;
  tokens: number;
}

interface BandState {
  windows: Windows;
  cache: CacheState | null;
}

const WINDOW_ORDER: WindowKey[] = ["7d", "5h"];
const WINDOW_COLOR: Record<WindowKey, Color> = { "7d": "mdLink", "5h": "warning" };

// =============================================================================
// Parsing and formatting (pure)
// =============================================================================

export function parseWindows(headers: Record<string, string>): Windows {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const out: Windows = {};
  for (const key of WINDOW_ORDER) {
    const rawUtilization = lower[`${HEADER_PREFIX}${key}-utilization`];
    const utilization = Number(rawUtilization);
    const resetsAt = Number(lower[`${HEADER_PREFIX}${key}-reset`]);
    if (rawUtilization === undefined || !Number.isFinite(utilization) || !Number.isFinite(resetsAt)) {
      continue;
    }
    out[key] = { utilization, resetsAt };
  }
  return out;
}

/** Cache state of a resumed session: the latest bridge reply of the current model, unless a compaction followed it. */
export function seedCache(entries: Entries, modelId: string): CacheState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "compaction") return null;
    if (entry.type !== "message") continue;
    const m = entry.message as any;
    if (m.role !== "assistant") continue;
    const tokens = m.usage?.totalTokens;
    if (m.provider !== PROVIDER || m.model !== modelId || !(tokens > 0) || !(m.timestamp > 0)) return null;
    return { lastAt: m.timestamp, tokens };
  }
  return null;
}

export function percentLeft(w: UsageWindow): number {
  return Math.max(0, Math.min(100, Math.round((1 - w.utilization) * 100)));
}

export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatReset(resetsAt: number, now: number): string {
  const ms = resetsAt * 1000 - now;
  return ms <= 0 ? "resetting" : formatDuration(ms);
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}M`;
  return `${Math.round(n / 1000)}k`;
}

// =============================================================================
// Rendering (pure)
// =============================================================================

function dots(left: number, cells: number, color: Color, th: Styler): string {
  const n = Math.max(0, Math.min(cells, Math.round((left / 100) * cells)));
  return th.fg(color, "●".repeat(n)) + th.fg("dim", "·".repeat(cells - n));
}

function usageLine(state: BandState, now: number, cells: number, th: Styler): string {
  const label = th.bold("USAGE");
  const segments: string[] = [];

  for (const key of WINDOW_ORDER) {
    const w = state.windows[key];
    if (!w) continue;
    const left = percentLeft(w);
    const color = WINDOW_COLOR[key];
    const low = left < LOW_AT ? ` ${th.fg("error", th.bold("LOW"))}` : "";
    segments.push(
      `${th.fg("muted", th.bold(key.toUpperCase()))} ${dots(left, cells, color, th)} ` +
        `${th.fg(color, th.bold(`${left}% left`))}${low} ${th.fg("muted", `· ${formatReset(w.resetsAt, now)}`)}`
    );
  }

  if (segments.length === 0) return `${label}  ${th.fg("muted", "waiting for first reply")}`;
  return `${label}  ${segments.join("   ")}`;
}

function cacheLine(state: BandState, now: number, th: Styler): string | null {
  const cache = state.cache;
  if (!cache || cache.lastAt <= 0 || cache.tokens <= 0) return null;

  const label = th.fg("muted", th.bold("CACHE"));
  const idleMs = Math.max(0, now - cache.lastAt);
  const tok = formatTokens(cache.tokens);

  if (idleMs >= CACHE_TTL_MIN * 60000) {
    return (
      `${label} ${th.fg("error", th.bold("COLD"))} ` +
      th.fg("muted", `${formatDuration(idleMs)} idle · re-sends ${tok} tok`)
    );
  }
  const left = Math.max(0, CACHE_TTL_MIN - Math.floor(idleMs / 60000));
  return `${label} ${th.fg("success", th.bold("WARM"))} ${th.fg("muted", `${left}m left · ${tok} tok`)}`;
}

/** Picks the first layout that fits: one row, then cache on its own row, then fewer dots. */
export function renderBand(state: BandState, now: number, width: number, th: Styler): string[] {
  const cache = cacheLine(state, now, th);
  const layouts: string[][] = [];

  for (const cells of [CELLS, TIGHT_CELLS]) {
    const usage = usageLine(state, now, cells, th);
    layouts.push(cache ? [`${usage}   ${cache}`] : [usage]);
    if (cache) layouts.push([usage, cache]);
  }

  const fits = layouts.find((lines) => lines.every((l) => visibleWidth(l) <= width));
  const chosen = fits ?? layouts[layouts.length - 1]!;
  return chosen.map((l) => truncateToWidth(l, width));
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
  const state: BandState = { windows: {}, cache: null };
  let installed = false;
  let requestRender: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    requestRender = undefined;
  };

  const install = (ctx: ExtensionContext) => {
    if (installed) return;
    ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      stopTimer();
      requestRender = () => tui.requestRender();
      timer = setInterval(() => tui.requestRender(), TICK_MS);
      timer.unref?.();
      return {
        render: (width: number) => renderBand(state, Date.now(), width, theme),
        invalidate() {},
        dispose: stopTimer
      };
    });
    installed = true;
  };

  const uninstall = (ctx: ExtensionContext) => {
    if (!installed) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    stopTimer();
    installed = false;
  };

  const refresh = (ctx: ExtensionContext, provider: string | undefined = ctx.model?.provider) => {
    if (!ctx.hasUI) return;
    if (provider !== PROVIDER) {
      uninstall(ctx);
      return;
    }
    install(ctx);
    requestRender?.();
  };

  pi.on("session_start", async (event, ctx) => {
    state.windows = {};
    state.cache =
      ctx.model?.provider === PROVIDER && event.reason !== "new"
        ? seedCache(ctx.sessionManager.getBranch(), ctx.model.id)
        : null;
    refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) uninstall(ctx);
    stopTimer();
  });

  pi.on("model_select", async (event, ctx) => {
    const prev = event.previousModel;
    if (prev?.provider !== event.model.provider || prev?.id !== event.model.id) {
      state.cache = null;
    }
    refresh(ctx, event.model.provider);
  });

  pi.on("session_compact", async (_event, ctx) => {
    state.cache = null;
    refresh(ctx);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return;
    Object.assign(state.windows, parseWindows(event.headers ?? {}));
    refresh(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return;
    state.cache = { lastAt: event.timestamp, tokens: state.cache?.tokens ?? 0 };
    refresh(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.model?.provider !== PROVIDER) return;
    const tokens = ctx.getContextUsage()?.tokens;
    if (typeof tokens === "number" && tokens > 0 && state.cache) {
      state.cache = { ...state.cache, tokens };
    }
    refresh(ctx);
  });
}
