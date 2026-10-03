// The create_repository tool: creates a new GitHub repository under the token owner's account.
// This capability was explicitly, separately decided by the project owner (CLAUDE_agent_v3.md
// Section 9 defers repo-creation "unless separately, explicitly decided"). Guardrails: the name is
// validated before the call; repos default to PRIVATE (the model must explicitly ask for public);
// and the created repo is NOT added to the write allow-list, so the agent cannot commit into it
// until a human adds it to the allow-list and redeploys (see github/writes.ts createRepository).

import { createRepository } from "../../github/writes.js";
import { isValidRepoName } from "../../utils/paths.js";
import type { AgentTool } from "./types.js";

export function createCreateRepoTool(): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "create_repository",
        description:
          "Create a new GitHub repository under the account you operate as. Use this when the person " +
          "wants a brand-new repository. New repositories are PRIVATE unless the person explicitly " +
          "asks for a public one. Note: you cannot commit code into a repository you create until it " +
          "is added to your allowed-repository list - tell the person this if they expect to build in it.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Repository name: letters, digits, '.', '-', '_' only (no spaces or slashes).",
            },
            description: {
              type: "string",
              description: "Short description of the repository (optional).",
            },
            visibility: {
              type: "string",
              enum: ["private", "public"],
              description: "Repository visibility. Defaults to 'private'; only use 'public' if explicitly requested.",
            },
            initialize_with_readme: {
              type: "boolean",
              description: "Whether to create an initial commit with a README (gives the repo a default branch). Defaults to true.",
            },
          },
          required: ["name"],
        },
      },
    },

    async execute(argsJson: string): Promise<string> {
      let name = "";
      let description: string | undefined;
      let isPrivate = true; // default private, per the decided design
      let autoInit = true;
      try {
        const parsed = JSON.parse(argsJson || "{}");
        if (typeof parsed.name === "string") name = parsed.name.trim();
        if (typeof parsed.description === "string") description = parsed.description;
        if (parsed.visibility === "public") isPrivate = false;
        else if (parsed.visibility === "private") isPrivate = true;
        if (typeof parsed.initialize_with_readme === "boolean") autoInit = parsed.initialize_with_readme;
      } catch {
        return JSON.stringify({ error: "arguments were not valid JSON" });
      }

      if (!isValidRepoName(name)) {
        return JSON.stringify({
          error: `"${name}" is not a valid repository name (use only letters, digits, '.', '-', '_'; max 100 chars)`,
        });
      }

      const repo = await createRepository(name, { description, isPrivate, autoInit });
      return JSON.stringify({
        ok: true,
        repo: repo.fullName,
        url: repo.url,
        private: repo.isPrivate,
        default_branch: repo.defaultBranch,
        note: "This repository is not yet on your allowed-repository list, so you cannot commit into it until a human adds it and redeploys.",
      });
    },
  };
}
