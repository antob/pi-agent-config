import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerBoundaryDetection } from "./boundary.js";
import { registerGuard } from "./guard.js";

export default function (pi: ExtensionAPI) {
  // Boundary detection — must be first so guard has the boundary available
  registerBoundaryDetection(pi);

  // Tool call guard — intercepts file tools and checks containment
  registerGuard(pi);
}
