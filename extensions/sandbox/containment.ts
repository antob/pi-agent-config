import { realpath } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";

/**
 * Resolve a path to its real location, handling symlinks.
 * For non-existent paths (e.g. write targets), walks up to the
 * nearest existing parent and resolves from there.
 * Falls back to path.resolve() if nothing resolves.
 */
async function resolveReal(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    // Path doesn't exist — walk up to find the nearest existing parent
    let current = dirname(targetPath);
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      try {
        const resolvedParent = await realpath(current);
        // Re-append the relative suffix under the resolved parent
        const suffix = targetPath.slice(current.length);
        return resolvedParent + suffix;
      } catch {
        const parent = dirname(current);
        if (parent === current) break; // reached filesystem root
        current = parent;
      }
    }
    // Nothing resolved — fall back to plain resolve
    return resolve(targetPath);
  }
}

/**
 * Check if a target path is inside the given boundary.
 *
 * Resolves symlinks on both boundary and target.
 * Returns true if the resolved target starts with the resolved boundary.
 */
export async function isInsideBoundary(
  boundary: string,
  targetPath: string,
  cwd: string,
): Promise<boolean> {
  // Expand leading ~ to the home directory (path.resolve does not do this)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
  const expandedTarget = targetPath.startsWith("~/")
    ? home + targetPath.slice(1)
    : targetPath === "~"
      ? home
      : targetPath;

  // Resolve relative paths against cwd
  const absoluteTarget = resolve(cwd, expandedTarget);

  // Resolve symlinks
  const resolvedBoundary = await resolveReal(boundary);
  const resolvedTarget = await resolveReal(absoluteTarget);

  // Normalize: ensure boundary ends with separator for prefix check
  const boundaryPrefix = resolvedBoundary.endsWith(sep)
    ? resolvedBoundary
    : resolvedBoundary + sep;

  // Target is inside if it equals the boundary or starts with boundary + sep
  return (
    resolvedTarget === resolvedBoundary ||
    resolvedTarget.startsWith(boundaryPrefix)
  );
}
