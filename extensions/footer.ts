// ABOUTME: Footer widget displaying model name, context percentage + window size, and working directory.
// ABOUTME: Shows context usage warnings; core pi framework handles actual auto-compaction.
/**
 * Footer — Dark status bar with model · context % / window · directory.
 *
 * Context compaction is handled by pi's core _runAutoCompaction which properly
 * emits auto_compaction_start/end events. The interactive-mode handles these
 * events by calling rebuildChatFromMessages() to clear and re-render the UI.
 *
 * Previously, this extension called ctx.compact() directly which bypassed
 * the auto_compaction events, leaving stale UI components that caused
 * doubled/artifact rendering after compaction.
 */

import { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename, dirname } from "node:path";

/** Turn a model name like "Claude 4 Opus" into "opus 4" */
function shortModelName(name: string | undefined): string {
  if (!name) return "no model";
  const cleaned = name
    .replace(/^anthropic:\s*/i, "")
    .replace(/^claude\s*/i, "")
    .trim();
  const tokens = cleaned.split(/\s+/);
  const versions: string[] = [];
  const words: string[] = [];
  for (const token of tokens) {
    if (/^[\d.]+$/.test(token)) versions.push(token);
    else words.push(token.toLowerCase());
  }
  const parts = [...words, ...versions];
  return parts.join(" ") || name.toLowerCase();
}

/** Format a token count into compact K/M notation: 200K, 1.2M */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return k % 1 === 0 ? `${k}K` : `${parseFloat(k.toFixed(1))}K`;
  }
  const m = n / 1_000_000;
  return m % 1 === 0 ? `${m}M` : `${parseFloat(m.toFixed(1))}M`;
}

/** Thinking level → labeled indicator */
function thinkingIndicator(level: string | undefined, theme: any): string {
  const label = level || "off";
  const color =
    label === "off"
      ? "dim"
      : label === "high" || label === "xhigh"
        ? "warning"
        : "accent";
  return theme.fg("dim", "thinking: ") + theme.fg(color, label);
}

/** Last two path components: "Github-Work/pi-vs-claude-code" */
function shortDir(cwd: string): string {
  const child = basename(cwd);
  const parent = basename(dirname(cwd));
  return parent ? `${parent}/${child}` : child;
}

function setupFooter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  onUnsub: (unsub: () => void) => void,
) {
  ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    onUnsub(unsub);
    return {
      dispose: unsub,
      invalidate() {},
      render(width: number): string[] {
        const provider = ctx.model?.provider || "unknown provider";
        const model = shortModelName(ctx.model?.name);
        const usage = ctx.getContextUsage();
        const contextWindow = ctx.model?.contextWindow || 0;

        let input = 0,
          output = 0,
          cost = 0;
        for (const e of ctx.sessionManager.getBranch()) {
          if (e.type === "message" && e.message.role === "assistant") {
            const m = e.message as AssistantMessage;
            input += m.usage.input;
            output += m.usage.output;
            cost += m.usage.cost.total;
          }
        }

        let statsParts: string[] = [];

        if (input > 0 || output > 0) {
          statsParts.push(`↑${formatTokens(input)} ↓${formatTokens(output)}`);
        }

        if (usage?.percent != null) {
          const pct = `${Math.round(usage.percent)}%`;
          if (contextWindow > 0) {
            statsParts.push(`${pct}/${formatTokens(contextWindow)}`);
          } else {
            statsParts.push(pct);
          }
        }

        const dir = shortDir(ctx.cwd);
        const thinking = thinkingIndicator(pi.getThinkingLevel?.(), theme);
        const sep = theme.fg("dim", " | ");
        const modelStr = theme.fg("accent", theme.bold(model));
        const providerStr = theme.fg("dim", ` (${provider})`);
        const statsStr = theme.fg("dim", statsParts.join(" "));
        const costStr = theme.fg("dim", `$${cost.toFixed(2)}`);

        const leftContent =
          " " +
          modelStr +
          providerStr +
          sep +
          statsStr +
          sep +
          costStr +
          sep +
          theme.fg("dim", dir);

        const rightContent = thinking + ` `;

        const leftWidth = visibleWidth(leftContent);
        const rightWidth = visibleWidth(rightContent);
        const gap = Math.max(1, width - leftWidth - rightWidth);
        const line = leftContent + " ".repeat(gap) + rightContent;

        return [truncateToWidth(line, width, "")];
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  let branchUnsub: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    setupFooter(pi, ctx, (unsub) => {
      branchUnsub = unsub;
    });
  });

  pi.on("session_shutdown", async () => {
    if (branchUnsub) {
      branchUnsub();
      branchUnsub = null;
    }
  });
}
