// The read-only grounding tool. The agent names which allowed repository to read (Layer E); the
// tool resolves that name against the allow-list and refuses anything off-list before touching
// GitHub. Two modes: no paths -> list files; paths -> return those files' contents.

import { getDefaultBranch, listFiles, readFile } from "../../github/repos.js";
import { resolveAllowedRepo, allowedRepos } from "../../github/client.js";
import { isSafeRepoPath } from "../../utils/paths.js";
import { repoKey } from "../../types/index.js";
import type { AgentTool } from "./types.js";

// Keep tool results from blowing up the model's context: cap per-file and total returned text.
const MAX_FILE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 30_000;

export function createReadRepoTool(): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_repo",
        description:
          "Read a repository you are allowed to work with. Call with only 'repo' (and no 'paths') to " +
          "list its files; add 'paths' to get the full contents of specific files. Always read the " +
          "relevant files before describing or changing code.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Which repository to read, as 'owner/repo' (must be one you are allowed to use).",
            },
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Repository-relative file paths to read. Omit to list all files instead.",
            },
          },
          required: ["repo"],
        },
      },
    },

    async execute(argsJson: string): Promise<string> {
      let repoName = "";
      let paths: string[] = [];
      try {
        const parsed = JSON.parse(argsJson || "{}");
        if (typeof parsed.repo === "string") repoName = parsed.repo;
        if (Array.isArray(parsed.paths)) {
          paths = parsed.paths.filter((p: unknown): p is string => typeof p === "string");
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

      const ref = await getDefaultBranch(repo);

      // Mode 1: list files.
      if (paths.length === 0) {
        const files = await listFiles(repo, ref);
        return JSON.stringify({ repo: repoKey(repo), branch: ref, files });
      }

      // Mode 2: read requested files, validating each path and honoring the size caps.
      const results: Array<{ path: string; content?: string; error?: string }> = [];
      let total = 0;
      for (const path of paths) {
        if (!isSafeRepoPath(path)) {
          results.push({ path, error: "rejected: path must be repository-relative (no leading / or ..)" });
          continue;
        }
        const file = await readFile(repo, path, ref);
        if (!file) {
          results.push({ path, error: "not found" });
          continue;
        }
        let content = file.content;
        if (content.length > MAX_FILE_CHARS) {
          content = `${content.slice(0, MAX_FILE_CHARS)}\n...[truncated ${content.length - MAX_FILE_CHARS} chars]`;
        }
        if (total + content.length > MAX_TOTAL_CHARS) {
          results.push({ path, error: "skipped: total size cap reached, request fewer files" });
          continue;
        }
        total += content.length;
        results.push({ path, content });
      }
      return JSON.stringify({ repo: repoKey(repo), branch: ref, files: results });
    },
  };
}
