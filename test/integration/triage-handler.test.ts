import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ActionContext } from '../../src/context.ts';
import { handleTriage } from '../../src/handlers/triage.ts';
import { labelConfigFromInputs } from '../../src/labels.ts';
import { type GlabStub, ndjson, stubGlab } from '../helpers/glab-stub.ts';

const originalCwd = process.cwd();
let tempDir: string | null = null;
let glab: GlabStub | null = null;

afterEach(() => {
	process.chdir(originalCwd);
	glab?.restore();
	glab = null;
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

const ISSUE = JSON.stringify({
	title: 'Example issue',
	description: 'Issue body',
	author: { username: 'reporter' },
	labels: ['triage: needs triage'],
	created_at: '2026-01-01T00:00:00Z',
	state: 'opened',
	iid: 123,
	web_url: 'https://gitlab.example.com/grp/proj/-/issues/123',
});

function createTriageSkill(): string {
	tempDir = mkdtempSync(join(tmpdir(), 'triagebot-action-'));
	const skillDir = join(tempDir, '.agents', 'skills', 'triage');
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, 'SKILL.md'),
		'---\nname: triage\ndescription: Triage a bug report.\n---\n\n# Triage\n',
	);
	writeFileSync(join(skillDir, 'reproduce.md'), '# Reproduce\n');
	writeFileSync(join(skillDir, 'diagnose.md'), '# Diagnose\n');
	writeFileSync(join(skillDir, 'verify.md'), '# Verify\n');
	writeFileSync(join(skillDir, 'fix.md'), '# Fix\n');
	process.chdir(tempDir);
	return skillDir;
}

describe('handleTriage integration', () => {
	it('does not reject because triage-skill is provided as a job input directory path', async () => {
		glab = stubGlab([
			{ match: '^issue view 123\\b', stdout: ISSUE },
			{ match: '/issues/123/notes', stdout: ndjson([]) },
			// The failure path below writes a failure comment and swaps the label.
			{ match: '^issue note 123\\b' },
			{ match: '^issue update 123\\b' },
		]);

		const ctx: ActionContext = {
			repo: 'grp/proj',
			readToken: 'read-token',
			writeToken: 'write-token',
			anthropicApiKey: 'anthropic-key',
			cloudflareApiKey: null,
			cloudflareAccountId: null,
			triageSkill: createTriageSkill(),
			prSkill: null,
			prSkillName: 'pr-writer',
			autoPrOnFix: false,
			buildCommand: null,
			// Deliberately invalid, to fail the run *after* skill registration.
			triageModel: false as unknown as string,
			verificationModel: false as unknown as string,
			labels: labelConfigFromInputs(() => ''),
			botLogins: ['project_1_bot_abc'],
		};

		let error: unknown;
		try {
			await handleTriage(123, ctx);
		} catch (err) {
			error = err;
		}

		const message = String(error instanceof Error ? error.stack : error);
		assert.doesNotMatch(message, /skills\[0\]/);
		assert.doesNotMatch(message, /Skill "triage" is not registered/);
	});
});
