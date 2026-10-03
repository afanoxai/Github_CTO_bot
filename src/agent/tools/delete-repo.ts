// The delete_repository tool: permanently deletes a repository. This is the agent's ONLY
// irreversible action, so it is the most tightly fenced one. Two independent gates must both pass
// before anything is deleted:
//   1. The repo must be on the human-curated ALLOWED_DELETABLE_REPOS list (empty by default, which
//      turns the capability off entirely). The model naming a repo can never substitute for that
//      list - the same principle as assertRepoAllowed for reads/writes. On top of that,
//      deleteRepository -> assertRepoDeletable refuses any repo that is on the work allow-list or
//      is the playground, so a valuable repo cannot be removed even if it was mistakenly listed.
//   2. The model must set confirm=true, which its instructions only permit after the person has
//      asked for that exact deletion in unmistakable terms in the current turn. A missing confirm
//      is refused, so an ambiguous "clean up the test stuff" can't silently delete something.
// Expected refusals (off-list, or missing confirm) are returned as error-shaped results, never
// thrown.

import { deleteRepository } from "../../github/writes.js";
import { resolveDeletableRepo, allowedDeletableRepos } from "../../github/client.js";
import type { AgentTool } from "./types.js";

export function createDeleteRepoTool(): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "delete_repository",
        description:
          "Permanently DELETE a repository. Irreversible - the repository and its entire history are " +
          "gone. Only repositories a human has explicitly marked deletable can be deleted; any other " +
          "name is refused. Set confirm=true ONLY after the person has asked for this exact deletion " +
          "in unambiguous terms in the current turn. Never delete as a guess, a cleanup, or because a " +
          "repo merely looks unused.",
        parameters: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              description: "Repository to delete, as 'owner/repo' (must be on the deletable list).",
            },
            confirm: {
              type: "boolean",
              description:
                "Must be true. Set it only when the person has explicitly asked to delete this exact repository.",
            },
          },
          required: ["repo", "confirm"],
        },
      },
    },

    async execute(argsJson: string): Promise<string> {
      let repoName = "";
      let confirm = false;
      try {
        const parsed = JSON.parse(argsJson || "{}");
        if (typeof parsed.repo === "string") repoName = parsed.repo;
        confirm = parsed.confirm === true;
      } catch {
        return JSON.stringify({ error: "arguments were not valid JSON" });
      }

      const repo = resolveDeletableRepo(repoName);
      if (!repo) {
        return JSON.stringify({
          error:
            `"${repoName}" is not on the deletable list, so it will not be deleted. ` +
            `Repos a human has marked deletable: ${allowedDeletableRepos().join(", ") || "(none)"}. ` +
            `Deletion requires a human to add the repo to ALLOWED_DELETABLE_REPOS and redeploy.`,
        });
      }
      if (!confirm) {
        return JSON.stringify({
          error:
            "refusing to delete without confirm=true - ask the person to confirm this exact deletion, " +
            "then call again with confirm set.",
        });
      }

      // deleteRepository re-checks the fence (assertRepoDeletable) and may refuse a repo that is
      // also on the work allow-list; surface that as an error result rather than throwing.
      try {
        const result = await deleteRepository(repo);
        return JSON.stringify({ ok: true, deleted: result.fullName, irreversible: true });
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message });
      }
    },
  };
}
