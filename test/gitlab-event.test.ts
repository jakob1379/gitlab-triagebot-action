import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGitLabEvent } from '../src/gitlab-event.ts';
import { labelConfigFromInputs } from '../src/labels.ts';
import { route } from '../src/router.ts';

const labels = labelConfigFromInputs(() => '');

const BOTS = ['triagebot'];

// Payload shapes follow the examples in
// https://docs.gitlab.com/user/project/integrations/webhook_events
function issueEvent(action: string, labels: string[] = []) {
	return {
		object_kind: 'issue',
		user: { username: 'reporter' },
		object_attributes: { iid: 23, action, labels: [] },
		labels: labels.map((title) => ({ id: 1, title, type: 'ProjectLabel' })),
	};
}

function noteEvent(noteableType: string, action = 'create', labels: string[] = []) {
	return {
		object_kind: 'note',
		user: { username: 'commenter' },
		object_attributes: { noteable_type: noteableType, note: 'Hello world', action },
		...(noteableType === 'Issue'
			? { issue: { iid: 17, labels: labels.map((title) => ({ id: 1, title })) } }
			: { merge_request: { iid: 4 } }),
	};
}

describe('parseGitLabEvent', () => {
	it('maps issue open/reopen/close to the router action names', () => {
		assert.equal(parseGitLabEvent(issueEvent('open'), BOTS)?.action, 'opened');
		assert.equal(parseGitLabEvent(issueEvent('reopen'), BOTS)?.action, 'reopened');
		assert.equal(parseGitLabEvent(issueEvent('close'), BOTS)?.action, 'closed');
	});

	it('leaves issue update unmapped so the router skips it', () => {
		// GitHub only fires on opened/reopened/closed; a label edit must not
		// re-trigger triage.
		assert.equal(parseGitLabEvent(issueEvent('update'), BOTS)?.action, 'update');
	});

	it('reads the issue iid and label titles', () => {
		const event = parseGitLabEvent(issueEvent('open', ['triage: needs triage']), BOTS);
		assert.equal(event?.issueNumber, 23);
		assert.deepEqual(event?.issueLabels, ['triage: needs triage']);
		assert.equal(event?.isPullRequest, false);
	});

	it('maps a new issue comment to created, with author and labels', () => {
		const event = parseGitLabEvent(noteEvent('Issue', 'create', ['triage: fix pending']), BOTS);
		assert.equal(event?.action, 'created');
		assert.equal(event?.issueNumber, 17);
		assert.equal(event?.commentAuthor, 'commenter');
		assert.deepEqual(event?.issueLabels, ['triage: fix pending']);
	});

	it('does not treat an edited comment as a new one', () => {
		assert.notEqual(parseGitLabEvent(noteEvent('Issue', 'update'), BOTS)?.action, 'created');
	});

	it('returns null when there is no issue to act on', () => {
		assert.equal(parseGitLabEvent(noteEvent('MergeRequest'), BOTS), null);
		assert.equal(parseGitLabEvent(noteEvent('Snippet'), BOTS), null);
		assert.equal(parseGitLabEvent({ object_kind: 'push' }, BOTS), null);
		assert.equal(parseGitLabEvent({}, BOTS), null);
	});

	// End to end through the real router: a GitLab payload has to produce the
	// same decision the GitHub payload would.
	it('routes a GitLab issue open to triage', () => {
		assert.deepEqual(route(parseGitLabEvent(issueEvent('open'), BOTS)!, labels), {
			type: 'triage',
			issueNumber: 23,
		});
	});

	it("skips the bot's own comment instead of looping", () => {
		const payload = noteEvent('Issue', 'create', ['triage: fix pending']);
		payload.user.username = 'triagebot';
		const result = route(parseGitLabEvent(payload, BOTS)!, labels);
		assert.equal(result.type, 'skip');
	});

	it('routes a human comment on a fix-pending issue to verify-fix', () => {
		const payload = noteEvent('Issue', 'create', ['triage: fix pending']);
		assert.deepEqual(route(parseGitLabEvent(payload, BOTS)!, labels), {
			type: 'verify-fix',
			issueNumber: 17,
		});
	});
});

describe('compareUrl', () => {
	// The bot renders this into every triage comment that produced a fix branch,
	// so a github.com link on GitLab is a dead link in user-facing output.
	it('uses GitLab compare syntax on GitLab', async () => {
		const { compareUrl } = await import('../src/forge.ts');
		assert.equal(
			compareUrl('grp/proj', 'triagebot/fix-17', true),
			'https://gitlab.com/grp/proj/-/compare/main...triagebot%2Ffix-17',
		);
	});

	it('uses GitHub compare syntax on GitHub', async () => {
		const { compareUrl } = await import('../src/forge.ts');
		assert.equal(
			compareUrl('org/repo', 'triagebot/fix-17', false),
			'https://github.com/org/repo/compare/triagebot/fix-17?expand=1',
		);
	});
});
