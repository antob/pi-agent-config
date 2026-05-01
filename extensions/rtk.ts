/**
 * RTK (Rust Token Killer) integration for pi
 *
 * Transparently rewrites bash tool calls to their RTK equivalents,
 * reducing LLM token consumption by 60–90%.
 *
 * Install rtk first
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

// Cached version check state
let versionChecked = false;
let versionOk = false;
let rtkVersion = "";

// Toggle state (persists for the session)
let enabled = true;

const RTK_MIN_MINOR = 23;

async function checkVersion(pi: ExtensionAPI): Promise<boolean> {
  if (versionChecked) return versionOk;

  try {
    const result = await pi.exec("rtk", ["--version"], { timeout: 5000 });
    if (result.code === 0) {
      rtkVersion = result.stdout.trim();
      const match = rtkVersion.match(/rtk\s+(\d+)\.(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        versionOk = major > 0 || (major === 0 && minor >= RTK_MIN_MINOR);
      }
    }
  } catch {
    // rtk not in PATH
    versionOk = false;
  }

  versionChecked = true;
  return versionOk;
}

function shouldSkip(command: string): boolean {
  const trimmed = command.trim();
  // Already RTK-prefixed
  if (trimmed.startsWith("rtk ")) return true;
  // User disabled RTK for this command
  if (trimmed.startsWith("RTK_DISABLED=1 ")) return true;
  // Empty
  if (!trimmed) return true;
  return false;
}

export default function (pi: ExtensionAPI) {
  // ── Transparent rewrite hook ──────────────────────────────────────
  pi.on("tool_call", async (event, _ctx) => {
    if (!enabled) return;
    if (!isToolCallEventType("bash", event)) return;

    const command = event.input.command;
    if (shouldSkip(command)) return;

    try {
      const result = await pi.exec("rtk", ["rewrite", command], {
        timeout: 5000
      });
      // exit 0 = rewrite found, auto-allow
      // exit 3 = rewrite found, ask-rule matched (treat same as 0 for pi)
      if (result.code === 0 || result.code === 3) {
        const rewritten = result.stdout.trim();
        if (rewritten && rewritten !== command) {
          event.input.command = rewritten;
        }
      }
      // exit 1 = no RTK equivalent, pass through unchanged
      // exit 2 = deny rule matched, pass through unchanged
      // anything else = silent fail, run raw
    } catch {
      // rtk rewrite failed — pass through unchanged
    }
  });

  // ── /rtk command ──────────────────────────────────────────────────
  pi.registerCommand("rtk", {
    description: "Toggle or check RTK status",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      if (arg === "off") {
        enabled = false;
        ctx.ui.notify("RTK rewrite disabled", "info");
        return;
      }

      if (arg === "on") {
        enabled = true;
        ctx.ui.notify("RTK rewrite enabled", "info");
        return;
      }

      if (arg === "gain") {
        try {
          const result = await pi.exec("rtk", ["gain"], { timeout: 10000 });
          if (result.code === 0) {
            ctx.ui.notify(result.stdout.trim(), "info");
          } else {
            ctx.ui.notify(
              `rtk gain failed (exit ${result.code})\n${result.stderr}`,
              "error"
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`rtk gain error: ${msg}`, "error");
        }
        return;
      }

      // Default: show status
      await checkVersion(pi);
      const lines = [
        `RTK for pi`,
        `  Status:    ${enabled ? "enabled ✅" : "disabled ❌"}`,
        ``, // empty line
        `Usage:`,
        `  /rtk on      Enable rewrites`,
        `  /rtk off     Disable rewrites`,
        `  /rtk gain    Show token savings`
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });
}
