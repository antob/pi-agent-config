import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolOverrides } from "./tool-overrides.js";
import { registerThinkingLabeling } from "./thinking-label.js";

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  registerToolOverrides(pi);
  registerThinkingLabeling(pi);
}
