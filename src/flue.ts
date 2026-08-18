import type { CreatedAgent, FlueSession } from '@flue/runtime';
import {
	Bash,
	bashFactoryToSessionEnv,
	createFlueContext,
	InMemoryFs,
	InMemorySessionStore,
	resolveModel,
} from '@flue/runtime/internal';
import { createFlueEventLogger } from './flue-logging.ts';

const defaultStore = new InMemorySessionStore();

async function createDefaultEnv() {
	const fs = new InMemoryFs();
	return bashFactoryToSessionEnv(
		() =>
			new Bash({
				fs,
				network: { dangerouslyAllowFullInternetAccess: true },
			}),
	);
}

export async function createSession(agent: CreatedAgent): Promise<FlueSession> {
	const ctx = createFlueContext({
		// CI_JOB_ID is unique per run including retries, so it needs no attempt
		// counter. Date.now() only covers running outside CI, e.g. in tests.
		id: `triagebot-${process.env.CI_PIPELINE_ID ?? 'local'}-${process.env.CI_JOB_ID ?? Date.now()}`,
		payload: {},
		env: process.env,
		agentConfig: {
			systemPrompt: '',
			skills: {},
			roles: {},
			model: undefined,
			resolveModel,
		},
		createDefaultEnv,
		defaultStore,
	});
	const logger = createFlueEventLogger();
	ctx.setEventCallback((event) => logger.present(event));
	const harness = await ctx.init(agent);
	return harness.session();
}
