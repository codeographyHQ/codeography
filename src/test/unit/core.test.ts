import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	Recorder, State, SyncBody, QueuedEvent, WriteDeduper, IDLE_GAP_MS, MAX_EVENTS_PER_SYNC,
	emptyState, mergeRecovered, isSensitiveName, reportableName, isGeneratedPath, languageForPath,
	parseReflogCommit, readReflogSince,
} from '../../core';

const MIN = 60_000;

function harness(responses: number[] = []) {
	let t = Date.parse('2026-10-13T09:00:00Z');
	let n = 0;
	const posts: SyncBody[] = [];
	const queue = [...responses];
	let persisted = 0;
	let onPost: (() => void) | null = null;
	const rec = new Recorder(emptyState(), {
		now: () => t,
		uuid: () => `id-${++n}`,
		post: async (body) => {
			posts.push(JSON.parse(JSON.stringify(body)));
			onPost?.();
			return queue.length ? queue.shift()! : 201;
		},
		persist: () => { persisted++; },
	});
	return {
		rec, posts,
		advance: (ms: number) => { t += ms; },
		respond: (...s: number[]) => queue.push(...s),
		duringPost: (fn: () => void) => { onPost = fn; },
		persistedCount: () => persisted,
	};
}
const save = (rec: Recorder, name = 'a.ts') => rec.track({ type: 'file_saved', fileName: name, language: 'typescript' });

// ---------- session lifecycle ----------

test('first activity creates one stable session; regular syncs reuse it', async () => {
	const h = harness();
	save(h.rec); save(h.rec);
	const sid = h.rec.state.current;
	assert.ok(sid);
	await h.rec.sync(true);
	save(h.rec);
	await h.rec.sync(true);
	assert.equal(h.posts.length, 2);
	assert.ok(h.posts.every(p => p.clientSessionId === sid && p.finalize === false));
	assert.equal(h.rec.state.current, sid);
	assert.deepEqual(h.posts[0].events.map(e => e.type), ['session_started', 'file_saved', 'file_saved']);
});

test('P0 regression: idle rotation finalizes the OLD id with only the old events', async () => {
	const h = harness();
	save(h.rec);
	const oldSid = h.rec.state.current;
	h.advance(IDLE_GAP_MS + MIN);
	save(h.rec, 'b.ts');
	const newSid = h.rec.state.current;
	assert.notEqual(newSid, oldSid);
	await h.rec.sync(true);
	const fin = h.posts.find(p => p.finalize)!;
	assert.equal(fin.clientSessionId, oldSid);
	assert.deepEqual(fin.events.map(e => e.fileName).filter(Boolean), ['a.ts']);
	const next = h.posts.find(p => p.clientSessionId === newSid)!;
	assert.equal(next.finalize, false);
	assert.deepEqual(next.events.map(e => e.fileName).filter(Boolean), ['b.ts']);
	// the new session keeps its id after the old one finalized
	assert.equal(h.rec.state.current, newSid);
	assert.ok(h.rec.state.sessions[newSid!]);
	assert.equal(h.rec.state.sessions[oldSid!], undefined);
});

test('session id is kept until finalize succeeds; failed finalize retries under the same id', async () => {
	const h = harness([500]);
	save(h.rec);
	const sid = h.rec.state.current!;
	h.rec.endCurrent();
	assert.equal(await h.rec.sync(true), 'retry');
	assert.ok(h.rec.state.sessions[sid], 'still tracked after failure');
	assert.equal(h.rec.state.queue.length, 2);
	assert.equal(await h.rec.sync(true), 'ok');
	assert.equal(h.posts[1].clientSessionId, sid);
	assert.equal(h.posts[1].finalize, true);
	assert.equal(h.rec.state.sessions[sid], undefined);
});

test('ended session with an empty queue sends a finalize-only request', async () => {
	const h = harness();
	save(h.rec);
	const sid = h.rec.state.current!;
	await h.rec.sync(true);
	h.rec.endCurrent();
	await h.rec.sync(true);
	assert.deepEqual(h.posts[1], { ...h.posts[1], clientSessionId: sid, finalize: true, events: [] });
});

test('new activity right after a session ends starts a new session', () => {
	const h = harness();
	save(h.rec);
	const a = h.rec.state.current;
	h.rec.endCurrent();
	save(h.rec);
	assert.notEqual(h.rec.state.current, a);
	assert.equal(h.rec.state.sessions[a!].ended, true);
});

test('sleep/resume: timer-driven idle check ends the session without new activity', async () => {
	const h = harness();
	save(h.rec);
	const sid = h.rec.state.current!;
	h.advance(8 * 60 * MIN); // laptop asleep overnight
	h.rec.endIfIdle();
	assert.equal(h.rec.state.current, null);
	await h.rec.sync(true);
	assert.equal(h.posts[0].clientSessionId, sid);
	assert.equal(h.posts[0].finalize, true);
	assert.equal(h.posts[0].durationMinutes, 0, 'duration ends at last activity, not at wake-up');
});

test('restart recovery: a crashed window queue finalizes under its original ids', async () => {
	const crashed = harness();
	save(crashed.rec); save(crashed.rec, 'b.ts');
	const sid = crashed.rec.state.current!;
	const onDisk: State = JSON.parse(JSON.stringify(crashed.rec.state)); // persisted, then crash
	const ids = onDisk.queue.map(e => e.clientEventId);

	const fresh = harness();
	mergeRecovered(fresh.rec.state, onDisk);
	await fresh.rec.sync(true);
	assert.equal(fresh.posts.length, 1);
	assert.equal(fresh.posts[0].clientSessionId, sid);
	assert.equal(fresh.posts[0].finalize, true);
	assert.deepEqual(fresh.posts[0].events.map(e => e.clientEventId), ids, 'ids survive restart');
});

test('recovering the same file twice does not duplicate events', () => {
	const h = harness();
	save(h.rec);
	const snap: State = JSON.parse(JSON.stringify(h.rec.state));
	const into = emptyState();
	mergeRecovered(into, snap);
	mergeRecovered(into, snap);
	assert.equal(into.queue.length, snap.queue.length);
});

test('diagnostics are passive: they never start or extend a session', () => {
	const h = harness();
	h.rec.trackErrors(3);
	assert.equal(h.rec.state.current, null);
	assert.equal(h.rec.state.queue.length, 0);
	save(h.rec);
	const types = h.rec.state.queue.map(e => e.type);
	assert.deepEqual(types, ['session_started', 'error_count_changed', 'file_saved'], 'baseline count recorded at start');
	const meta = h.rec.state.sessions[h.rec.state.current!];
	assert.equal(meta.peakErrors, 0, 'pre-existing errors are not this session\'s errors');
	assert.equal(meta.errorsEverAppeared, false);
	h.rec.trackErrors(5);
	assert.equal(meta.peakErrors, 5, 'a rise above the baseline counts');
	assert.equal(meta.errorsEverAppeared, true);
	const last = h.rec.state.sessions[h.rec.state.current!].lastActivityAt;
	h.advance(MIN);
	h.rec.trackErrors(0);
	assert.equal(h.rec.state.sessions[h.rec.state.current!].lastActivityAt, last);
	h.advance(IDLE_GAP_MS);
	h.rec.trackErrors(5); // background churn after idle
	assert.equal(h.rec.state.current, null, 'idle session ended, no new session from diagnostics');
});

test('shutdown records session_ended and marks the session for finalize', async () => {
	const h = harness();
	save(h.rec);
	h.rec.shutdown();
	await h.rec.sync(true);
	assert.equal(h.posts[0].finalize, true);
	assert.equal(h.posts[0].events.at(-1)!.type, 'session_ended');
});

// ---------- queue / finalize ----------

test('P1 regression: 1-4 queued events on finalize are sent, not discarded', async () => {
	const h = harness();
	save(h.rec);
	h.rec.endCurrent();
	await h.rec.sync(true);
	assert.equal(h.posts.length, 1);
	assert.equal(h.posts[0].events.length, 2);
	assert.equal(h.posts[0].finalize, true);
});

test('P0 regression: events tracked while a sync is in flight are not dropped', async () => {
	const h = harness();
	save(h.rec);
	h.duringPost(() => { save(h.rec, 'late.ts'); h.duringPost(() => {}); });
	await h.rec.sync(true);
	const sentIds = new Set(h.posts.flatMap(p => p.events.map(e => e.clientEventId)));
	const lateEvent = [...h.rec.state.queue, ...h.posts.flatMap(p => p.events)].find(e => e.fileName === 'late.ts');
	assert.ok(lateEvent);
	assert.ok(sentIds.has(lateEvent.clientEventId) || h.rec.state.queue.some(e => e.fileName === 'late.ts'));
});

test('failed sync preserves the whole queue', async () => {
	for (const status of [0, 429, 500, 503]) {
		const h = harness([status]);
		save(h.rec); save(h.rec);
		assert.equal(await h.rec.sync(true), 'retry');
		assert.equal(h.rec.state.queue.length, 3, `status ${status}`);
	}
});

test('401 stops the sync and keeps the queue', async () => {
	const h = harness([401]);
	save(h.rec);
	assert.equal(await h.rec.sync(true), 'unauthorized');
	assert.equal(h.rec.state.queue.length, 2);
});

test('no API key: nothing is sent and nothing is lost', async () => {
	const h = harness();
	save(h.rec);
	assert.equal(await h.rec.sync(false), 'no-key');
	assert.equal(h.posts.length, 0);
	assert.equal(h.rec.state.queue.length, 2);
});

test('P2 regression: >1000 events are chunked, in order, finalize only on the last chunk', async () => {
	const h = harness();
	for (let i = 0; i < 2499; i++) {save(h.rec, `f${i}.ts`);}
	h.rec.endCurrent();
	await h.rec.sync(true);
	assert.deepEqual(h.posts.map(p => p.events.length), [MAX_EVENTS_PER_SYNC, MAX_EVENTS_PER_SYNC, 500]);
	assert.deepEqual(h.posts.map(p => p.finalize), [false, false, true]);
	const names = h.posts.flatMap(p => p.events.map(e => e.fileName)).filter(Boolean);
	assert.equal(names[0], 'f0.ts');
	assert.equal(names.at(-1), 'f2498.ts');
	assert.equal(h.rec.state.queue.length, 0);
});

test('partial chunk success removes only acknowledged chunks; retry finishes the rest', async () => {
	const h = harness([201, 500]);
	for (let i = 0; i < 1500; i++) {save(h.rec);}
	h.rec.endCurrent();
	assert.equal(await h.rec.sync(true), 'retry');
	assert.equal(h.rec.state.queue.length, 501);
	assert.equal(h.posts[0].finalize, false, 'first chunk never finalizes');
	assert.equal(h.posts[1].finalize, true, 'finalize rides only on the last chunk');
	assert.ok(h.rec.state.sessions[h.posts[0].clientSessionId], 'session kept: finalize did not land');
	assert.equal(await h.rec.sync(true), 'ok');
	assert.equal(h.posts.length, 3);
	assert.equal(h.posts[2].finalize, true);
	assert.deepEqual(h.posts[2].events.map(e => e.clientEventId), h.posts[1].events.map(e => e.clientEventId), 'retry resends the same ids');
	const all = h.posts.filter((_, i) => i !== 1).flatMap(p => p.events.map(e => e.clientEventId));
	assert.equal(new Set(all).size, 1501, 'every event delivered exactly once across successful requests');
});

test('400/413/422 keep every event queued (no silent drop) and retry later', async () => {
	for (const status of [400, 413, 422]) {
		const h = harness([status]);
		save(h.rec);
		h.rec.endCurrent();
		assert.equal(await h.rec.sync(true), 'rejected');
		assert.equal(h.rec.state.queue.length, 2, `status ${status}`);
		assert.equal(Object.keys(h.rec.state.sessions).length, 1, 'session kept');
		assert.equal(await h.rec.sync(true), 'ok', 'retried on the next tick');
		assert.equal(h.rec.state.queue.length, 0);
	}
});

test('fields are clamped to backend limits so recorded data cannot cause a 400', async () => {
	const h = harness();
	h.rec.track({ type: 'file_saved', fileName: 'x'.repeat(900), language: 'l'.repeat(80) });
	h.rec.trackErrors(25000);
	await h.rec.sync(true);
	const evs = h.posts[0].events;
	assert.equal(evs.find(e => e.type === 'file_saved')!.fileName!.length, 500);
	assert.equal(evs.find(e => e.type === 'file_saved')!.language!.length, 50);
	assert.equal(evs.find(e => e.type === 'error_count_changed')!.errorCount, 10000);
	assert.equal(h.rec.state.sessions[h.rec.state.current!].lastErrorCount, 25000, 'local state keeps the true value');
});

test('a sync requested during a running sync gets one more pass (shutdown finalize is not missed)', async () => {
	const h = harness();
	save(h.rec);
	let joined: Promise<unknown> | null = null;
	h.duringPost(() => {
		h.duringPost(() => {});
		h.rec.shutdown();               // window closes while the timer sync is mid-request
		joined = h.rec.sync(true);      // deactivate's sync joins the running one
	});
	await h.rec.sync(true);
	await joined;
	assert.ok(h.posts.some(p => p.finalize), 'finalize was sent in the extra pass');
	assert.equal(Object.keys(h.rec.state.sessions).length, 0);
});

test('after shutdown, late callbacks cannot start a session nothing will end', () => {
	const h = harness();
	save(h.rec);
	h.rec.shutdown();
	save(h.rec);
	h.rec.trackErrors(4);
	assert.equal(h.rec.state.current, null);
	assert.equal(Object.keys(h.rec.state.sessions).length, 1);
});

test('concurrent sync calls share one run (no double send)', async () => {
	const h = harness();
	save(h.rec);
	await Promise.all([h.rec.sync(true), h.rec.sync(true), h.rec.sync(true)]);
	assert.equal(h.posts.length, 1);
});

test('durationMinutes is clamped to the backend limit of 1440', async () => {
	const h = harness();
	save(h.rec);
	for (let i = 0; i < 200; i++) { h.advance(10 * MIN); save(h.rec); } // 2000 min, never idle
	await h.rec.sync(true);
	assert.ok(h.posts.every(p => p.durationMinutes <= 1440));
});

// ---------- idempotency ----------

test('event id is generated once and survives retries and persistence', async () => {
	const h = harness([500]);
	save(h.rec);
	const ids = h.rec.state.queue.map(e => e.clientEventId);
	assert.equal(new Set(ids).size, ids.length);
	await h.rec.sync(true); // 500
	const reloaded: State = JSON.parse(JSON.stringify(h.rec.state)); // what persistence writes
	assert.deepEqual(reloaded.queue.map(e => e.clientEventId), ids, 'persisted queue keeps ids');
	await h.rec.sync(true); // 201
	assert.deepEqual(h.posts[0].events.map(e => e.clientEventId), ids);
	assert.deepEqual(h.posts[1].events.map(e => e.clientEventId), ids, 'retry keeps ids');
});

test('the wire format never includes the internal session tag', async () => {
	const h = harness();
	save(h.rec);
	await h.rec.sync(true);
	assert.ok(h.posts[0].events.every(e => !('sid' in e)));
});

// ---------- event quality ----------

test('one VS Code save that triggers several fs events counts once', () => {
	const d = new WriteDeduper();
	d.save('/p/a.ts', 1000);
	d.external('/p/a.ts', 1050);
	d.external('/p/a.ts', 1400);
	assert.deepEqual(d.flush(5000), []);
});

test('fs event that arrives before the save is still matched to it', () => {
	const d = new WriteDeduper();
	d.external('/p/a.ts', 1000);
	d.save('/p/a.ts', 1100);
	assert.deepEqual(d.flush(5000), []);
});

test('external writes with no save are reported once per burst', () => {
	const d = new WriteDeduper();
	d.external('/p/b.ts', 1000);
	d.external('/p/b.ts', 1200);
	assert.deepEqual(d.flush(1500), [], 'window still open');
	assert.deepEqual(d.flush(3500), [{ path: '/p/b.ts', t: 1000 }]);
	d.external('/p/b.ts', 9000);
	assert.deepEqual(d.flush(12000), [{ path: '/p/b.ts', t: 9000 }], 'a later write counts again');
});

test('language fallback for files seen only on disk', () => {
	assert.equal(languageForPath('/x/a.tsx'), 'typescriptreact');
	assert.equal(languageForPath('/x/util.mjs'), 'javascript');
	assert.equal(languageForPath('/x/Dockerfile'), 'dockerfile');
	assert.equal(languageForPath('/x/mystery.zzz'), 'plaintext');
});

test('generated and VCS paths are not external writes', () => {
	assert.ok(isGeneratedPath('/r/.git/index'));
	assert.ok(isGeneratedPath('/r/node_modules/x/index.js'));
	assert.ok(isGeneratedPath('/r/.next/cache/a.js'));
	assert.ok(isGeneratedPath('/r/out/extension.js.map'));
	assert.ok(isGeneratedPath('/r/out/extension.js'));
	assert.ok(isGeneratedPath('/r/dist/bundle.js'));
	assert.ok(isGeneratedPath('/r/target/debug/app'));
	assert.ok(isGeneratedPath('/r/.gstack/chromium-profile/Default/Cookies'));
	assert.ok(!isGeneratedPath('/r/src/out-of-band.ts'));
	assert.ok(!isGeneratedPath('/r/src/index.ts'));
});

test('sensitive file names are withheld; normal names and paths are reduced to basenames', () => {
	for (const s of ['.env', '.env.local', '.env.production', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519',
		'.npmrc', '.dev.vars', 'credentials.json', 'service-account-prod.json', 'prod.tfvars', '.git-credentials']) {
		assert.ok(isSensitiveName(s), s);
		assert.equal(reportableName(`/home/u/proj/${s}`), undefined, s);
	}
	for (const ok of ['.env.example', 'index.ts', 'keyboard.ts', 'config.json', 'monkey.py', 'README.md']) {
		assert.ok(!isSensitiveName(ok), ok);
	}
	assert.equal(reportableName('C:\\Users\\me\\Client Co\\src\\app.ts'), 'app.ts');
	assert.equal(reportableName('/Users/me/secret-client/src/app.ts'), 'app.ts');
});

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const line = (msg: string, to = B) => `${A} ${to} Dev <d@example.com> 1760000000 +0000\t${msg}`;

test('reflog: only real commits count, never the message', () => {
	assert.deepEqual(parseReflogCommit(line('commit: fix login bug')), { sha: B });
	assert.deepEqual(parseReflogCommit(line('commit (amend): reword')), { sha: B });
	assert.deepEqual(parseReflogCommit(line('commit (initial): first')), { sha: B });
	assert.deepEqual(parseReflogCommit(line('commit (merge): Merge branch x')), { sha: B });
	for (const msg of ['pull: Fast-forward', 'checkout: moving from main to x', 'reset: moving to HEAD~1',
		'rebase (pick): thing', 'merge feature: Fast-forward', 'cherry-pick: thing']) {
		assert.equal(parseReflogCommit(line(msg)), null, msg);
	}
	assert.equal(parseReflogCommit('garbage'), null);
	assert.ok(!JSON.stringify(parseReflogCommit(line('commit: SECRET-msg'))).includes('SECRET'));
});

test('reflog: reads every line appended since the last offset; rewritten log is not re-counted', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-reflog-'));
	const file = path.join(dir, 'HEAD');
	fs.writeFileSync(file, line('commit (initial): one') + '\n');
	const base = fs.statSync(file).size;
	assert.deepEqual(readReflogSince(file, base).lines, [], 'nothing new');
	fs.appendFileSync(file, line('commit: two') + '\n' + line('checkout: x') + '\n' + line('commit: three') + '\n');
	const r = readReflogSince(file, base);
	assert.equal(r.lines.length, 3, 'two quick commits are both seen');
	assert.equal(r.lines.map(parseReflogCommit).filter(Boolean).length, 2);
	fs.writeFileSync(file, line('commit: after expire') + '\n'); // log shrank
	assert.equal(readReflogSince(file, r.size).lines.length, 1, 'only the newest line, old commits not replayed');
	assert.deepEqual(readReflogSince(path.join(dir, 'missing'), 10), { lines: [], size: 10 });
	fs.rmSync(dir, { recursive: true, force: true });
});
