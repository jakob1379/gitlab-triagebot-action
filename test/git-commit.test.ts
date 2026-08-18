import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { gitCommit, redactRemote } from '../src/git.ts';

const originalCwd = process.cwd();
let repo: string | null = null;

function git(args: string[], cwd: string): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'triagebot-commit-'));
	git(['init', '-b', 'main'], repo);
	git(['config', 'user.email', 'test@example.com'], repo);
	git(['config', 'user.name', 'Triage Test'], repo);
	writeFileSync(join(repo, 'README.md'), 'initial\n');
	git(['add', '-A'], repo);
	git(['commit', '-m', 'initial'], repo);
	// gitCommit operates in process.cwd(), matching how gitPush runs in the action.
	process.chdir(repo);
});

afterEach(() => {
	process.chdir(originalCwd);
	if (repo) {
		rmSync(repo, { recursive: true, force: true });
		repo = null;
	}
});

describe('gitCommit', () => {
	it('preserves a message with backticks, parentheses, quotes, and newlines verbatim', async () => {
		// This is the class of message that broke the old `git commit -m "<json>"`
		// shell command (backticks triggered command substitution in /bin/sh).
		const message = [
			"fix: BASE_URL no longer ends with a trailing slash when trailingSlash is 'never'",
			'',
			"`removeTrailingForwardSlash('/')` returns `''`, but then `prependForwardSlash('')`",
			'adds it back → `\'/\'`. Also guards against $(whoami) and "double quotes".',
			'',
			'Fixes #15440',
		].join('\n');

		writeFileSync(join(repo as string, 'change.txt'), 'change\n');
		const result = await gitCommit(message);

		assert.equal(result.exitCode, 0, `commit failed: ${result.stderr}`);
		const stored = git(['log', '-1', '--pretty=%B'], repo as string).replace(/\n+$/, '');
		assert.equal(stored, message);
	});

	it('stages new files before committing', async () => {
		writeFileSync(join(repo as string, 'new-file.txt'), 'hello\n');
		const result = await gitCommit('chore: add file');

		assert.equal(result.exitCode, 0, result.stderr);
		const files = git(['show', '--name-only', '--pretty=format:', 'HEAD'], repo as string).trim();
		assert.match(files, /new-file\.txt/);
	});

	it('returns a non-zero exitCode when there is nothing to commit', async () => {
		const result = await gitCommit('chore: noop');
		assert.notEqual(result.exitCode, 0);
	});
});

describe('redactRemote', () => {
	// The push remote carries the write token in its userinfo and git echoes the
	// whole URL back on failure, so this is the only thing standing between a
	// failed push and a token in the job log.
	it('strips credentials from a remote URL', () => {
		assert.equal(
			redactRemote(
				"fatal: could not read from 'https://oauth2:glpat-secret@gitlab.example.com/grp/proj.git'",
			),
			"fatal: could not read from 'https://<redacted>@gitlab.example.com/grp/proj.git'",
		);
	});

	it('redacts every occurrence, not just the first', () => {
		const out = redactRemote(
			'https://oauth2:glpat-a@gitlab.com/a.git and http://oauth2:glpat-b@gitlab.com/b.git',
		);
		assert.doesNotMatch(out, /glpat-/);
	});

	it('leaves a URL without credentials alone', () => {
		assert.equal(
			redactRemote('https://gitlab.com/grp/proj.git'),
			'https://gitlab.com/grp/proj.git',
		);
	});
});
