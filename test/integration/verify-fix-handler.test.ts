import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { ActionContext } from '../../src/context.ts';
import { defaultBranch } from '../../src/gitlab.ts';
import { handleVerifyFix } from '../../src/handlers/verify-fix.ts';
import { labelConfigFromInputs } from '../../src/labels.ts';
import { type GlabStub, ndjson, stubGlab } from '../helpers/glab-stub.ts';

const originalFetch = globalThis.fetch;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalServerUrl = process.env.CI_SERVER_URL;
let tempDir: string | null = null;
let glab: GlabStub | null = null;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
	if (originalServerUrl === undefined) delete process.env.CI_SERVER_URL;
	else process.env.CI_SERVER_URL = originalServerUrl;
	glab?.restore();
	glab = null;
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

function git(args: string[], cwd: string): void {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

/**
 * Serves the project over a file:// remote so findBranch runs a real
 * `git ls-remote` instead of being stubbed out. Credentials set on a file: URL
 * are dropped by the URL parser, so remoteUrl() still produces a usable path.
 */
function serveProjectWithBranch(branch: string): void {
	tempDir = mkdtempSync(join(tmpdir(), 'triagebot-verify-'));
	const bare = join(tempDir, 'grp', 'proj.git');
	mkdirSync(join(tempDir, 'grp'), { recursive: true });
	git(['init', '-q', '--bare', bare], tempDir);

	const work = join(tempDir, 'work');
	mkdirSync(work);
	git(['init', '-q', '-b', 'main'], work);
	git(['config', 'user.email', 'test@example.com'], work);
	git(['config', 'user.name', 'Test'], work);
	git(['commit', '-q', '--allow-empty', '-m', 'initial'], work);
	git(['push', '-q', bare, `main:${branch}`], work);

	process.env.CI_SERVER_URL = `file://${tempDir}`;
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

describe('handleVerifyFix integration', () => {
	it('falls back to legacy flue fix branches and verifies only after MR creation', async () => {
		process.env.ANTHROPIC_API_KEY = 'test-key';
		// Only the legacy branch exists, so findBranch has to fall through the
		// preferred triagebot/ name to reach it.
		serveProjectWithBranch('flue/fix-123');

		let anthropicCalls = 0;
		globalThis.fetch = async (input) => {
			const url = String(input);
			if (!url.startsWith('https://api.anthropic.com/')) {
				throw new Error(`Unexpected fetch: ${url}`);
			}
			anthropicCalls += 1;
			return anthropicCalls === 1
				? anthropicStream({
						status: 'confirmed',
						reasoning: 'The reporter confirmed the fix works.',
					})
				: anthropicStream({ title: 'Fix confirmed issue', body: 'Closes #123' });
		};

		glab = stubGlab([
			{
				match: '^issue view 123\\b',
				stdout: JSON.stringify({
					title: 'Example issue',
					description: 'Issue body',
					author: { username: 'reporter' },
					labels: ['triage: fix pending'],
					created_at: '2026-01-01T00:00:00Z',
					state: 'opened',
					iid: 123,
					web_url: 'https://gitlab.example.com/grp/proj/-/issues/123',
				}),
			},
			{
				match: '/issues/123/notes',
				stdout: ndjson([
					{
						author: { username: 'reporter' },
						body: 'I can confirm this fixes the issue.',
						created_at: '2026-01-01T00:00:00Z',
					},
				]),
			},
			{
				// Asked twice: once to check for an existing MR, then again to read
				// back the one just created, since `mr create` prints no JSON.
				match: '^mr list --source-branch flue/fix-123\\b',
				stdout: [
					'[]',
					JSON.stringify([
						{ iid: 456, web_url: 'https://gitlab.example.com/grp/proj/-/merge_requests/456' },
					]),
				],
			},
			{ match: '^mr create\\b' },
			{ match: '^mr update 456\\b' },
			{ match: '^issue update 123\\b' },
			{ match: '^issue note 123\\b' },
		]);

		const ctx: ActionContext = {
			repo: 'grp/proj',
			readToken: 'read-token',
			writeToken: 'write-token',
			anthropicApiKey: 'test-key',
			cloudflareApiKey: null,
			cloudflareAccountId: null,
			triageSkill: '.agents/skills/triage',
			prSkill: null,
			prSkillName: 'pr-writer',
			autoPrOnFix: false,
			buildCommand: null,
			triageModel: 'anthropic/claude-sonnet-4-6',
			verificationModel: 'anthropic/claude-sonnet-4-6',
			labels: labelConfigFromInputs(() => ''),
			botLogins: ['project_1_bot_abc'],
		};

		await handleVerifyFix(123, ctx);

		const calls = glab.calls();

		// The MR targets the legacy branch findBranch fell back to.
		const create = calls.find((c) => c.startsWith('mr create'));
		assert.ok(create, 'expected an mr create call');
		assert.match(create, /--source-branch flue\/fix-123\b/);
		assert.match(create, new RegExp(`--target-branch ${defaultBranch}\\b`));

		// Order matters: the issue must not be marked verified before the MR that
		// verification is claiming exists. Reads are concurrent, so compare only
		// the writes.
		assert.deepEqual(
			calls
				.filter((c) => /^(mr create|mr update|issue update|issue note)\b/.test(c))
				.map((c) => c.split(' ').slice(0, 2).join(' ')),
			['mr create', 'mr update', 'issue update', 'issue note'],
		);

		// Swapped off fix-pending and onto fix-verified in a single request.
		const swap = calls.find((c) => c.startsWith('issue update 123'));
		assert.ok(swap);
		assert.match(swap, /--label triage: fix verified/);
		assert.match(swap, /--unlabel triage: fix pending/);
	});
});
