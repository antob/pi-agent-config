import { ApprovalStore } from "./approvals.js";

/**
 * Shared module-level state for pi-sandbox.
 * Set during session_start, read by the guard.
 */
export const state = {
  /** The resolved project boundary (absolute path) */
  boundary: "",
  /**
   * When true, read tools (read, grep, find, ls) outside the boundary
   * are subject to the approval prompt. Defaults to false.
   * Not persisted — resets on each session start.
   */
  blockReads: false,
  /**
   * When true, write tools (write, edit) outside the boundary
   * are subject to the approval prompt. Defaults to true.
   * Not persisted — resets on each session start.
   */
  blockWrites: true,
  /** In-memory approval store for write tools (write, edit) */
  writeApprovals: new ApprovalStore(),
  /** In-memory approval store for read tools (read, grep, find, ls) */
  readApprovals: new ApprovalStore(),
};
