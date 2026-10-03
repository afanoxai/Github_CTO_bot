// Small, pure path checks (CLAUDE_agent_v3.md Section 12: "Pure utility functions ...
// no side effects, easy to reason about"). Kept out of the GitHub layer so the rule can
// be unit-tested and reused wherever a model-produced path must be validated.

/**
 * True if `path` is a safe, repository-relative path to act on. Rejects absolute paths
 * (leading "/") and any ".." segment, so a model-produced path can't escape the repo
 * root. This is the v1/v2 `isSafeRepoPath` rule, preserved (CLAUDE_agent_v3.md Section 5).
 */
export function isSafeRepoPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("..");
}

/**
 * True if `name` is a valid GitHub repository name: only ASCII letters, digits, ".", "-" and "_",
 * at most 100 chars, and not the special "." / ".." names. GitHub itself enforces this, but we
 * validate a model-produced name up front so an invalid one is a clear tool error, not a raw API
 * 422. (Owner/visibility are fixed by config and tool default - only the name is model-chosen.)
 */
export function isValidRepoName(name: string): boolean {
  return name.length > 0 && name.length <= 100 && name !== "." && name !== ".." && /^[A-Za-z0-9._-]+$/.test(name);
}
