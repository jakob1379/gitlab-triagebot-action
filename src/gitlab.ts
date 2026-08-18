/**
 * Everything the handlers need from GitLab, backed by the `glab` CLI.
 *
 * This is the only forge module. The bot ran on GitHub Actions once and kept a
 * backend-selecting indirection for it; that is gone, and upstream
 * withastro/triagebot-action is where the GitHub Action lives.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { type GitResult, push, redactRemote } from './git.ts';

const execFileAsync = promisify(execFileCb);

// ---------- Shared result types ----------
//
// These describe what the handlers consume. Field names read GitHub-ish
// (`body`, `login`) because that is the shape the prompts and skills were
// written against; the mapping from GitLab's own field names happens in
// fetchIssueDetails below.

export const issueDetailsSchema = v.object({
	title: v.string(),
	body: v.string(),
	author: v.object({ login: v.string() }),
	labels: v.array(v.looseObject({ name: v.string() })),
	createdAt: v.string(),
	state: v.string(),
	number: v.number(),
	url: v.string(),
	comments: v.array(
		v.looseObject({
			author: v.object({ login: v.string() }),
			authorAssociation: v.string(),
			body: v.string(),
			createdAt: v.string(),
		}),
	),
});
export type IssueDetails = v.InferOutput<typeof issueDetailsSchema>;

export const repoLabelSchema = v.object({
	name: v.string(),
	description: v.nullable(v.string()),
});
export type RepoLabel = v.InferOutput<typeof repoLabelSchema>;

/** A merge request, under the name the handlers and prompts use. */
export interface PullRequest {
	number: number;
	html_url: string;
}

/** Branch fix MRs target. GitLab projects are not all called "main". */
export const defaultBranch = process.env.CI_DEFAULT_BRANCH || 'main';

/** The GitLab instance this job is running against. */
function serverUrl(): string {
	// CI_SERVER_URL, not CI_SERVER_HOST: the latter is host-only, so a
	// self-hosted instance on http or a non-default port would be unreachable.
	return process.env.CI_SERVER_URL || 'https://gitlab.com';
}

/** Link a fix branch back to GitLab's compare view. */
export function compareUrl(repo: string, branch: string): string {
	return `${serverUrl()}/${repo}/-/compare/${defaultBranch}...${encodeURIComponent(branch)}`;
}

/**
 * GitLab credentials for the triage agent's sandbox. The skills shell out to
 * `glab`, and flue's local() sandbox only passes through the env it is handed,
 * so without this the agent's CLI calls run unauthenticated.
 */
export function agentEnv(readToken: string): Record<string, string | undefined> {
	return { GITLAB_TOKEN: readToken, GITLAB_HOST: process.env.CI_SERVER_URL };
}

/** Partition project labels into the two groups the triage prompt offers. */
export function splitRepoLabels(allLabels: RepoLabel[]): {
	priorityLabels: RepoLabel[];
	packageLabels: RepoLabel[];
} {
	return {
		priorityLabels: allLabels.filter((l) => /^- P\d/.test(l.name)),
		packageLabels: allLabels.filter((l) => l.name.startsWith('pkg:')),
	};
}

/**
 * Run glab with an explicit token, so read and write credentials stay
 * separated. The token goes through
 * the environment rather than argv, so it never lands in a process listing or
 * in the error message below.
 */
async function glab(args: string[], token: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync('glab', args, {
			env: { ...process.env, GITLAB_TOKEN: token },
			maxBuffer: 32 * 1024 * 1024,
		});
		return stdout;
	} catch (err: any) {
		throw new Error(
			`glab ${args.join(' ')} failed (exit ${err.code ?? 1}): ${err.stderr || err.message}`,
		);
	}
}

/**
 * Authenticated remote for git operations. The token lands in argv here, so
 * everything in git.ts redacts it back out before logging.
 */
function remoteUrl(repo: string, token: string): string {
	const url = new URL(`${serverUrl()}/${repo}.git`);
	url.username = 'oauth2';
	url.password = token;
	return url.toString();
}

/**
 * Username the token authenticates as. The bot must recognise its own
 * comments, and on GitLab a project access token posts as
 * `project_<id>_bot_<hash>` — a name nothing can hardcode.
 */
export async function currentUser(token: string): Promise<string | null> {
	try {
		return JSON.parse(await glab(['api', 'user'], token)).username ?? null;
	} catch {
		// Never block a triage run over this; worst case the bot re-reads its
		// own comment once and the router skips on the label instead.
		return null;
	}
}

/** `glab api --output ndjson` emits one JSON value per line, pages included. */
function parseNdjson(out: string): Record<string, any>[] {
	return out
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}

// ---------- Issues ----------

export async function fetchIssueDetails(
	repo: string,
	issueNumber: number,
	token: string,
): Promise<IssueDetails> {
	const [issueJson, notesJson] = await Promise.all([
		glab(['issue', 'view', String(issueNumber), '--output', 'json', '--repo', repo], token),
		// No glab subcommand lists issue notes — `issue note` only creates one —
		// so this read goes through the API passthrough.
		//
		// sort=asc: GitLab returns notes newest-first, and every caller here
		// assumes oldest-first — verify-fix reads the last entry as the reporter's
		// latest word.
		// --paginate: with sort=asc a single page would be the *oldest* 100, and
		// GitLab counts its system notes against that budget — so a busy issue
		// would lose exactly the recent comments verify-fix needs.
		// --output ndjson: --paginate writes one JSON array per page back to back,
		// which is not parseable as a whole. ndjson makes the page boundaries
		// invisible.
		glab(
			[
				'api',
				`projects/${encodeURIComponent(repo)}/issues/${issueNumber}/notes?per_page=100&sort=asc`,
				'--paginate',
				'--output',
				'ndjson',
			],
			token,
		),
	]);

	const issue = JSON.parse(issueJson) as Record<string, any>;
	const notes = parseNdjson(notesJson);

	return v.parse(issueDetailsSchema, {
		title: issue.title,
		body: issue.description ?? '',
		author: { login: issue.author?.username },
		labels: (issue.labels ?? []).map((name: string) => ({ name })),
		createdAt: issue.created_at,
		// Normalise to "open"; the handlers and prompts are written against that.
		state: issue.state === 'opened' ? 'open' : issue.state,
		number: issue.iid,
		url: issue.web_url,
		comments: notes
			// System notes are activity entries ("added ~bug label"), not
			// something a person wrote, so they are not conversation.
			.filter((n) => !n.system)
			.map((n) => ({
				author: { login: n.author?.username },
				// GitLab exposes no author-association equivalent on notes.
				authorAssociation: 'NONE',
				body: n.body ?? '',
				createdAt: n.created_at,
			})),
	});
}

// ---------- Labels ----------

export async function fetchRepoLabels(
	repo: string,
	token: string,
): Promise<{ priorityLabels: RepoLabel[]; packageLabels: RepoLabel[] }> {
	// --paginate walks every page for us; ndjson keeps it one object per line.
	const out = await glab(
		[
			'api',
			`projects/${encodeURIComponent(repo)}/labels?per_page=100`,
			'--paginate',
			'--output',
			'ndjson',
		],
		token,
	);
	const allLabels = parseNdjson(out).map((l) =>
		v.parse(repoLabelSchema, { name: l.name, description: l.description ?? null }),
	);

	return splitRepoLabels(allLabels);
}

export async function addLabels(
	repo: string,
	issueNumber: number,
	labels: string[],
	token: string,
): Promise<void> {
	if (labels.length === 0) return;
	await glab(
		['issue', 'update', String(issueNumber), '--label', labels.join(','), '--repo', repo],
		token,
	);
}

/**
 * Label a merge request. Separate from addLabels because merge requests carry
 * their own iid sequence — `glab issue update <mr iid>` would silently label an
 * unrelated issue.
 */
export async function addPullRequestLabels(
	repo: string,
	prNumber: number,
	labels: string[],
	token: string,
): Promise<void> {
	if (labels.length === 0) return;
	await glab(
		['mr', 'update', String(prNumber), '--label', labels.join(','), '--repo', repo],
		token,
	);
}

export async function removeLabel(
	repo: string,
	issueNumber: number,
	label: string,
	token: string,
): Promise<void> {
	await glab(['issue', 'update', String(issueNumber), '--unlabel', label, '--repo', repo], token);
}

/**
 * Swap one triage label for another. One request, so the issue is never briefly
 * left with neither label.
 */
export async function swapLabel(
	repo: string,
	issueNumber: number,
	oldLabel: string | null,
	newLabel: string,
	token: string,
): Promise<void> {
	const args = ['issue', 'update', String(issueNumber), '--label', newLabel];
	if (oldLabel) args.push('--unlabel', oldLabel);
	await glab([...args, '--repo', repo], token);
}

// ---------- Comments ----------

export async function postComment(
	repo: string,
	issueNumber: number,
	body: string,
	token: string,
): Promise<void> {
	await glab(['issue', 'note', String(issueNumber), '--message', body, '--repo', repo], token);
}

// ---------- Merge requests ----------

export async function findPullRequest(
	repo: string,
	head: string,
	token: string,
): Promise<PullRequest | null> {
	const out = await glab(
		['mr', 'list', '--source-branch', head, '--output', 'json', '--repo', repo],
		token,
	);
	const mrs = JSON.parse(out);
	if (!Array.isArray(mrs) || mrs.length === 0) return null;
	return { number: mrs[0].iid, html_url: mrs[0].web_url };
}

export async function createPullRequest(
	repo: string,
	options: { head: string; base: string; title: string; body: string },
	token: string,
): Promise<PullRequest> {
	await glab(
		[
			'mr',
			'create',
			'--source-branch',
			options.head,
			'--target-branch',
			options.base,
			'--title',
			options.title,
			'--description',
			options.body,
			'--no-editor',
			'--yes',
			'--repo',
			repo,
		],
		token,
	);
	// `mr create` prints a URL rather than JSON, so read the MR back instead of
	// scraping stdout.
	const mr = await findPullRequest(repo, options.head, token);
	if (!mr) {
		throw new Error(`Created merge request for ${options.head} but could not read it back`);
	}
	return mr;
}

// ---------- Branches ----------

/** One ls-remote for every candidate; GitLab has no branch subcommand. */
export async function findBranch(
	repo: string,
	branches: string[],
	token: string,
): Promise<string | null> {
	const url = remoteUrl(repo, token);
	try {
		const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', url, ...branches]);
		return branches.find((b) => stdout.includes(`refs/heads/${b}`)) ?? null;
	} catch (err: any) {
		throw new Error(redactRemote(err.stderr || err.message));
	}
}

export async function deleteBranch(repo: string, branch: string, token: string): Promise<void> {
	try {
		await execFileAsync('git', ['push', remoteUrl(repo, token), '--delete', branch]);
	} catch (err: any) {
		// A branch that is already gone is not an error.
		if (!/remote ref does not exist/i.test(err.stderr ?? '')) {
			throw new Error(redactRemote(err.stderr || err.message));
		}
	}
}

export function gitPush(
	repo: string,
	branch: string,
	token: string,
	options?: { force?: boolean },
): Promise<GitResult> {
	return push(remoteUrl(repo, token), branch, options);
}
