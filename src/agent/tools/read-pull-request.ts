// The read_pull_request read-only tool: lets the agent find and inspect pull requests on a repo it
// is allowed to use, so it can review/quality-check an opened PR. Two modes, mirroring read_repo:
// no 'number' -> list recent PRs; with 'number' -> that PR's metadata plus its changed-file diffs.
// Resolves the repo against the allow-list and refuses anything off-list (Layer E). Read-only - it
// inspects a PR, it never approves, merges, or comments on it.

import { listPullRequests, getPullRequestDetail } from "../../github/repos.js";
import { resolveAllowedRepo, allowedRepos } from "../../github/client.js";
import { repoKey } from "../../types/index.js";
import type { AgentTool } from "./types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

export function createReadPullRequestTool(): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_pull_request",
        description:
          "Inspect pull requests on a repository you are allowed to use. Call with only 'repo' (no " +
          "'number') to list recent PRs newest-first; add 'number' to get that PR's description plus " +
          "the diffs of every changed file, so you can review the code and quality-check it. " +
          "Read-only: this never approves, merges, or comments on a PR.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Which repository, as 'owner/repo' (must be one you are allowed to use).",
            },
            number: {
              type: "number",
              description: "A specific PR number to inspect in full (with diffs). Omit to list recent PRs instead.",
            },
            state: {
              type: "string",
              enum: ["open", "closed", "all"],
              description: "When listing, which PRs to return. Defaults to 'open'.",
            },
            limit: {
              type: "number",
              description: `When listing, how many PRs to return, newest first (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
            },
          },
          required: ["repo"],
        },
      },
    },

    async execute(argsJson: string): Promise<string> {
      let repoName = "";
      let number: number | null = null;
      let state: "open" | "closed" | "all" = "open";
      let limit = DEFAULT_LIMIT;
      try {
        const parsed = JSON.parse(argsJson || "{}");
        if (typeof parsed.repo === "string") repoName = parsed.repo;
        if (typeof parsed.number === "number" && Number.isFinite(parsed.number)) {
          number = Math.trunc(parsed.number);
        }
        if (parsed.state === "open" || parsed.state === "closed" || parsed.state === "all") {
          state = parsed.state;
        }
        if (typeof parsed.limit === "number" && Number.isFinite(parsed.limit)) {
          limit = Math.min(Math.max(Math.trunc(parsed.limit), 1), MAX_LIMIT);
        }
      } catch {
        return JSON.stringify({ error: "arguments were not valid JSON" });
      }

      const repo = resolveAllowedRepo(repoName);
      if (!repo) {
        return JSON.stringify({
          error: `"${repoName}" is not a repository you may use. Allowed: ${allowedRepos().join(", ")}`,
        });
      }

      // Mode 1: inspect one PR in full (with diffs).
      if (number !== null) {
        const detail = await getPullRequestDetail(repo, number);
        if (!detail) {
          return JSON.stringify({ error: `no pull request #${number} found in ${repoKey(repo)}` });
        }
        return JSON.stringify({ repo: repoKey(repo), pull_request: detail });
      }

      // Mode 2: list recent PRs.
      const prs = await listPullRequests(repo, state, limit);
      return JSON.stringify({ repo: repoKey(repo), state, count: prs.length, pull_requests: prs });
    },
  };
}
