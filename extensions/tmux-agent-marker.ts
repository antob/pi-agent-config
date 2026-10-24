/**
 * Marks the tmux pane running pi with the pane option `@agent`, so the
 * window status can show that an agent lives in the window, independent of
 * workmux's working/done status. Value is "pi"; Claude Code hooks set "claude".
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPTION = "@agent";

export default function (pi: ExtensionAPI) {
  const envPane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !envPane) return;
  const pane: string = envPane;

  let marked = false;

  function unmarkSync() {
    if (!marked) return;
    marked = false;
    spawnSync("tmux", ["set-option", "-pu", "-t", pane, OPTION], { stdio: "ignore" });
  }

  // session_shutdown is not guaranteed on hard exits.
  process.on("exit", unmarkSync);

  pi.on("session_start", async () => {
    const { code } = await pi
      .exec("tmux", ["set-option", "-p", "-t", pane, OPTION, "pi"])
      .catch(() => ({ code: 1 }));
    marked = code === 0;
  });

  pi.on("session_shutdown", () => {
    unmarkSync();
  });
}
