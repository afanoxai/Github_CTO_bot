// Read-only GitHub operations the agent's tools rely on (list files, read a file, resolve the
// default branch). Write operations (branches, commits, PRs, issues) will join this layer in
// Layer C. Every function gates on the allow-list first (assertRepoAllowed). Logic preserved
// from v1/v2's proven implementations.

import { octokit, assertRepoAllowed } from "./client.js";
import { repoKey, type RepoRef } from "../types/index.js";

// A repo's default branch doesn't change mid-request and this is called several times per turn,
// so memoise per repo. On serverless that cache is effectively per-invocation.
const defaultBranchCache = new Map<string, string>();

export async function getDefaultBranch(repo: RepoRef): Promise<string> {
  assertRepoAllowed(repo);
  const key = repoKey(repo);
  const cached = defaultBranchCache.get(key);
  if (cached) return cached;
  const { data } = await octokit.rest.repos.get({ owner: repo.owner, repo: repo.repo });
  defaultBranchCache.set(key, data.default_branch);
  return data.default_branch;
}

/** Every file path in the repo at `ref` (capped), so the agent can ground itself in real structure. */
export async function listFiles(repo: RepoRef, ref: string): Promise<string[]> {
  assertRepoAllowed(repo);
  try {
    const { data: tree } = await octokit.rest.git.getTree({
      owner: repo.owner,
      repo: repo.repo,
      tree_sha: ref,
      recursive: "true",
    });
    return tree.tree
      .filter((e): e is typeof e & { path: string } => e.type === "blob" && typeof e.path === "string")
      .map((e) => e.path)
      .slice(0, 300);
  } catch (err) {
    if ((err as { status?: number }).status === 409) {
      return []; // empty repo, no commits yet
    }
    throw err;
  }
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  createdAt: string;
  url: string;
  body: string;
}

// Keep issue bodies from flooding the model's context.
const MAX_ISSUE_BODY_CHARS = 500;

/**
 * Recent issues on `repo`, newest first. GitHub's issues API also returns pull requests (a PR is an
 * issue under the hood), so those are filtered out - callers asking for "issues" mean real issues.
 */
export async function listIssues(
  repo: RepoRef,
  state: "open" | "closed" | "all",
  limit: number
): Promise<IssueSummary[]> {
  assertRepoAllowed(repo);
  const { data } = await octokit.rest.issues.listForRepo({
    owner: repo.owner,
    repo: repo.repo,
    state,
    sort: "created",
    direction: "desc",
    per_page: Math.min(Math.max(limit, 1), 30),
  });
  return data
    .filter((item) => !item.pull_request)
    .map((item) => {
      const body = item.body ?? "";
      return {
        number: item.number,
        title: item.title,
        state: item.state,
        author: item.user?.login ?? "unknown",
        createdAt: item.created_at,
        url: item.html_url,
        body:
          body.length > MAX_ISSUE_BODY_CHARS
            ? `${body.slice(0, MAX_ISSUE_BODY_CHARS)}\n...[truncated ${body.length - MAX_ISSUE_BODY_CHARS} chars]`
            : body,
      };
    });
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  createdAt: string;
  url: string;
  headBranch: string;
  baseBranch: string;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  merged: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PullRequestFile[];
}

// Keep a PR review from flooding the model's context: cap per-file diff and total diff text.
const MAX_PR_BODY_CHARS = 1_000;
const MAX_PATCH_CHARS = 6_000;
const MAX_TOTAL_PATCH_CHARS = 25_000;

/**
 * Recent pull requests on `repo`, newest first. Unlike `listIssues` this returns real PRs only
 * (the dedicated pulls endpoint), so no filtering is needed.
 */
export async function listPullRequests(
  repo: RepoRef,
  state: "open" | "closed" | "all",
  limit: number
): Promise<PullRequestSummary[]> {
  assertRepoAllowed(repo);
  const { data } = await octokit.rest.pulls.list({
    owner: repo.owner,
    repo: repo.repo,
    state,
    sort: "created",
    direction: "desc",
    per_page: Math.min(Math.max(limit, 1), 30),
  });
  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    author: pr.user?.login ?? "unknown",
    createdAt: pr.created_at,
    url: pr.html_url,
    headBranch: pr.head.ref,
    baseBranch: pr.base.ref,
  }));
}

/**
 * One pull request's metadata plus its changed files with diffs (patches), so the agent can review
 * the actual code change, not just the description. Diffs are capped per file and in total to keep
 * the model's context bounded. Returns null if the PR doesn't exist.
 */
export async function getPullRequestDetail(repo: RepoRef, number: number): Promise<PullRequestDetail | null> {
  assertRepoAllowed(repo);
  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
    const { data: fileList } = await octokit.rest.pulls.listFiles({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      per_page: 100,
    });

    let totalPatch = 0;
    const files: PullRequestFile[] = fileList.map((f) => {
      let patch = f.patch ?? "";
      if (patch.length > MAX_PATCH_CHARS) {
        patch = `${patch.slice(0, MAX_PATCH_CHARS)}\n...[truncated ${patch.length - MAX_PATCH_CHARS} chars]`;
      }
      if (totalPatch + patch.length > MAX_TOTAL_PATCH_CHARS) {
        patch = "[diff omitted: total size cap reached - read this file directly with read_repo if needed]";
      } else {
        totalPatch += patch.length;
      }
      return { path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch };
    });

    const body = pr.body ?? "";
    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: pr.user?.login ?? "unknown",
      createdAt: pr.created_at,
      url: pr.html_url,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      body:
        body.length > MAX_PR_BODY_CHARS
          ? `${body.slice(0, MAX_PR_BODY_CHARS)}\n...[truncated ${body.length - MAX_PR_BODY_CHARS} chars]`
          : body,
      merged: pr.merged ?? false,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      files,
    };
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return null;
    }
    throw err;
  }
}

/** A file's decoded content + blob sha at `ref`, or null if it doesn't exist there. */
export async function readFile(
  repo: RepoRef,
  path: string,
  ref: string
): Promise<{ content: string; sha: string } | null> {
  assertRepoAllowed(repo);
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: repo.owner, repo: repo.repo, path, ref });
    if (!Array.isArray(data) && data.type === "file" && data.content) {
      return { content: Buffer.from(data.content, "base64").toString("utf-8"), sha: data.sha };
    }
    return null;
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return null;
    }
    throw err;
  }
}
