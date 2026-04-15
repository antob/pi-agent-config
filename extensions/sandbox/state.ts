import { ApprovalStore } from "./approvals.js";

/**
 * Shared module-level state for pi-sandbox.
 * Set during session_start, read by the guard.
 */
export const state = {
  /** The resolved project boundary (absolute path) */
  boundary: "",
  /** In-memory approval store for the current session */
  approvals: new ApprovalStore(),
};
