import micromatch from "micromatch";

/**
 * Hard-coded paths that are always approved without prompting.
 * The prefix/subdirectory logic applies: approving a directory
 * also approves everything inside it.
 *
 * Supports ~ expansion for home-relative paths.
 */
const PRE_APPROVED_PATHS: string[] = [
  "**/node_modules/pi-monorepo/**",
  "**/node_modules/@mariozechner/pi-coding-agent/**",
  "/tmp/**",
];

/**
 * Expand ~ in each pre-approved path
 */
function expandPaths(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
  return PRE_APPROVED_PATHS.map((p) => {
    return p.startsWith("~/") ? home + p.slice(1) : p === "~" ? home : p;
  });
}

const EXPANDED_PATHS = expandPaths();

/**
 * Returns true if the given absolute path matches the pre-approved path.
 */
export function isPreApproved(absolutePath: string): boolean {
  for (const prefix of EXPANDED_PATHS) {
    if (micromatch.isMatch(absolutePath, prefix, { dot: true })) {
      return true;
    }
  }
  return false;
}
