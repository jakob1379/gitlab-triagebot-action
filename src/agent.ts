/**
 * The triage agent. Instructions and the issue arrive on stdin, the result
 * leaves on stdout as JSON, and the agent's log goes to stderr.
 * scripts/triage.sh starts it as an unprivileged user in the project checkout
 * and makes every GitLab write itself, so nothing here holds a GitLab token.
 */

import { readFileSync } from 'node:fs';
import { createAgent, type ThinkingLevel } from '@flue/runtime';
import { configureProvider } from '@flue/runtime/app';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';
import { createSession } from './flue.ts';

const model = process.env.TRIAGE_MODEL ?? '';
configureProvider(model.split('/')[0], { apiKey: process.env.TRIAGE_API_KEY });

const agent = createAgent(() => ({
	sandbox: local({ env: { NIX_CONFIG: process.env.NIX_CONFIG } }),
	model,
}));
const session = await createSession(agent);

const { data } = await session.prompt(readFileSync(0, 'utf-8'), {
	thinkingLevel: (process.env.TRIAGE_THINKING || 'high') as ThinkingLevel,
	result: v.object({
		outcome: v.picklist([
			'not actionable',
			'needs reproduction',
			'unable to reproduce',
			'unable to fix',
			'needs approval',
			'fixed',
		]),
		comment: v.pipe(v.string(), v.description('Posted on the issue as it is')),
		commit_message: v.pipe(
			v.nullable(v.string()),
			v.description('A conventional commit subject when outcome is "fixed", otherwise null'),
		),
	}),
});
process.stdout.write(`${JSON.stringify(data)}\n`);
