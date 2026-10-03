// The open_pull_request tool: the agent's only way to change repository code, on a repo it names
// (Layer E), and always a proposal - never a direct write (CLAUDE_agent_v3.md Section 5). Resolves
// the repo against the allow-list, validates every file path, then opens a PR from a fresh branch
// into the default branch for a human to merge.

import { openPullRequestWithFiles } from "../../github/writes.js";
import { resolveAllowedRepo, allowedRepos } from "../../github/client.js";
import { isSafeRepoPath } from "../../utils/paths.js";
import type { FileChange } from "../../types/index.js";
import type { AgentTool } from "./types.js";

// Matches the per-request file cap the rest of the system assumes; keeps a single PR reviewable.
const MAX_FILES_PER_PR = 8;

export function createOpenPrTool(): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "open_pull_request",
        description:
          "Open a pull request proposing a code change to one of the repositories you are allowed to " +
          "use. Provide the COMPLETE new content of each file (not a diff) - read the repo first so " +
          "edits preserve existing content. A human reviews and merges; it is never applied directly.",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Target repository as 'owner/repo' (must be allowed)." },
            title: { type: "string", description: "Pull request title (also the commit message)." },
            body: { type: "string", description: "What the PR changes and why, for the reviewer." },
            files: {
              type: "array",
              description: "The files to create or overwrite, each with its full new content.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", description: "Repository-relative path (no leading / or ..)." },
                  content: { type: "string", description: "The complete new content of the file." },
                },
                required: ["path", "content"],
              },
            },
          },
          required: ["repo", "title", "body", "files"],
        },
      },
    },

    async execute(argsJson: string): Promise<string> {
      let repoName = "";
      let title = "";
      let body = "";
      let rawFiles: unknown = [];
      try {
        const parsed = JSON.parse(argsJson || "{}");
        if (typeof parsed.repo === "string") repoName = parsed.repo;
        if (typeof parsed.title === "string") title = parsed.title.trim();
        if (typeof parsed.body === "string") body = parsed.body;
        rawFiles = parsed.files;
      } catch {
        return JSON.stringify({ error: "arguments were not valid JSON" });
      }

      const repo = resolveAllowedRepo(repoName);
      if (!repo) {
        return JSON.stringify({
          error: `"${repoName}" is not a repository you may use. Allowed: ${allowedRepos().join(", ")}`,
        });
      }
      if (!title) return JSON.stringify({ error: "a non-empty title is required" });
      if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
        return JSON.stringify({ error: "at least one file (with path and content) is required" });
      }
      if (rawFiles.length > MAX_FILES_PER_PR) {
        return JSON.stringify({
          error: `too many files (${rawFiles.length}); keep a PR to at most ${MAX_FILES_PER_PR} files`,
        });
      }

      // Validate every file the model produced before touching GitHub.
      const files: FileChange[] = [];
      for (const f of rawFiles) {
        if (typeof f !== "object" || f === null) {
          return JSON.stringify({ error: "each file must be an object with path and content" });
        }
        const { path, content } = f as { path?: unknown; content?: unknown };
        if (typeof path !== "string" || !isSafeRepoPath(path)) {
          return JSON.stringify({ error: `unsafe or missing path: ${JSON.stringify(path)} (must be repository-relative, no leading / or ..)` });
        }
        if (typeof content !== "string" || content.length === 0) {
          return JSON.stringify({ error: `file ${path} has no content` });
        }
        files.push({ path, content });
      }

      const pr = await openPullRequestWithFiles(repo, { title, body: body || title, files });
      return JSON.stringify({ ok: true, pr_number: pr.number, url: pr.url, branch: pr.branch });
    },
  };
}
