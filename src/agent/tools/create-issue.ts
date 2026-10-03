// The create_issue tool: files a GitHub issue on a repository the agent names (Layer E). Resolves
// the repo against the allow-list and refuses anything off-list. Chosen from plain language - no
// keyword routing (CLAUDE_agent_v3.md Layer C).

import { createIssue } from "../../github/writes.js";
import { resolveAllowedRepo, allowedRepos } from "../../github/client.js";
import type { AgentTool } from "./types.js";

export function createCreateIssueTool(): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "create_issue",
        description:
          "File a GitHub issue on one of the repositories you are allowed to use. Use this when the " +
          "person wants a bug, task, or idea tracked - not when they want an actual code change " +
          "(open a pull request for that).",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Target repository as 'owner/repo' (must be allowed)." },
            title: { type: "string", description: "Short issue title." },
            body: { type: "string", description: "Fuller description of the issue." },
          },
          required: ["repo", "title", "body"],
        },
      },
    },

    async execute(argsJson: string): Promise<string> {
      let repoName = "";
      let title = "";
      let body = "";
      try {
        const parsed = JSON.parse(argsJson || "{}");
        if (typeof parsed.repo === "string") repoName = parsed.repo;
        if (typeof parsed.title === "string") title = parsed.title.trim();
        if (typeof parsed.body === "string") body = parsed.body;
      } catch {
        return JSON.stringify({ error: "arguments were not valid JSON" });
      }

      const repo = resolveAllowedRepo(repoName);
      if (!repo) {
        return JSON.stringify({
          error: `"${repoName}" is not a repository you may use. Allowed: ${allowedRepos().join(", ")}`,
        });
      }
      if (!title) {
        return JSON.stringify({ error: "a non-empty title is required" });
      }

      const issue = await createIssue(repo, title, body);
      return JSON.stringify({ ok: true, issue_number: issue.number, url: issue.url });
    },
  };
}
