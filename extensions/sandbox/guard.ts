import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import { isInsideBoundary } from "./containment.js";
import { isPreApproved } from "./preapproved.js";
import { state } from "./state.js";

/** Tools that take a `path` parameter and touch the filesystem */
const FILE_TOOLS = ["read", "write", "edit", "grep", "find", "ls"] as const;

/**
 * Extract the path from a file tool's input.
 * All built-in file tools use `path` as the parameter name.
 */
function extractPath(
  toolName: string,
  input: Record<string, any>,
): string | null {
  if (!FILE_TOOLS.includes(toolName as any)) return null;
  const p = input?.path;
  return typeof p === "string" ? p : null;
}

/**
 * Register the tool_call event handler that enforces filesystem boundaries.
 */
export function registerGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // Skip if boundary not yet detected (shouldn't happen, but be safe)
    if (!state.boundary) return;

    const targetPath = extractPath(
      event.toolName,
      event.input as Record<string, any>,
    );
    if (targetPath === null) return; // Not a file tool or no path param

    // Resolve to absolute
    const absolutePath = resolve(ctx.cwd, targetPath);

    // Check containment
    const inside = await isInsideBoundary(state.boundary, targetPath, ctx.cwd);
    if (inside) return; // Inside boundary — allow silently

    // Check pre-approved paths
    if (isPreApproved(absolutePath)) return; // Hard-coded pre-approval

    // Check approval store
    if (state.approvals.isApproved(absolutePath)) return; // Previously approved

    // Outside boundary and not approved — ask the user
    const allowed = await ctx.ui.confirm(
      "🔒 pi-sandbox: path outside project",
      `Tool: ${event.toolName}\nPath: ${absolutePath}\nBoundary: ${state.boundary}\n\nAllow this access?`,
    );

    if (allowed) {
      // Remember the directory for this session
      state.approvals.approve(absolutePath);
      return; // Allow
    }

    // Denied — block the tool call
    return {
      block: true,
      reason: `pi-sandbox: access denied to ${absolutePath} (outside boundary ${state.boundary})`,
    };
  });
}
