import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { getInput } from '../src/input.ts';

afterEach(() => {
	delete process.env.INPUT_READ_TOKEN;
});

describe('getInput', () => {
	// GitLab CI/CD variable keys allow only letters, digits and underscores, so
	// a hyphenated input name has to be looked up in its underscored form.
	it('maps a hyphenated input name onto its underscored variable', () => {
		process.env.INPUT_READ_TOKEN = ' token-value ';

		assert.equal(getInput('read-token'), 'token-value');
	});

	it('returns an empty string for an unset input', () => {
		assert.equal(getInput('read-token'), '');
	});
});
