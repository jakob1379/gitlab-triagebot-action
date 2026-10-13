import * as esbuild from 'esbuild';

await esbuild.build({
	entryPoints: ['src/agent.ts'],
	bundle: true,
	outfile: 'dist/agent.mjs',
	format: 'esm',
	platform: 'node',
	target: 'node22',
	external: ['@mongodb-js/zstd', 'node-liblzma'],
	sourcemap: true,
	banner: {
		js: "import { createRequire as __triagebotCreateRequire } from 'node:module'; const require = __triagebotCreateRequire(import.meta.url);",
	},
});
