/**
 * Reads a job input from the environment. GitLab CI/CD variable keys are
 * limited to letters, digits and underscores, so a hyphenated input name like
 * `read-token` is set as INPUT_READ_TOKEN.
 */
export function getInput(name: string): string {
	const envName = `INPUT_${name.replace(/[- ]/g, '_').toUpperCase()}`;
	return (process.env[envName] ?? '').trim();
}
