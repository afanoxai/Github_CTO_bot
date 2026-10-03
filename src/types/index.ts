// Shared TypeScript types for v3. One place for the shapes that cross module
// boundaries (config, github, llm, memory), so a change to a shape is a change
// in exactly one file. Keep this to *shared* types only - a type used by a
// single module lives next to that module, not here.

/** A GitHub repository, split into its owner and name halves. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** "owner/repo" - the canonical string key for a RepoRef (allow-list lookups, logs). */
export function repoKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/** One file's full new content, destined for a commit. The unit both the agent and the GitHub
 *  write layer speak in (never a diff - always the complete file). */
export interface FileChange {
  path: string;
  content: string;
}
