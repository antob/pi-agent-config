import type {
  ExtensionAPI,
  ExtensionCommandContext
} from "@mariozechner/pi-coding-agent";
import { registerBoundaryDetection } from "./boundary.js";
import { registerGuard } from "./guard.js";
import { state } from "./state.js";

export default function (pi: ExtensionAPI) {
  // Boundary detection — must be first so guard has the boundary available
  registerBoundaryDetection(pi);

  // Tool call guard — intercepts file tools and checks containment
  registerGuard(pi);

  const SANDBOX_CONSTRAINT = `The sandbox enforces filesystem boundaries.
If any tool call is blocked due to path restrictions, do not attempt the equivalent operation through bash or any other means.
Treat a denied path as off-limits for the remainder of the turn.`;

  // Inject sandbox constraint into the system prompt on every turn
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + SANDBOX_CONSTRAINT
    };
  });

  pi.registerCommand("sandbox", {
    description: "Toggle sandbox read/write blocking",
    getArgumentCompletions: (prefix: string) => {
      const options = [
        { value: "read", label: "Toggle read block" },
        { value: "write", label: "Toggle write block" },
        { value: "on", label: "Block both read and write" },
        { value: "off", label: "Allow both read and write" }
      ];
      const filtered = options.filter((o) => o.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args?.trim() ?? "";

      if (trimmed === "") {
        notifyState(ctx);
        return;
      }

      if (trimmed === "read") {
        state.blockReads = !state.blockReads;
        notifyState(ctx);
        return;
      }

      if (trimmed === "write") {
        state.blockWrites = !state.blockWrites;
        notifyState(ctx);
        return;
      }

      if (trimmed === "on") {
        state.blockReads = true;
        state.blockWrites = true;
        notifyState(ctx);
        return;
      }

      if (trimmed === "off") {
        state.blockReads = false;
        state.blockWrites = false;
        notifyState(ctx);
        return;
      }

      ctx.ui.notify(`pi-sandbox: unknown argument "${trimmed}"`, "error");
    }
  });
}

function notifyState(ctx: ExtensionCommandContext) {
  const r = state.blockReads ? "blocked" : "allowed";
  const w = state.blockWrites ? "blocked" : "allowed";
  ctx.ui.notify(`pi-sandbox: reads ${r}, writes ${w}`, "info");
}
