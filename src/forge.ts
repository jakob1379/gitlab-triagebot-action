/**
 * Selects the forge backend. GitLab CI always sets GITLAB_CI=true; anything
 * else is treated as GitHub Actions.
 *
 * Both modules export the same names with the same signatures, so handlers
 * import from here and never care which forge they are talking to.
 */

import * as github from './github.ts';
import * as gitlab from './gitlab.ts';

export const isGitLab = process.env.GITLAB_CI === 'true';

export const {
	addLabels,
	addPullRequestLabels,
	createPullRequest,
	deleteBranch,
	fetchIssueDetails,
	fetchRepoLabels,
	findBranch,
	findPullRequest,
	gitPush,
	postComment,
	removeLabel,
	swapLabel,
} = isGitLab ? gitlab : github;

export { gitCommit } from './git.ts';
export type { IssueDetails, PullRequest, RepoLabel } from './github.ts';

/** Branch fix PRs target. GitLab projects are not all called "main". */
export const defaultBranch = process.env.CI_DEFAULT_BRANCH || 'main';

/**
 * Link a fix branch back to the forge's diff view. `gitlab` is a parameter so
 * both arms are reachable from one test process.
 */
export function compareUrl(repo: string, branch: string, gitlab = isGitLab): string {
	return gitlab
		? `${process.env.CI_SERVER_URL || 'https://gitlab.com'}/${repo}/-/compare/${defaultBranch}...${encodeURIComponent(branch)}`
		: `https://github.com/${repo}/compare/${branch}?expand=1`;
}

/**
 * Forge credentials for the triage agent's sandbox. The skills shell out to
 * `gh` or `glab`, and flue's local() sandbox only passes through the env it is
 * handed, so without this the agent's CLI calls run unauthenticated.
 */
export function agentEnv(readToken: string): Record<string, string | undefined> {
	return isGitLab
		? { GITLAB_TOKEN: readToken, GITLAB_HOST: process.env.CI_SERVER_URL }
		: { GH_TOKEN: readToken };
}
