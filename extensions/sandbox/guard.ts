import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import { isInsideBoundary } from "./containment.js";
import { isPreApproved } from "./preapproved.js";
import { state } from "./state.js";

/** Write tools — guarded outside the boundary when state.blockWrites is true */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Read tools — only guarded when state.blockReads is true */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

/**
 * Extract the path from a file tool's input.
 * All built-in file tools use `path` as the parameter name.
 * Returns null if the tool is not a guarded tool.
 */
function extractPath(
  toolName: string,
  input: Record<string, any>,
): string | null {
  if (!WRITE_TOOLS.has(toolName) && !READ_TOOLS.has(toolName)) return null;
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

    const isWrite = WRITE_TOOLS.has(event.toolName);
    const isRead = READ_TOOLS.has(event.toolName);

    // Read tools are only guarded when blockReads is enabled
    if (isRead && !state.blockReads) return;

    // Write tools are only guarded when blockWrites is enabled
    if (isWrite && !state.blockWrites) return;

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

    // Check the appropriate approval store
    const approvals = isWrite ? state.writeApprovals : state.readApprovals;
    if (approvals.isApproved(absolutePath)) return; // Previously approved

    // Outside boundary and not approved — ask the user
    const allowed = await ctx.ui.confirm(
      "🔒 pi-sandbox: path outside project",
      `Tool: ${event.toolName}\nPath: ${absolutePath}\nBoundary: ${state.boundary}\n\nAllow this access?`,
    );

    if (allowed) {
      // Remember the directory for this session (in the appropriate store)
      approvals.approve(absolutePath);
      return; // Allow
    }

    // Denied — block the tool call
    return {
      block: true,
      reason: `pi-sandbox: access denied to ${absolutePath} (outside boundary ${state.boundary})`,
    };
  });
}
