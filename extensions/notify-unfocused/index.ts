/**
 * Desktop notification (notify-send) when pi finishes a run or waits on a UI
 * prompt (ask_user, automode confirmations, ...). Skipped when this pane's tmux
 * window is the current window of a focused tmux client. Outside tmux it
 * always notifies.
 *
 * Subagents (PI_SUBAGENT_REPORT_TO) only notify when waiting, since their
 * "finished" is reported to the parent agent instead.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TIMEOUT = 2000;
const ICON = fileURLToPath(new URL("./pi-icon.svg", import.meta.url));

export default function (pi: ExtensionAPI) {
  const pane = process.env.TMUX && process.env.TMUX_PANE ? process.env.TMUX_PANE : undefined;
  const isSubagent = Boolean(process.env.PI_SUBAGENT_REPORT_TO);

  async function run(cmd: string, args: string[], cwd?: string) {
    const res = await pi.exec(cmd, args, { cwd, timeout: TIMEOUT }).catch(() => undefined);
    return res && res.code === 0 ? res.stdout.trim() : undefined;
  }

  async function focused(): Promise<boolean> {
    if (!pane) return false;
    const target = await run("tmux", ["display", "-p", "-t", pane, "#{session_name}:#{window_index}"]);
    if (!target) return false;
    const clients = await run("tmux", ["list-clients", "-F", "#{client_flags}\t#{client_session}:#{window_index}"]);
    return (clients ?? "").split("\n").some((line) => {
      const [flags = "", win] = line.split("\t");
      return win === target && flags.split(",").includes("focused");
    });
  }

  // For a git worktree, name the main repo and report the worktree separately.
  async function project(cwd: string): Promise<{ name: string; worktree?: string }> {
    const common = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
    const top = await run("git", ["rev-parse", "--show-toplevel"], cwd);
    if (!common || !top) return { name: path.basename(cwd) };
    const name = path.basename(path.dirname(common));
    const worktree = path.basename(top);
    return worktree !== name ? { name, worktree } : { name };
  }

  async function notify(ctx: ExtensionContext, status: string) {
    if (!ctx.hasUI || (await focused())) return;
    const { name, worktree } = await project(ctx.cwd);
    const details = [pi.getSessionName(), worktree].filter(Boolean).join(" · ");
    const body = details ? `${details}\n${status}` : status;
    await run("notify-send", ["--app-name=pi", `--icon=${ICON}`, name, body]);
  }

  pi.on("agent_settled", async (event, ctx) => {
    // An aborted run means the user just pressed Escape, so they are here.
    if (event.aborted || isSubagent) return;
    void notify(ctx, "Finished");
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    void notify(ctx, "Waiting for input");
  });
}
