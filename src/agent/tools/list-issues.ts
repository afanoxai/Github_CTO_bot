// The list_issues read-only tool: returns recent issues on a repository the agent names, newest
// first, so the agent can answer questions like "what was the last issue raised?" or summarise
// open issues. Resolves the repo against the allow-list and refuses anything off-list, same as the
// other tools (Layer E). Read-only - it never changes anything, so it carries no write-safety risk.

import { listIssues } from "../../github/repos.js";
import { resolveAllowedRepo, allowedRepos } from "../../github/client.js";
import { repoKey } from "../../types/index.js";
import type { AgentTool } from "./types.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

export function createListIssuesTool(): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_issues",
        description:
          "List recent issues on a repository you are allowed to use, newest first. Use this to " +
          "answer questions about issues - e.g. the most recently raised issue (the first result), " +
          "or a summary of open issues. Pull requests are not included.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Which repository to read issues from, as 'owner/repo' (must be one you are allowed to use).",
            },
            state: {
              type: "string",
              enum: ["open", "closed", "all"],
              description: "Which issues to return. Defaults to 'open'.",
            },
            limit: {
              type: "number",
              description: `How many issues to return, newest first (1-${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
            },
          },
          required: ["repo"],
        },
      },
    },

    async execute(argsJson: string): Promise<string> {
      let repoName = "";
      let state: "open" | "closed" | "all" = "open";
      let limit = DEFAULT_LIMIT;
      try {
        const parsed = JSON.parse(argsJson || "{}");
        if (typeof parsed.repo === "string") repoName = parsed.repo;
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

      const issues = await listIssues(repo, state, limit);
      return JSON.stringify({ repo: repoKey(repo), state, count: issues.length, issues });
    },
  };
}
