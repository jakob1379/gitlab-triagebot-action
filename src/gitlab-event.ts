/**
 * Adapter for GitLab webhook payloads.
 *
 * A project webhook POSTs straight at the pipeline trigger endpoint and GitLab
 * hands the body to the job as $TRIGGER_PAYLOAD. That body is GitLab-shaped, so
 * translate it into the event the router already understands.
 *
 * Only the fields the router reads are mapped. Anything unrecognised comes back
 * with an action the router does not handle, which it turns into a skip.
 */

import type { GitHubEvent } from './router.ts';

/** GitLab issue actions -> the GitHub action names the router matches on. */
const ISSUE_ACTIONS: Record<string, string> = {
	open: 'opened',
	reopen: 'reopened',
	close: 'closed',
};

/** Webhook label objects; GitLab always sends `title`, never `name`. */
function titles(labels: { title?: string }[] | undefined): string[] {
	return (labels ?? []).map((l) => l.title).filter((t): t is string => !!t);
}

/**
 * Returns null when the payload carries no issue at all (a comment on a
 * snippet or a commit), meaning there is nothing for the bot to act on.
 */
export function parseGitLabEvent(payload: any, botLogins: string[]): GitHubEvent | null {
	const attrs = payload?.object_attributes ?? {};

	if (payload?.object_kind === 'issue') {
		return {
			action: ISSUE_ACTIONS[attrs.action] ?? attrs.action ?? 'unknown',
			isPullRequest: false,
			issueNumber: attrs.iid,
			issueLabels: titles(payload.labels ?? attrs.labels),
			botLogins,
		};
	}

	if (payload?.object_kind === 'note') {
		// Comments on merge requests, snippets and commits have no issue to act
		// on, so they drop out here rather than being routed and skipped.
		if (attrs.noteable_type !== 'Issue' || !payload.issue) return null;
		return {
			// GitLab notes are "create" or "update"; only new comments trigger,
			// matching the GitHub workflow's issue_comment: [created].
			action: attrs.action === 'create' ? 'created' : (attrs.action ?? 'unknown'),
			isPullRequest: false,
			issueNumber: payload.issue.iid,
			issueLabels: titles(payload.issue.labels),
			commentAuthor: payload.user?.username,
			botLogins,
		};
	}

	return null;
}
