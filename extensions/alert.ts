import { basename } from "node:path";
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function alertExtension(pi: ExtensionAPI) {
  let enabled = false;

  pi.registerCommand("alert", {
    description:
      "Toggle agent-end notifications on or off. Usage: /alert on | /alert off",
    handler: async (args, ctx) => {
      const arg = args?.trim();
      if (arg === "on") {
        enabled = true;
        ctx.ui.notify("Alert notifications enabled", "info");
      } else if (arg === "off") {
        enabled = false;
        ctx.ui.notify("Alert notifications disabled", "info");
      } else {
        ctx.ui.notify(
          `Alert notifications are currently ${enabled ? "on" : "off"}`,
          "info",
        );
      }
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!enabled) return;

    const cwd = ctx.cwd;
    const dir = cwd ? basename(cwd.replace(/[\\/]+$/, "")) : null;
    const title = dir ? `pi — ${dir}` : "pi";
    const message = "Agent finished its turn";

    try {
      await exec("notify-send", [
        "--app-name=pi",
        "--expire-time=5000",
        title,
        message,
      ]);
    } catch {
      // notify-send not available or failed, silently ignore
    }
  });
}

function exec(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
