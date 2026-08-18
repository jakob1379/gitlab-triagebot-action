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
}

export interface GlabStub {
	/** Space-joined argv of every `glab` call so far, in order. */
	calls(): string[];
	/** The same calls, unjoined — use when an argument contains spaces. */
	argv(): string[][];
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

let matched = false;
for (let i = 0; i < routes.length; i++) {
  const route = routes[i];
  if (!new RegExp(route.match).test(argv)) continue;
  // One file per route rather than a shared counter, so concurrent calls on
  // *different* routes cannot clobber each other's tally. Two concurrent calls
  // on the same route would still both read the same index; no queued route is
  // used that way, and a route with a single reply does not care.
  const countFile = path.join(__dirname, 'count-' + i);
  let seen = 0;
  try {
    seen = fs.readFileSync(countFile, 'utf8').length;
  } catch {}
  fs.appendFileSync(countFile, 'x');
  const replies = route.stdout ?? [''];
  // No process.exit here: it can truncate a pending write to a pipe, and some
  // routes reply with multi-kilobyte JSON. Falling off the end flushes stdout.
  process.stdout.write(replies[Math.min(seen, replies.length - 1)]);
  matched = true;
  break;
}

if (!matched) {
  // Unmatched calls fail loudly: a silent empty reply would surface much later
  // as a confusing parse error.
  process.stderr.write('glab stub: no route for: ' + argv + '\\n');
  process.exit(1);
}
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
