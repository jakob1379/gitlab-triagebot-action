/**
 * Plain git operations. Nothing here is GitLab-specific; gitlab.ts supplies
 * the authenticated remote URL.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Remote URLs carry a token in userinfo, and git echoes the full URL back in
 * its error messages. Strip the credentials before anything is logged.
 */
export function redactRemote(text: string): string {
	return text.replace(/(https?:\/\/)[^@\s/]*@/g, '$1<redacted>@');
}

/**
 * Stage all changes and create a commit. Runs outside the sandbox and passes
 * the commit message as an argv argument (never a shell string), so backticks,
 * parentheses, quotes, and newlines in an LLM-authored message can't be
 * interpreted by the shell or break the command.
 */
export async function gitCommit(message: string): Promise<GitResult> {
	try {
		await execFileAsync('git', ['add', '-A']);
		const { stdout, stderr } = await execFileAsync('git', ['commit', '-m', message]);
		return { exitCode: 0, stdout, stderr };
	} catch (err: any) {
		return { exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
	}
}

/**
 * Push a branch. Runs outside any sandbox so the write token is never exposed
 * to the LLM agent.
 */
export async function push(
	remoteUrl: string,
	branch: string,
	options?: { force?: boolean },
): Promise<GitResult> {
	const args = ['push'];
	if (options?.force) args.push('-f');
	args.push(remoteUrl, branch);
	try {
		const { stdout, stderr } = await execFileAsync('git', args);
		return { exitCode: 0, stdout, stderr };
	} catch (err: any) {
		return {
			exitCode: err.code ?? 1,
			stdout: redactRemote(err.stdout ?? ''),
			stderr: redactRemote(err.stderr ?? ''),
		};
	}
}
