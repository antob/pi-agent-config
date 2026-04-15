import { dirname, sep } from "node:path";

/**
 * In-memory store of approved directories for the current session.
 * When a user approves access to a file outside the boundary,
 * its parent directory is stored. Future accesses to files in
 * approved directories (including subdirectories) are auto-allowed.
 */
export class ApprovalStore {
  private approved = new Set<string>();

  /**
   * Approve a file path by storing its parent directory.
   * The directory is normalized to end with a path separator.
   */
  approve(filePath: string): void {
    const dir = dirname(filePath);
    const normalized = dir.endsWith(sep) ? dir : dir + sep;
    this.approved.add(normalized);
  }

  /**
   * Check if a file path is in an approved directory.
   * Returns true if the file's path starts with any approved directory prefix,
   * which includes subdirectories.
   */
  isApproved(filePath: string): boolean {
    for (const dir of this.approved) {
      if (filePath === dir.slice(0, -1) || filePath.startsWith(dir)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Clear all approvals (e.g. on session end).
   */
  clear(): void {
    this.approved.clear();
  }

  /** Number of approved directories (for testing) */
  get size(): number {
    return this.approved.size;
  }
}
