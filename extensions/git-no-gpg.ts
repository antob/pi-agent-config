import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    // Rewrite `git commit` -> `git -c commit.gpgsign=false commit`
    // Uses a regex to handle leading whitespace, env vars, etc.
    event.input.command = event.input.command.replace(
      /\bgit(\s+)commit\b/g,
      "git$1-c commit.gpgsign=false commit",
    );
  });
}
