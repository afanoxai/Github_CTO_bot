// The single GitHub boundary (CLAUDE_agent_v3.md Section 12: "All GitHub calls go through
// github/ ... nothing else talks to GitHub directly"). This module owns the Octokit
// instance and the repository allow-list. When GitHub misbehaves, this is where to look.

import { Octokit } from "@octokit/rest";
import { config } from "../config/env.js";
import { repoKey, type RepoRef } from "../types/index.js";

// Every octokit.rest.* call is small metadata/blob traffic; 30s comfortably catches a stuck
// socket (e.g. one left dead across a laptop sleep) instead of hanging forever. Preserved from v1.
const OCTOKIT_TIMEOUT_MS = 30_000;

export const octokit = new Octokit({ auth: config.github.pat });

// AbortSignal.timeout() fires once then stays aborted, so it must be a fresh signal per request.
// This hook applies that to every call site without touching each one. Preserved from v1.
octokit.hook.before("request", (options) => {
  options.request.signal = AbortSignal.timeout(OCTOKIT_TIMEOUT_MS);
});

// The explicit, named set of repositories the agent may touch: the playground plus the target
// allow-list (CLAUDE_agent_v3.md Section 5). Never org-wide, never a repo the model merely names.
// Deduped by key, since a repo can legitimately appear as both playground and a target.
const allowedRepoList: RepoRef[] = (() => {
  const seen = new Set<string>();
  const list: RepoRef[] = [];
  for (const repo of [config.github.playgroundRepo, ...config.github.targetRepos]) {
    const key = repoKey(repo).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      list.push(repo);
    }
  }
  return list;
})();

const allowedRepoKeys = new Set(allowedRepoList.map((r) => repoKey(r).toLowerCase()));

/** The list of repos the agent is allowed to act on, for messages and prompts. */
export function allowedRepos(): string[] {
  return allowedRepoList.map(repoKey);
}

/**
 * Gate every GitHub action behind the allow-list. Any code path that acts on a repo the model
 * chose MUST call this first, so an off-list repo name is refused rather than acted on
 * (CLAUDE_agent_v3.md Section 5: "The model choosing a target is not the same as the target
 * being safe.").
 */
export function assertRepoAllowed(repo: RepoRef): void {
  if (!allowedRepoKeys.has(repoKey(repo).toLowerCase())) {
    throw new Error(
      `Refusing to act on "${repoKey(repo)}" - it is not on the allowed repo list (${allowedRepos().join(", ")}).`
    );
  }
}

/**
 * Resolve a repo NAME the model produced (a full "owner/repo" or a bare repo name) to an allowed
 * RepoRef, or null if it isn't on the list. This is the validation gate for Layer E: the agent may
 * choose a repo, but only a name that resolves here is ever acted on. Case-insensitive.
 */
export function resolveAllowedRepo(name: string): RepoRef | null {
  const n = name.trim().toLowerCase();
  return (
    allowedRepoList.find((r) => repoKey(r).toLowerCase() === n || r.repo.toLowerCase() === n) ?? null
  );
}
