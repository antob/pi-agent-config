import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { state } from "./state.js";

/**
 * Detect the project filesystem boundary.
 *
 * Tries multiple methods to find the git worktree root:
 * 1. pi.exec() (preferred, uses pi's exec infrastructure)
 * 2. child_process.execSync() (fallback, direct OS call)
 * 3. Falls back to `cwd` if git is not available or not a git repo.
 */
export async function detectBoundary(
  pi: ExtensionAPI,
  cwd: string,
): Promise<{ boundary: string; source: "git" | "cwd" }> {
  // Try pi.exec first
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      timeout: 5000,
    });
    const toplevel = result.stdout.trim();
    if (result.code === 0 && toplevel.length > 0) {
      return { boundary: toplevel, source: "git" };
    }
  } catch {
    // pi.exec may not be available in all contexts — try direct exec
  }

  // Fallback: direct child_process
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      cwd,
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (toplevel.length > 0) {
      return { boundary: toplevel, source: "git" };
    }
  } catch {
    // git not available or not a git repo
  }

  return { boundary: cwd, source: "cwd" };
}

/**
 * Register the session_start handler that detects the boundary on startup.
 */
async function initBoundary(pi: ExtensionAPI, ctx: any) {
  try {
    const { boundary } = await detectBoundary(pi, ctx.cwd);
    state.boundary = boundary;
    state.approvals.clear();
  } catch (err) {
    // Last resort: use cwd as boundary
    state.boundary = ctx.cwd;
    state.approvals.clear();
    ctx.ui.notify(
      `🔒 pi-sandbox: boundary set to ${ctx.cwd} (error fallback: ${err})`,
      "warning",
    );
  }
}

export function registerBoundaryDetection(pi: ExtensionAPI) {
  // Initial session load
  pi.on("session_start", async (_event, ctx) => {
    await initBoundary(pi, ctx);
  });
}
