import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ActionContext } from '../../src/context.ts';
import { defaultBranch } from '../../src/gitlab.ts';
import { handleTriage } from '../../src/handlers/triage.ts';
import { labelConfigFromInputs } from '../../src/labels.ts';
import { type GlabRoute, type GlabStub, ndjson, stubGlab } from '../helpers/glab-stub.ts';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalPath = process.env.PATH;
const originalServerUrl = process.env.CI_SERVER_URL;
let tempDir: string | null = null;
let glab: GlabStub | null = null;

afterEach(() => {
	process.chdir(originalCwd);
	globalThis.fetch = originalFetch;
	if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
	if (originalServerUrl === undefined) delete process.env.CI_SERVER_URL;
	else process.env.CI_SERVER_URL = originalServerUrl;
	glab?.restore();
	glab = null;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

const REPO = 'grp/proj';

function run(command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

function setupRepo(): string {
	tempDir = mkdtempSync(join(tmpdir(), 'triagebot-e2e-'));
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
	mkdirSync(join(tempDir, 'packages', 'astro', 'src'), { recursive: true });
	writeFileSync(join(tempDir, 'packages', 'astro', 'src', 'index.ts'), 'export const value = 1;\n');
	writeFileSync(join(tempDir, 'README.md'), '# fixture\n');
	run('git', ['init', '-b', 'main'], tempDir);
	run('git', ['config', 'user.email', 'test@example.com'], tempDir);
	run('git', ['config', 'user.name', 'Test'], tempDir);
	run('git', ['add', '.'], tempDir);
	run('git', ['commit', '-m', 'initial'], tempDir);
	process.chdir(tempDir);
	return skillDir;
}

/**
 * Points CI_SERVER_URL at a local bare repo so gitPush is exercised for real.
 * gitlab.ts builds `${CI_SERVER_URL}/${repo}.git` and sets credentials on it;
 * a file: URL drops the credentials and stays usable.
 *
 * The bare repo lives inside .git so the `git add -A` in gitCommit does not
 * sweep it into the fixture's own commit.
 */
function configureLocalPushRemote(): void {
	assert.ok(tempDir);
	const serverDir = join(tempDir, '.git', 'remote');
	mkdirSync(join(serverDir, 'grp'), { recursive: true });
	run('git', ['init', '--bare', join(serverDir, 'grp', 'proj.git')], tempDir);
	process.env.CI_SERVER_URL = `file://${serverDir}`;
}

function installFakePnpm(url: string): void {
	assert.ok(tempDir);
	const binDir = join(tempDir, '.git', 'bin');
	mkdirSync(binDir, { recursive: true });
	const pnpmPath = join(binDir, 'pnpm');
	writeFileSync(
		pnpmPath,
		`#!/bin/sh\nprintf '%s' '{"packages":[{"url":"${url}"}]}' > preview-release.json\nexit 0\n`,
	);
	chmodSync(pnpmPath, 0o755);
	process.env.PATH = `${binDir}:${process.env.PATH}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function anthropicStream(toolInput: unknown): Response {
	const encoder = new TextEncoder();
	const body = [
		{
			type: 'message_start',
			message: {
				id: 'msg_test',
				type: 'message',
				role: 'assistant',
				content: [],
				model: 'claude-sonnet-4-6',
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
		{
			type: 'content_block_start',
			index: 0,
			content_block: { type: 'tool_use', id: 'toolu_test', name: 'finish', input: {} },
		},
		{
			type: 'content_block_delta',
			index: 0,
			delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
		},
		{ type: 'content_block_stop', index: 0 },
		{
			type: 'message_delta',
			delta: { stop_reason: 'tool_use', stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: 'message_stop' },
	]
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join('');

	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.close();
			},
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } },
	);
}

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

const PROJECT_LABELS = ndjson([
	{ name: '- P3: minor bug', description: 'Minor bug' },
	{ name: 'pkg: astro', description: 'Core package' },
]);

/** The forge reads and writes every triage run makes, regardless of outcome. */
function baseRoutes(): GlabRoute[] {
	return [
		{ match: '^issue view 123\\b', stdout: ISSUE },
		{ match: '/issues/123/notes', stdout: ndjson([]) },
		{ match: '/labels\\?', stdout: PROJECT_LABELS },
		{ match: '^issue note 123\\b' },
		{ match: '^issue update 123\\b' },
	];
}

/** Bodies of the notes posted to the issue, in order. */
function postedNotes(stub: GlabStub): string[] {
	return stub
		.argv()
		.filter((a) => a[0] === 'issue' && a[1] === 'note')
		.map((a) => a[a.indexOf('--message') + 1]);
}

/**
 * Label mutations on the issue. GitLab does a swap in one request, so both the
 * added and removed sides of a transition arrive together.
 */
function labelUpdates(stub: GlabStub): Array<{ add: string[]; remove: string[] }> {
	return stub
		.argv()
		.filter((a) => a[0] === 'issue' && a[1] === 'update')
		.map((a) => ({
			add: a.includes('--label') ? a[a.indexOf('--label') + 1].split(',') : [],
			remove: a.includes('--unlabel') ? a[a.indexOf('--unlabel') + 1].split(',') : [],
		}));
}

function contextFor(triageSkill: string, overrides: Partial<ActionContext> = {}): ActionContext {
	return {
		repo: REPO,
		readToken: 'read-token',
		writeToken: 'write-token',
		anthropicApiKey: 'test-key',
		cloudflareApiKey: null,
		cloudflareAccountId: null,
		triageSkill,
		prSkill: null,
		prSkillName: 'pr-writer',
		autoPrOnFix: false,
		buildCommand: null,
		triageModel: 'anthropic/claude-sonnet-4-6',
		verificationModel: 'anthropic/claude-sonnet-4-6',
		labels: labelConfigFromInputs(() => ''),
		botLogins: ['project_1_bot_abc'],
		...overrides,
	};
}

describe('mocked triage flow', () => {
	it('runs an opened issue through unable-to-reproduce without real LLM or forge calls', async () => {
		const triageSkill = setupRepo();
		process.env.ANTHROPIC_API_KEY = 'test-key';
		glab = stubGlab(baseRoutes());
		let anthropicCalls = 0;

		globalThis.fetch = async (input) => {
			const url = String(input);
			if (!url.startsWith('https://api.anthropic.com/')) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			anthropicCalls += 1;
			if (anthropicCalls > 5) throw new Error('Too many mocked Anthropic calls');
			if (anthropicCalls === 1) {
				return anthropicStream({ reproducible: false, skipped: false, skippedReason: null });
			}
			return anthropicStream({
				result:
					'- **Reproduced:** No\n- **Exploration:** No\n- **Unit Test:** No\n- **Priority:** Priority P3: Minor bug.\n',
			});
		};

		await withTimeout(handleTriage(123, contextFor(triageSkill)), 10_000);

		assert.equal(anthropicCalls, 2);
		const notes = postedNotes(glab);
		assert.equal(notes.length, 1);
		assert.match(notes[0], /Reproduced/);
		assert.deepEqual(labelUpdates(glab), [
			{ add: ['triage: unable to reproduce'], remove: ['triage: needs triage'] },
		]);
	});

	it('publishes a preview release for fixed package changes before marking fix pending', async () => {
		const triageSkill = setupRepo();
		configureLocalPushRemote();
		installFakePnpm('https://pkg.pr.new/astro@test123');
		glab = stubGlab(baseRoutes());
		writeFileSync(
			join(tempDir as string, 'packages', 'astro', 'src', 'index.ts'),
			'export const value = 2;\n',
		);

		process.env.ANTHROPIC_API_KEY = 'test-key';
		let anthropicCalls = 0;
		let commentPromptIncludedPreviewUrl = false;

		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (!url.startsWith('https://api.anthropic.com/')) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			anthropicCalls += 1;
			if (anthropicCalls === 1) {
				return anthropicStream({ reproducible: true, skipped: false, skippedReason: null });
			}
			if (anthropicCalls === 2) return anthropicStream({ confidence: 'high' });
			if (anthropicCalls === 3) return anthropicStream({ verdict: 'bug', confidence: 'high' });
			if (anthropicCalls === 4) {
				return anthropicStream({ fixed: true, commitMessage: 'fix: update astro package' });
			}
			if (anthropicCalls === 5) {
				commentPromptIncludedPreviewUrl = JSON.stringify(
					JSON.parse(String(init?.body ?? '{}')),
				).includes('https://pkg.pr.new/astro@test123');
				return anthropicStream({
					result:
						'- **Reproduced:** Yes\n- **Exploration:** Yes\n- **Unit Test:** Yes\n- **Priority:** Priority P3: Minor bug.\n\n### Try this fix\n\nnpm i https://pkg.pr.new/astro@test123\n',
				});
			}
			if (anthropicCalls === 6) {
				return anthropicStream({ priority: '- P3: minor bug', packages: ['pkg: astro'] });
			}
			throw new Error('Too many mocked Anthropic calls');
		};

		await withTimeout(handleTriage(123, contextFor(triageSkill)), 20_000);

		assert.equal(anthropicCalls, 6);
		assert.equal(commentPromptIncludedPreviewUrl, true);
		const notes = postedNotes(glab);
		assert.equal(notes.length, 1);
		assert.match(notes[0], /https:\/\/pkg\.pr\.new\/astro@test123/);
		assert.deepEqual(labelUpdates(glab), [
			{ add: ['triage: fix pending'], remove: ['triage: needs triage'] },
			{ add: ['- P3: minor bug', 'pkg: astro'], remove: [] },
		]);
	});

	it('opens a merge request directly and marks fix verified when auto-pr-on-fix is enabled', async () => {
		const triageSkill = setupRepo();
		configureLocalPushRemote();
		glab = stubGlab([
			...baseRoutes(),
			{
				// Checked for an existing MR, then read back after creation.
				match: '^mr list --source-branch triagebot/fix-123\\b',
				stdout: [
					'[]',
					JSON.stringify([
						{ iid: 456, web_url: 'https://gitlab.example.com/grp/proj/-/merge_requests/456' },
					]),
				],
			},
			{ match: '^mr create\\b' },
			{ match: '^mr update 456\\b' },
		]);
		writeFileSync(
			join(tempDir as string, 'packages', 'astro', 'src', 'index.ts'),
			'export const value = 2;\n',
		);

		process.env.ANTHROPIC_API_KEY = 'test-key';
		let anthropicCalls = 0;

		globalThis.fetch = async (input) => {
			const url = String(input);
			if (!url.startsWith('https://api.anthropic.com/')) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			anthropicCalls += 1;
			if (anthropicCalls === 1) {
				return anthropicStream({ reproducible: true, skipped: false, skippedReason: null });
			}
			if (anthropicCalls === 2) return anthropicStream({ confidence: 'high' });
			if (anthropicCalls === 3) return anthropicStream({ verdict: 'bug', confidence: 'high' });
			if (anthropicCalls === 4) {
				return anthropicStream({ fixed: true, commitMessage: 'fix: update astro package' });
			}
			if (anthropicCalls === 5) {
				return anthropicStream({ title: 'Fix the astro package', body: 'Closes #123' });
			}
			if (anthropicCalls === 6) {
				return anthropicStream({
					result:
						'- **Reproduced:** Yes\n- **Exploration:** Yes\n- **Unit Test:** Yes\n- **Priority:** Priority P3: Minor bug.\n',
				});
			}
			if (anthropicCalls === 7) {
				return anthropicStream({ priority: '- P3: minor bug', packages: ['pkg: astro'] });
			}
			throw new Error('Too many mocked Anthropic calls');
		};

		await withTimeout(handleTriage(123, contextFor(triageSkill, { autoPrOnFix: true })), 20_000);

		// MR content generated, then comment, then label selection: 7 LLM calls.
		assert.equal(anthropicCalls, 7);

		// An MR was opened directly from the fix branch against the default branch.
		// Not the literal "main": gitlab.ts resolves this from CI_DEFAULT_BRANCH,
		// which real GitLab CI always sets, so hardcoding it here would assert
		// against the environment rather than the wiring.
		const create = glab.calls().find((c) => c.startsWith('mr create'));
		assert.ok(create, 'expected an mr create call');
		assert.match(create, /--source-branch triagebot\/fix-123\b/);
		assert.match(create, new RegExp(`--target-branch ${defaultBranch}\\b`));

		// The MR got the fix-verified label, on `mr update` rather than
		// `issue update` — merge requests have their own iid sequence.
		const mrLabel = glab.argv().find((a) => a[0] === 'mr' && a[1] === 'update');
		assert.deepEqual(mrLabel?.slice(0, 5), ['mr', 'update', '456', '--label', 'fix verified']);

		// The issue moved straight to fix verified (no preview => not fix pending).
		assert.deepEqual(labelUpdates(glab), [
			{ add: ['triage: fix verified'], remove: ['triage: needs triage'] },
			{ add: ['- P3: minor bug', 'pkg: astro'], remove: [] },
		]);

		// The reporter comment links the opened MR.
		const notes = postedNotes(glab);
		assert.equal(notes.length, 1);
		assert.match(notes[0], /merge_requests\/456/);
	});
});
