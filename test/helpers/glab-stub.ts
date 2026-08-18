/**
 * A recording `glab` stub, first on PATH.
 *
 * gitlab.ts resolves `glab` from PATH at call time, so a script named `glab`
 * intercepts every forge call without any module mocking — which means the
 * argv the bot actually builds gets exercised rather than bypassed.
 *
 * The stub is a Node script rather than a shell `case` so that responses can be
 * queued per route (the bot reads a merge request back after creating it, and
 * has to see two different answers to the same command) and so that payloads
 * containing quotes never have to survive a round trip through sh.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GlabRoute {
	/** Regex source, tested against the space-joined argv. */
	match: string;
	/**
	 * stdout for a matching call. An array is consumed one entry per call, with
	 * the last entry repeating once exhausted.
	 */
	stdout?: string | string[];
	/** Non-zero to make the call fail, as glab does on a bad request. */
	exitCode?: number;
}

export interface GlabStub {
	/** Space-joined argv of every `glab` call so far, in order. */
	calls(): string[];
	/** The same calls, unjoined — use when an argument contains spaces. */
	argv(): string[][];
	/** Directory holding the stub; already prepended to PATH. */
	dir: string;
	/** Restores PATH and removes the stub. */
	restore(): void;
}

const RUNNER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
// One JSON array per line: comment bodies are multi-line, so a raw join would
// corrupt the one-call-per-line log.
fs.appendFileSync(path.join(__dirname, 'argv.log'), JSON.stringify(args) + '\\n');
const argv = args.join(' ');

const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'routes.json'), 'utf8'));
const countsPath = path.join(__dirname, 'counts.json');
const counts = fs.existsSync(countsPath) ? JSON.parse(fs.readFileSync(countsPath, 'utf8')) : {};

for (let i = 0; i < routes.length; i++) {
  const route = routes[i];
  if (!new RegExp(route.match).test(argv)) continue;
  const seen = counts[i] ?? 0;
  counts[i] = seen + 1;
  fs.writeFileSync(countsPath, JSON.stringify(counts));
  const replies = route.stdout ?? [''];
  process.stdout.write(replies[Math.min(seen, replies.length - 1)]);
  process.exit(route.exitCode ?? 0);
}

// Unmatched calls fail loudly: a silent empty reply would surface much later as
// a confusing parse error.
process.stderr.write('glab stub: no route for: ' + argv + '\\n');
process.exit(1);
`;

export function stubGlab(routes: GlabRoute[]): GlabStub {
	const dir = mkdtempSync(join(tmpdir(), 'glab-stub-'));
	const log = join(dir, 'argv.log');

	writeFileSync(
		join(dir, 'routes.json'),
		JSON.stringify(
			routes.map((r) => ({
				match: r.match,
				stdout: r.stdout === undefined ? [''] : [r.stdout].flat(),
				exitCode: r.exitCode,
			})),
		),
	);
	writeFileSync(log, '');
	const bin = join(dir, 'glab');
	writeFileSync(bin, RUNNER);
	chmodSync(bin, 0o755);

	const originalPath = process.env.PATH;
	process.env.PATH = `${dir}:${originalPath}`;

	const argv = (): string[][] =>
		readFileSync(log, 'utf-8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string[]);

	return {
		dir,
		argv,
		calls: () => argv().map((a) => a.join(' ')),
		restore() {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** ndjson is what `glab api --paginate --output ndjson` emits: one value per line. */
export function ndjson(values: unknown[]): string {
	return values.map((v) => JSON.stringify(v)).join('\n');
}
