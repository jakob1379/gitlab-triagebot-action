/**
 * Entry point for the triagebot GitLab CI job.
 *
 * Reads the webhook body GitLab dropped at $TRIGGER_PAYLOAD along with the
 * INPUT_* job variables, then routes to the appropriate handler via the FSM
 * router.
 */

import { readFileSync } from 'node:fs';
import type { ActionContext } from './context.ts';
import { currentUser } from './gitlab.ts';
import { parseGitLabEvent } from './gitlab-event.ts';
import { handleCleanup } from './handlers/cleanup.ts';
import { handleRetriage } from './handlers/retriage.ts';
import { handleTriage } from './handlers/triage.ts';
import { handleVerifyFix } from './handlers/verify-fix.ts';
import { getInput } from './input.ts';
import { labelConfigFromInputs } from './labels.ts';
import { route } from './router.ts';

// ---------- Input helpers ----------

function parseBotLogins(input: string): string[] {
	if (!input) return [];
	return [
		...new Set(
			input
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
}

function getRequiredInput(name: string): string {
	const value = getInput(name);
	if (!value) {
		throw new Error(`Required input "${name}" is not set`);
	}
	return value;
}

// ---------- Main ----------

async function main(): Promise<void> {
	// GitLab hands a webhook-triggered pipeline the request body as a file and
	// puts its path here.
	const eventPath = process.env.TRIGGER_PAYLOAD;
	if (!eventPath) {
		throw new Error(
			'TRIGGER_PAYLOAD is not set. This job expects a pipeline triggered by a project webhook; see .gitlab-ci.yml.',
		);
	}
	const payload = JSON.parse(readFileSync(eventPath, 'utf-8'));

	// Same "namespace/project" shape the glab --repo flag wants.
	const repo = process.env.CI_PROJECT_PATH;
	if (!repo) {
		throw new Error('CI_PROJECT_PATH is not set');
	}

	// Build the action context from inputs.
	const labels = labelConfigFromInputs(getInput);
	const ctx: ActionContext = {
		repo,
		readToken: getRequiredInput('read-token'),
		writeToken: getRequiredInput('write-token'),
		anthropicApiKey: getInput('anthropic-api-key') || null,
		cloudflareApiKey: getInput('cloudflare-api-key') || null,
		cloudflareAccountId: getInput('cloudflare-account-id') || null,
		triageSkill: getRequiredInput('triage-skill'),
		prSkill: getInput('pr-skill') || null,
		prSkillName: getInput('pr-skill-name') || 'pr-writer',
		autoPrOnFix: getInput('auto-pr-on-fix') === 'true',
		buildCommand: getInput('build-command') || null,
		triageModel: getInput('triage-model') || 'anthropic/claude-opus-4-6',
		verificationModel: getInput('verification-model') || 'anthropic/claude-sonnet-4-6',
		labels,
		botLogins: parseBotLogins(getInput('bot-logins')),
	};

	// Validate provider credentials before touching any globals so we don't
	// pollute process.env on an invalid configuration.
	const hasCloudflare = !!ctx.cloudflareApiKey && !!ctx.cloudflareAccountId;
	if (!ctx.anthropicApiKey && !hasCloudflare) {
		throw new Error(
			'No LLM credentials provided. Set "anthropic-api-key", or set both "cloudflare-api-key" and "cloudflare-account-id" to use Workers AI models.',
		);
	}
	if (ctx.cloudflareApiKey && !ctx.cloudflareAccountId) {
		throw new Error(
			'"cloudflare-api-key" is set but "cloudflare-account-id" is missing; both are required for Workers AI.',
		);
	}

	// Provide LLM credentials to Flue/pi-ai via env. The provider is selected by
	// the `triage-model` / `verification-model` prefix (e.g. "anthropic/..." or
	// "cloudflare-workers-ai/..."), and pi-ai reads the matching env var.
	if (ctx.anthropicApiKey) {
		process.env.ANTHROPIC_API_KEY = ctx.anthropicApiKey;
	}
	if (ctx.cloudflareApiKey) {
		process.env.CLOUDFLARE_API_KEY = ctx.cloudflareApiKey;
	}
	if (ctx.cloudflareAccountId) {
		process.env.CLOUDFLARE_ACCOUNT_ID = ctx.cloudflareAccountId;
	}

	// A project access token posts as `project_<id>_bot_<hash>`, which nothing
	// can hardcode. Without this the bot answers its own comments and retriggers
	// itself on every one it posts.
	//
	// writeToken, not readToken: comments are posted with the write token, so
	// that is the username the webhook will report as their author.
	const self = await currentUser(ctx.writeToken);
	if (self) ctx.botLogins = [...new Set([...ctx.botLogins, self])];
	else console.warn('Could not resolve the bot username; its own comments may retrigger triage.');

	const event = parseGitLabEvent(payload, ctx.botLogins);
	if (!event) {
		console.info('No issue in event payload, nothing to do.');
		return;
	}

	const action = route(event, labels);
	console.info(`Router decision: ${action.type}`, action);

	switch (action.type) {
		case 'triage':
			await handleTriage(action.issueNumber, ctx);
			break;
		case 'retriage':
			await handleRetriage(action.issueNumber, action.currentLabel, ctx);
			break;
		case 'verify-fix':
			await handleVerifyFix(action.issueNumber, ctx);
			break;
		case 'cleanup':
			await handleCleanup(action.issueNumber, ctx);
			break;
		case 'skip':
			console.info(`Skipping: ${action.reason}`);
			break;
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
