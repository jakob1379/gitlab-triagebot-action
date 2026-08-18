/**
 * End-to-end coverage for the GitLab entrypoint.
 *
 * `src/forge.ts` picks its backend off GITLAB_CI at module load, so the GitLab
 * path is only reachable from a fresh process — hence spawning the built bundle
 * rather than importing handlers, the same shape as action-entrypoint.test.ts.
 *
 * Everything the bot touches here is either the stubbed `glab` on PATH or the
 * payload file, so no case reaches the network.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

/** Who `glab api user` says the write token authenticates as. */
const BOT_USERNAME = 'project_1_bot_abc';

let tempDir: string | null = null;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

/**
 * Runs the built bundle the way a GitLab CI job does, with a `glab` stub first
 * on PATH. The stub answers `api user` and fails everything else, so a case that
 * routes to a handler stops at its first forge read instead of calling out.
 */
function runGitLabJob(payload: unknown) {
	tempDir = mkdtempSync(join(tmpdir(), 'triagebot-gitlab-'));
	const eventPath = join(tempDir, 'event.json');
	writeFileSync(eventPath, JSON.stringify(payload));

	const bin = join(tempDir, 'glab');
	writeFileSync(
		bin,
		[
			'#!/bin/sh',
			'case "$*" in',
			`  "api user") printf '%s' '{"username":"${BOT_USERNAME}"}' ;;`,
			'  *) echo "stub glab: refusing $*" >&2; exit 1 ;;',
			'esac',
		].join('\n'),
	);
	chmodSync(bin, 0o755);

	return spawnSync(process.execPath, ['dist/index.mjs'], {
		cwd: process.cwd(),
		env: {
			...process.env,
			PATH: `${tempDir}:${process.env.PATH}`,
			GITLAB_CI: 'true',
			// Not GITHUB_REPOSITORY: the GitLab path reads the project path here.
			CI_PROJECT_PATH: 'grp/proj',
			CI_SERVER_URL: 'https://gitlab.example.com',
			GITHUB_EVENT_PATH: eventPath,
			'INPUT_READ-TOKEN': 'read-token',
			'INPUT_WRITE-TOKEN': 'write-token',
			'INPUT_ANTHROPIC-API-KEY': 'anthropic-key',
			'INPUT_TRIAGE-SKILL': '.agents/skills/triage',
		},
		encoding: 'utf8',
	});
}

describe('gitlab entrypoint', () => {
	it('ignores the comments it posts itself', () => {
		// A project access token posts as `project_<id>_bot_<hash>`, which nothing
		// can hardcode, so the bot resolves its own username at runtime. Without
		// that lookup this note routes to verify-fix and the bot answers itself on
		// every comment it writes.
		const result = runGitLabJob({
			object_kind: 'note',
			user: { username: BOT_USERNAME },
			object_attributes: { action: 'create', noteable_type: 'Issue' },
			issue: { iid: 17, labels: [{ title: 'triage: fix pending' }] },
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Skipping: Comment from bot \(project_1_bot_abc\)/);
	});

	it('drops merge request comments before they reach the router', () => {
		const result = runGitLabJob({
			object_kind: 'note',
			user: { username: 'reporter' },
			object_attributes: { action: 'create', noteable_type: 'MergeRequest' },
			merge_request: { iid: 4 },
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /No issue in event payload, nothing to do\./);
	});

	it('routes a newly opened issue to triage', () => {
		// GitLab says "open" where the router matches GitHub's "opened".
		const result = runGitLabJob({
			object_kind: 'issue',
			object_attributes: { action: 'open', iid: 42 },
			labels: [],
		});

		assert.match(result.stdout, /Router decision: triage/);
		// Triage then stops at its first `glab issue view`, which the stub fails.
		// The routing decision is what this case is about, not the run completing.
		assert.equal(result.status, 1);
	});
});
