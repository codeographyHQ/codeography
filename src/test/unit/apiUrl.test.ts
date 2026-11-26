import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { API_URL } from '../../apiUrl';

// The API URL is fixed at build time (src/apiUrl.ts, scripts/set-api-url.mjs)
// and a published build must use production (scripts/check-package-api-url.mjs).
const ROOT = path.resolve(__dirname, '../../..');
const PRODUCTION = 'https://codeography-api.codeography.workers.dev';
const STAGING = 'https://codeography-api-staging.codeography.workers.dev';

function run(script: string, args: string[], env: Record<string, string | undefined> = {}) {
	const childEnv = { ...process.env, ...env };
	for (const [k, v] of Object.entries(env)) { if (v === undefined) { delete childEnv[k]; } }
	return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { encoding: 'utf8', env: childEnv });
}

// A shipped-files directory, as tsc emits it, before set-api-url runs.
function freshOut(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-apiurl-'));
	const compiled = fs.readFileSync(path.join(ROOT, 'out', 'apiUrl.js'), 'utf8').split(`'${API_URL}'`).join(`'${PRODUCTION}'`);
	fs.writeFileSync(path.join(dir, 'apiUrl.js'), compiled);
	fs.writeFileSync(path.join(dir, 'extension.js'), `const apiUrl_1 = require("./apiUrl"); const help = 'https://codeography.dev/dashboard';`);
	fs.writeFileSync(path.join(dir, 'core.js'), `exports.x = 1;`);
	return dir;
}

test('the default build talks to the production API', { skip: process.env.CODEOGRAPHY_API_URL ? 'CODEOGRAPHY_API_URL is set in this shell' : false }, () => {
	assert.equal(API_URL, PRODUCTION);
	const check = run('check-package-api-url.mjs', [path.join(ROOT, 'out')]);
	assert.equal(check.status, 0, check.stderr);
});

test('CODEOGRAPHY_API_URL at build time sets the URL, and packaging then refuses the build', () => {
	const dir = freshOut();
	const set = run('set-api-url.mjs', [path.join(dir, 'apiUrl.js')], { CODEOGRAPHY_API_URL: STAGING });
	assert.equal(set.status, 0, set.stderr);
	assert.match(set.stdout, /NOT production/);
	assert.ok(fs.readFileSync(path.join(dir, 'apiUrl.js'), 'utf8').includes(`'${STAGING}'`));
	const check = run('check-package-api-url.mjs', [dir]);
	assert.equal(check.status, 1);
	assert.match(check.stderr, /Refusing to package/);
	assert.match(check.stderr, /codeography-api-staging/);
});

test('without CODEOGRAPHY_API_URL the build is production and passes the packaging check', () => {
	const dir = freshOut();
	const set = run('set-api-url.mjs', [path.join(dir, 'apiUrl.js')], { CODEOGRAPHY_API_URL: undefined });
	assert.equal(set.status, 0, set.stderr);
	assert.equal(run('check-package-api-url.mjs', [dir]).status, 0);
});

test('packaging refuses any other API-looking URL in shipped code, and a missing apiUrl.js', () => {
	for (const stray of ['http://localhost:8787', 'https://evil.workers.dev', 'http://127.0.0.1:8787/api']) {
		const dir = freshOut();
		fs.appendFileSync(path.join(dir, 'core.js'), `\nconst u = '${stray}';`);
		assert.equal(run('check-package-api-url.mjs', [dir]).status, 1, stray);
	}
	const dir = freshOut();
	fs.rmSync(path.join(dir, 'apiUrl.js'));
	assert.equal(run('check-package-api-url.mjs', [dir]).status, 1);
});

test('rejects malformed URLs and an already-rewritten file, changing nothing', () => {
	for (const bad of ['http://example.com', `${STAGING}/`, `${STAGING}/api`, 'not a url', 'ftp://x.workers.dev']) {
		const dir = freshOut();
		const before = fs.readFileSync(path.join(dir, 'apiUrl.js'), 'utf8');
		const set = run('set-api-url.mjs', [path.join(dir, 'apiUrl.js')], { CODEOGRAPHY_API_URL: bad });
		assert.equal(set.status, 1, bad);
		assert.equal(fs.readFileSync(path.join(dir, 'apiUrl.js'), 'utf8'), before);
	}
	const dir = freshOut();
	assert.equal(run('set-api-url.mjs', [path.join(dir, 'apiUrl.js')], { CODEOGRAPHY_API_URL: STAGING }).status, 0);
	assert.equal(run('set-api-url.mjs', [path.join(dir, 'apiUrl.js')], { CODEOGRAPHY_API_URL: undefined }).status, 1); // tsc must run first
});
