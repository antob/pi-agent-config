import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ENV_OFF = "PI_STOP_NOTIFY_OFF";
const TIMEOUT_MS = 10_000;

const STATE_DIR = path.join(os.homedir(), ".pi", "agent");
const STATE_FILE = path.join(STATE_DIR, "notify-on-stop.json");

interface PersistedState {
  enabled: boolean;
}

function readEnabled(): boolean {
  if (!fs.existsSync(STATE_FILE)) return false;
  const raw = fs.readFileSync(STATE_FILE, "utf8");
  const parsed = JSON.parse(raw) as PersistedState;
  return parsed.enabled === true;
}

function writeEnabled(enabled: boolean): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify({ enabled }, null, 2)}\n`);
}

function notify(title?: string): void {
  const cmd = `command -v notify-send >/dev/null 2>&1 && notify-send -t 0 "${title || "pi"}" "Agent done"`;
  const child = exec(cmd, { shell: "/bin/sh", timeout: TIMEOUT_MS });
  child.on("error", () => {});
  child.stderr?.on("data", () => {});
  child.stdout?.on("data", () => {});
}

export default function notifyOnStopExtension(pi: ExtensionAPI): void {
  let enabled = readEnabled();

  pi.on("agent_end", (_event, ctx) => {
    if (!enabled || process.env[ENV_OFF] === "1") return;
    const cwd = ctx.cwd;
    const dir = cwd ? path.basename(cwd.replace(/[\\/]+$/, "")) : null;
    const title = dir ? `pi — ${dir}` : "pi";
    notify(title);
  });

  pi.registerCommand("notify", {
    description:
      "Stop-notify control. Usage: /notify [on|off|status|test]. State persists in ~/.pi/agent/notify-on-stop.json. Defaults to off; PI_STOP_NOTIFY_OFF=1 hard-kills regardless.",
    getArgumentCompletions: (prefix) => {
      const items = ["on", "off", "status", "test"];
      const lower = prefix.toLowerCase();
      const matches = items
        .filter((value) => value.startsWith(lower))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase() || "status";

      if (sub === "test") {
        notify();
        ctx.ui.notify("notify: notification triggered", "info");
        return;
      }

      if (sub === "on") {
        enabled = true;
        writeEnabled(true);
        ctx.ui.notify("notify: on — will notify on agent_end", "info");
        return;
      }

      if (sub === "off") {
        enabled = false;
        writeEnabled(false);
        ctx.ui.notify("notify: off (persisted)", "info");
        return;
      }

      const hardKilled = process.env[ENV_OFF] === "1";
      const stateLabel = hardKilled
        ? `off (PI_STOP_NOTIFY_OFF=1)`
        : enabled
          ? "on"
          : "off";
      ctx.ui.notify(
        enabled && !hardKilled
          ? `notify: ${stateLabel} — will notify on agent_end`
          : `notify: ${stateLabel}`,
        "info",
      );
    },
  });
}
