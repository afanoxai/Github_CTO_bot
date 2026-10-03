// GitHub write operations - the ONLY place the agent effects change on a repo. Every path here
// preserves the core safety boundary (CLAUDE_agent_v3.md Section 5): a change to a real repo lands
// as a pull request from a fresh branch into the default branch, for a human to review and merge.
// There is deliberately NO function that writes to a default branch directly and NO auto-merge.
// Logic (atomic Git Data API commit) preserved from v1/v2.

import { octokit, assertRepoAllowed } from "./client.js";
import { getDefaultBranch } from "./repos.js";
import { repoKey, type FileChange, type RepoRef } from "../types/index.js";

/**
 * Create a new repository under the authenticated token owner's account. This is the ONE write
 * path that does not call assertRepoAllowed - it can't, because the repo doesn't exist yet and so
 * isn't on any list. That is inherent to creation, not a hole: creating a fresh repo can't damage
 * an existing one, and the created repo is deliberately NOT added to the write allow-list, so the
 * agent still cannot commit into it until a human adds it to ALLOWED_TARGET_REPOS and redeploys
 * (CLAUDE_agent_v3.md Section 5 - the allow-list stays the boundary for writes). Defaults to a
 * PRIVATE repo; `isPrivate` must be set false explicitly to make a public one. `autoInit` creates
 * an initial commit so the repo has a default branch.
 */
export async function createRepository(
  name: string,
  opts: { description?: string; isPrivate: boolean; autoInit: boolean }
): Promise<{ fullName: string; url: string; isPrivate: boolean; defaultBranch: string }> {
  const { data } = await octokit.rest.repos.createForAuthenticatedUser({
    name,
    description: opts.description,
    private: opts.isPrivate,
    auto_init: opts.autoInit,
  });
  console.log(`[github] created repository ${data.full_name} (private=${data.private})`);
  return {
    fullName: data.full_name,
    url: data.html_url,
    isPrivate: data.private,
    defaultBranch: data.default_branch ?? "main",
  };
}

/** File an issue. Returns the created issue's number and URL. */
export async function createIssue(
  repo: RepoRef,
  title: string,
  body: string
): Promise<{ number: number; url: string }> {
  assertRepoAllowed(repo);
  const { data } = await octokit.rest.issues.create({ owner: repo.owner, repo: repo.repo, title, body });
  return { number: data.number, url: data.html_url };
}

// Build ONE atomic commit via the Git Data API (blobs in parallel, one tree, one commit, one ref
// update) - O(1) sequential round trips regardless of file count. Committed onto `branchName`,
// which must already exist. Preserved from v1/v2's commitFilesToBranch.
async function commitFiles(
  repo: RepoRef,
  branchName: string,
  files: FileChange[],
  message: string
): Promise<void> {
  assertRepoAllowed(repo);
  if (files.length === 0) return;

  const { data: ref } = await octokit.rest.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${branchName}` });
  const headSha = ref.object.sha;
  const { data: headCommit } = await octokit.rest.git.getCommit({ owner: repo.owner, repo: repo.repo, commit_sha: headSha });

  const blobs = await Promise.all(
    files.map(async ({ path, content }) => {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner: repo.owner,
        repo: repo.repo,
        content: Buffer.from(content, "utf-8").toString("base64"),
        encoding: "base64",
      });
      return { path, sha: blob.sha };
    })
  );

  const { data: tree } = await octokit.rest.git.createTree({
    owner: repo.owner,
    repo: repo.repo,
    base_tree: headCommit.tree.sha,
    tree: blobs.map(({ path, sha }) => ({ path, mode: "100644" as const, type: "blob" as const, sha })),
  });

  const { data: commit } = await octokit.rest.git.createCommit({
    owner: repo.owner,
    repo: repo.repo,
    message,
    tree: tree.sha,
    parents: [headSha],
  });

  await octokit.rest.git.updateRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${branchName}`, sha: commit.sha });
}

/**
 * Open a pull request that applies `files` to `repo`: creates a fresh branch off the default
 * branch, commits the files onto it, and opens a PR back into the default branch. A human reviews
 * and merges - this never touches the default branch directly. The branch name is generated here
 * (not model-chosen) so a tool input can't steer where the write lands.
 */
export async function openPullRequestWithFiles(
  repo: RepoRef,
  args: { title: string; body: string; files: FileChange[] }
): Promise<{ number: number; url: string; branch: string }> {
  assertRepoAllowed(repo);

  const base = await getDefaultBranch(repo);
  const { data: baseRef } = await octokit.rest.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${base}` });

  const branch = `agent/${Date.now()}`;
  await octokit.rest.git.createRef({
    owner: repo.owner,
    repo: repo.repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  });

  await commitFiles(repo, branch, args.files, args.title);

  const { data: pr } = await octokit.rest.pulls.create({
    owner: repo.owner,
    repo: repo.repo,
    title: args.title.slice(0, 250),
    head: branch,
    base,
    body: args.body,
  });

  console.log(`[github] opened PR #${pr.number} in ${repoKey(repo)} (branch ${branch})`);
  return { number: pr.number, url: pr.html_url, branch };
}
