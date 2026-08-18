/**
 * Asserts the argv handed to `glab` and the mapping of its output.
 *
 * Both bugs this file was written for were argv/mapping bugs: merge-request
 * labels going to `glab issue update` (labelling an unrelated issue), and
 * issue notes coming back newest-first.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
	addLabels,
	addPullRequestLabels,
	fetchIssueDetails,
	fetchRepoLabels,
	swapLabel,
} from '../src/gitlab.ts';
import { type GlabStub, ndjson, stubGlab } from './helpers/glab-stub.ts';

const ISSUE = JSON.stringify({
	title: 'crash on boot',
	description: 'it crashes',
	author: { username: 'reporter' },
	labels: ['triage: needs triage'],
	created_at: '2026-01-01T00:00:00Z',
	state: 'opened',
	iid: 17,
	web_url: 'https://gitlab.com/grp/proj/-/issues/17',
});

/**
 * ndjson, not a JSON array: `glab api --paginate` writes one array per page
 * back to back (`[...][...]`), which JSON.parse rejects. `--output ndjson`
 * makes the page boundaries invisible, so this doubles as the multi-page case.
 */
const NOTES = ndjson([
	{ body: 'first', author: { username: 'reporter' }, created_at: '2026-01-01T01:00:00Z' },
	{
		body: 'added ~bug',
		author: { username: 'bot' },
		created_at: '2026-01-01T02:00:00Z',
		system: true,
	},
	{ body: 'still broken', author: { username: 'reporter' }, created_at: '2026-01-01T03:00:00Z' },
]);

const LABELS_NDJSON = ndjson([
	{ name: '- P3: minor', description: 'priority' },
	{ name: 'pkg: astro', description: null },
	{ name: 'documentation', description: 'docs' },
]);

let glab: GlabStub | null = null;
afterEach(() => {
	glab?.restore();
	glab = null;
});

/** Replies for the reads here; every write comes back as an empty list. */
function stub(): GlabStub {
	glab = stubGlab([
		{ match: 'notes', stdout: NOTES },
		{ match: 'labels', stdout: LABELS_NDJSON },
		{ match: '^issue view', stdout: ISSUE },
		{ match: '', stdout: '[]' },
	]);
	return glab;
}

describe('gitlab forge', () => {
	it('labels a merge request via `mr update`, not `issue update`', async () => {
		// Merge requests carry their own iid sequence, so `issue update` with an
		// MR iid silently labels an unrelated issue.
		const argv = stub().calls;
		await addPullRequestLabels('grp/proj', 4, ['fix verified'], 'tok');
		assert.equal(argv()[0], 'mr update 4 --label fix verified --repo grp/proj');
	});

	it('labels an issue via `issue update`', async () => {
		const argv = stub().calls;
		await addLabels('grp/proj', 17, ['triage: needs triage'], 'tok');
		assert.equal(argv()[0], 'issue update 17 --label triage: needs triage --repo grp/proj');
	});

	it('swaps labels in one request so the issue is never left unlabelled', async () => {
		const argv = stub().calls;
		await swapLabel('grp/proj', 17, 'triage: needs triage', 'triage: fix pending', 'tok');
		assert.equal(argv().length, 1);
		assert.equal(
			argv()[0],
			'issue update 17 --label triage: fix pending --unlabel triage: needs triage --repo grp/proj',
		);
	});

	it('does nothing when there are no labels to add', async () => {
		const argv = stub().calls;
		await addLabels('grp/proj', 17, [], 'tok');
		assert.deepEqual(argv(), []);
	});

	it('parses ndjson label pages and partitions them', async () => {
		const argv = stub().calls;
		const { priorityLabels, packageLabels } = await fetchRepoLabels('grp/proj', 'tok');
		assert.match(argv()[0], /--paginate/);
		assert.match(argv()[0], /--output ndjson/);
		assert.deepEqual(
			priorityLabels.map((l) => l.name),
			['- P3: minor'],
		);
		assert.deepEqual(
			packageLabels.map((l) => l.name),
			['pkg: astro'],
		);
	});

	describe('fetchIssueDetails', () => {
		it('requests notes oldest-first, the order every caller assumes', async () => {
			// GitLab defaults to sort=desc. Without this, verify-fix classifies
			// the oldest comment as the reporter's latest word.
			const argv = stub().calls;
			await fetchIssueDetails('grp/proj', 17, 'tok');
			const notes = argv().find((a) => a.includes('/notes'));
			assert.ok(notes, 'expected a notes request');
			assert.match(notes, /sort=asc/);
		});

		it('reads notes as ndjson so a paginated response stays parseable', async () => {
			// `--paginate` alone emits one JSON array per page, back to back, which
			// JSON.parse rejects — and pagination only kicks in on exactly the busy
			// issues --paginate was added for.
			const argv = stub().calls;
			await fetchIssueDetails('grp/proj', 17, 'tok');
			const notes = argv().find((a) => a.includes('/notes'));
			assert.ok(notes, 'expected a notes request');
			assert.match(notes, /--paginate/);
			assert.match(notes, /--output ndjson/);
		});

		it('maps GitLab fields onto the shared shape', async () => {
			stub();
			const details = await fetchIssueDetails('grp/proj', 17, 'tok');
			assert.equal(details.number, 17); // iid, not id
			assert.equal(details.body, 'it crashes'); // description -> body
			assert.equal(details.author.login, 'reporter'); // username -> login
			assert.equal(details.state, 'open'); // "opened" -> "open"
			assert.deepEqual(
				details.labels.map((l) => l.name),
				['triage: needs triage'],
			);
		});

		it('drops system notes so activity entries are not read as comments', async () => {
			stub();
			const details = await fetchIssueDetails('grp/proj', 17, 'tok');
			assert.deepEqual(
				details.comments.map((c) => c.body),
				['first', 'still broken'],
			);
		});
	});
});
