import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	Recorder, State, SyncBody, QueuedEvent, WriteDeduper, IDLE_GAP_MS, MAX_EVENTS_PER_SYNC,
	emptyState, mergeRecovered, isSensitiveName, reportableName, isGeneratedPath, languageForPath,
	parseReflogCommit, readReflogSince, importLegacy, KeyCache,
	uuidV5, migrateLegacy, writeFileDurable, LEGACY_MARKER, MigrationIo,
} from '../../core';

const MIN = 60_000;

function harness(responses: number[] = []) {
	let t = Date.parse('2026-10-13T09:00:00Z');
	let n = 0;
	const posts: SyncBody[] = [];
	const keysUsed: string[] = [];
	const queue = [...responses];
	let persisted = 0;
	let onPost: (() => void) | null = null;
	const rec = new Recorder(emptyState(), {
		now: () => t,
		uuid: () => `id-${++n}`,
		post: async (body, key) => {
			posts.push(JSON.parse(JSON.stringify(body)));
			keysUsed.push(key);
			onPost?.();
			return queue.length ? queue.shift()! : 201;
		},
		persist: () => { persisted++; },
	});
	return {
		rec, posts, keysUsed,
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
	await h.rec.sync('key');
	save(h.rec);
	await h.rec.sync('key');
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
	await h.rec.sync('key');
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
	assert.equal(await h.rec.sync('key'), 'retry');
	assert.ok(h.rec.state.sessions[sid], 'still tracked after failure');
	assert.equal(h.rec.state.queue.length, 2);
	assert.equal(await h.rec.sync('key'), 'ok');
	assert.equal(h.posts[1].clientSessionId, sid);
	assert.equal(h.posts[1].finalize, true);
	assert.equal(h.rec.state.sessions[sid], undefined);
});

test('ended session with an empty queue sends a finalize-only request', async () => {
	const h = harness();
	save(h.rec);
	const sid = h.rec.state.current!;
	await h.rec.sync('key');
	h.rec.endCurrent();
	await h.rec.sync('key');
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
	await h.rec.sync('key');
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
	await fresh.rec.sync('key');
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
	assert.equal(meta.lastErrorCount, 3, 'baseline is the count at session start');
	const before = h.rec.state.queue.length;
	h.rec.trackErrors(3);
	assert.equal(h.rec.state.queue.length, before, 'an unchanged count records nothing');
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
	await h.rec.sync('key');
	assert.equal(h.posts[0].finalize, true);
	assert.equal(h.posts[0].events.at(-1)!.type, 'session_ended');
});

// ---------- queue / finalize ----------

test('P1 regression: 1-4 queued events on finalize are sent, not discarded', async () => {
	const h = harness();
	save(h.rec);
	h.rec.endCurrent();
	await h.rec.sync('key');
	assert.equal(h.posts.length, 1);
	assert.equal(h.posts[0].events.length, 2);
	assert.equal(h.posts[0].finalize, true);
});

test('P0 regression: events tracked while a sync is in flight are not dropped', async () => {
	const h = harness();
	save(h.rec);
	h.duringPost(() => { save(h.rec, 'late.ts'); h.duringPost(() => {}); });
	await h.rec.sync('key');
	const sentIds = new Set(h.posts.flatMap(p => p.events.map(e => e.clientEventId)));
	const lateEvent = [...h.rec.state.queue, ...h.posts.flatMap(p => p.events)].find(e => e.fileName === 'late.ts');
	assert.ok(lateEvent);
	assert.ok(sentIds.has(lateEvent.clientEventId) || h.rec.state.queue.some(e => e.fileName === 'late.ts'));
});

test('failed sync preserves the whole queue', async () => {
	for (const status of [0, 429, 500, 503]) {
		const h = harness([status]);
		save(h.rec); save(h.rec);
		assert.equal(await h.rec.sync('key'), 'retry');
		assert.equal(h.rec.state.queue.length, 3, `status ${status}`);
	}
});

test('401 stops the sync and keeps the queue', async () => {
	const h = harness([401]);
	save(h.rec);
	assert.equal(await h.rec.sync('key'), 'unauthorized');
	assert.equal(h.rec.state.queue.length, 2);
});

test('no API key: nothing is sent and nothing is lost', async () => {
	const h = harness();
	save(h.rec);
	assert.equal(await h.rec.sync(undefined), 'no-key');
	assert.equal(h.posts.length, 0);
	assert.equal(h.rec.state.queue.length, 2);
});

test('P2 regression: >1000 events are chunked, in order, finalize only on the last chunk', async () => {
	const h = harness();
	for (let i = 0; i < 2499; i++) {save(h.rec, `f${i}.ts`);}
	h.rec.endCurrent();
	await h.rec.sync('key');
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
	assert.equal(await h.rec.sync('key'), 'retry');
	assert.equal(h.rec.state.queue.length, 501);
	assert.equal(h.posts[0].finalize, false, 'first chunk never finalizes');
	assert.equal(h.posts[1].finalize, true, 'finalize rides only on the last chunk');
	assert.ok(h.rec.state.sessions[h.posts[0].clientSessionId], 'session kept: finalize did not land');
	assert.equal(await h.rec.sync('key'), 'ok');
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
		assert.equal(await h.rec.sync('key'), 'rejected');
		assert.equal(h.rec.state.queue.length, 2, `status ${status}`);
		assert.equal(Object.keys(h.rec.state.sessions).length, 1, 'session kept');
		assert.equal(await h.rec.sync('key'), 'ok', 'retried on the next tick');
		assert.equal(h.rec.state.queue.length, 0);
	}
});

test('fields are clamped to backend limits so recorded data cannot cause a 400', async () => {
	const h = harness();
	h.rec.track({ type: 'file_saved', fileName: 'x'.repeat(900), language: 'l'.repeat(80) });
	h.rec.trackErrors(25000);
	await h.rec.sync('key');
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
		joined = h.rec.sync('key');      // deactivate's sync joins the running one
	});
	await h.rec.sync('key');
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

test('a session the backend refuses does not block other sessions, and keeps its events', async () => {
	const h = harness([400]); // first session refused, the rest accepted
	save(h.rec, 'old.ts');
	const stuck = h.rec.state.current!;
	h.rec.endCurrent();
	h.advance(MIN);
	save(h.rec, 'new.ts');
	h.rec.endCurrent();
	assert.equal(await h.rec.sync('key'), 'rejected');
	assert.ok(h.posts.some(p => p.clientSessionId !== stuck && p.finalize), 'later session still delivered');
	assert.ok(h.rec.state.sessions[stuck], 'refused session kept');
	assert.equal(h.rec.state.queue.filter(e => e.sid === stuck).length, 2);
});

test('other 4xx are refusals (no retry storm); 408/429 are retried', async () => {
	for (const status of [403, 404, 409, 410]) {
		const h = harness([status]);
		save(h.rec);
		assert.equal(await h.rec.sync('key'), 'rejected', `status ${status}`);
	}
	for (const status of [408, 429]) {
		const h = harness([status]);
		save(h.rec);
		assert.equal(await h.rec.sync('key'), 'retry', `status ${status}`);
	}
});

test('shutdown after a long idle ends the session at its last activity (no late session_ended)', async () => {
	const h = harness();
	save(h.rec);
	h.advance(4 * 60 * MIN);
	h.rec.shutdown();
	await h.rec.sync('key');
	assert.equal(h.posts[0].finalize, true);
	assert.ok(!h.posts[0].events.some(e => e.type === 'session_ended'), 'no session_ended stamped hours later');
	assert.equal(h.posts[0].durationMinutes, 0);
});

test('legacy 0.1.11 queue imports as one ended session with filtered names', async () => {
	const h = harness();
	const n = importLegacy(h.rec.state, [
		{ type: 'session_started', project: 'Client Co', timestamp: '2026-09-01T10:00:00.000Z' },
		{ type: 'file_saved', fileName: '/Users/me/Client Co/.env.production', language: 'dotenv', timestamp: '2026-09-01T10:01:00.000Z' },
		{ type: 'file_saved', fileName: 'app.ts', language: 'typescript', timestamp: '2026-09-01T10:02:00.000Z' },
		{ type: 'weird', timestamp: '2026-09-01T10:03:00.000Z' },
		{ type: 'file_saved', timestamp: 'not a date' },
	], 'codeography-2026-09-01.json');
	assert.equal(n, 3);
	await h.rec.sync('key');
	const p = h.posts[0];
	assert.equal(p.finalize, true);
	assert.deepEqual(p.events.map(e => e.fileName), [undefined, undefined, 'app.ts'], 'secret name withheld, path stripped');
	assert.ok(!JSON.stringify(p).includes('Client Co'), 'legacy project name never sent');
	assert.equal(p.durationMinutes, 2);
	assert.equal(importLegacy(h.rec.state, 'garbage', 'codeography-2026-09-01.json'), 0);
});

const canceled = () => Promise.reject(Object.assign(new Error('Canceled'), { name: 'Canceled' }));
const noWrite = async () => {};

test('KeyCache: a failed read keeps the last known key; a removed key is honored', async () => {
	let stored: string | undefined = 'k1';
	let fail = false;
	const keys = new KeyCache(() => (fail ? canceled() : Promise.resolve(stored)), noWrite);
	assert.equal(await keys.refresh(), 'k1');
	fail = true;
	assert.equal(await keys.refresh(), 'k1', 'canceled read (host shutting down) keeps k1');
	fail = false; stored = undefined;
	assert.equal(await keys.refresh(), undefined, 'key removed in storage is honored');
	const empty = new KeyCache(canceled, noWrite);
	assert.equal(await empty.refresh(), undefined, 'nothing cached and read failed: no key, nothing sent');
});

test('KeyCache: a read that started before a save cannot overwrite the saved key', async () => {
	let release!: (v: string | undefined) => void;
	const keys = new KeyCache(() => new Promise(r => { release = r; }), noWrite);
	const pending = keys.refresh();      // startup read in flight, storage still empty
	await keys.store('fresh-key');       // user connects from the dashboard
	release(undefined);                  // stale read resolves afterwards
	assert.equal(await pending, 'fresh-key');
	assert.equal(keys.value, 'fresh-key');
});

test('KeyCache: unknown until the keychain answers; only the newest read applies', async () => {
	const pending: ((v: string | undefined) => void)[] = [];
	const keys = new KeyCache(() => new Promise(r => { pending.push(r); }), noWrite);
	assert.equal(keys.known, false, 'not known before any read: show neutral, not "set API key"');
	const r1 = keys.refresh();           // a sync's read, before the key was rotated elsewhere
	const r2 = keys.refresh();           // onDidChange read, after the rotation
	pending[1]('new-key');
	await r2;
	pending[0]('old-key');               // the older read resolves last
	await r1;
	assert.equal(keys.value, 'new-key', 'an older read never overwrites a newer one');
	assert.equal(keys.known, true);
	const failing = new KeyCache(canceled, noWrite);
	await failing.refresh();
	assert.equal(failing.known, false, 'a failed read leaves the key unknown, not missing');
});

test('KeyCache.store writes storage and the cache together', async () => {
	const written: string[] = [];
	const keys = new KeyCache(() => Promise.resolve(undefined), async (k) => { written.push(k); });
	await keys.store('k9');
	assert.deepEqual(written, ['k9']);
	assert.equal(keys.value, 'k9');
	assert.equal(keys.known, true);
});

test('a key rotated mid-drain is used from the next request on, with no duplicate sends', async () => {
	// Regenerating a key on the dashboard revokes the old one, so finishing the
	// drain with the old key would only produce 401s.
	const h = harness();
	for (let i = 0; i < 2499; i++) {save(h.rec, `f${i}.ts`);}
	h.rec.endCurrent();
	h.duringPost(() => { h.duringPost(() => {}); void h.rec.sync('rotated'); }); // key changes after chunk 1
	await h.rec.sync('original');
	assert.deepEqual(h.keysUsed, ['original', 'rotated', 'rotated']);
	assert.equal(h.posts.filter(p => p.finalize).length, 1, 'finalized exactly once');
	const ids = h.posts.flatMap(p => p.events.map(e => e.clientEventId));
	assert.equal(new Set(ids).size, ids.length, 'no event sent twice');
	assert.equal(ids.length, 2500);
});

test('a key fixed during a failing sync gets its own pass right away', async () => {
	const h = harness([401]); // the old key is rejected
	save(h.rec);
	h.duringPost(() => { h.duringPost(() => {}); void h.rec.sync('valid-key'); }); // user saves a valid key
	assert.equal(await h.rec.sync('bad-key'), 'ok', 'the joined caller sees the valid key\'s result');
	assert.deepEqual(h.keysUsed, ['bad-key', 'valid-key']);
	assert.equal(h.rec.state.queue.length, 0);
});

test('a key removed mid-drain stops sending with it', async () => {
	const h = harness();
	for (let i = 0; i < 2499; i++) {save(h.rec);}
	h.duringPost(() => { h.duringPost(() => {}); void h.rec.sync(undefined); }); // key deleted after chunk 1
	assert.equal(await h.rec.sync('key'), 'no-key');
	assert.equal(h.posts.length, 1, 'no further requests with the removed key');
	assert.equal(h.rec.state.queue.length, 1500, 'the rest stays queued');
});

test('KeyCache: an always-failing keychain is reported, not hidden as "starting"', async () => {
	const keys = new KeyCache(canceled, noWrite);
	assert.equal(keys.unreadable, false, 'nothing tried yet');
	await keys.refresh();
	assert.equal(keys.unreadable, true);
	const ok = new KeyCache(() => Promise.resolve('k'), noWrite);
	await ok.refresh();
	assert.equal(ok.unreadable, false);
});

test('regression: shutdown still finalizes when the key read is canceled (reload during smoke test)', async () => {
	const h = harness();
	let fail = false;
	const keys = new KeyCache(() => (fail ? canceled() : Promise.resolve('key')), noWrite);
	await keys.refresh();                // key read while the window was running
	for (let i = 0; i < 33; i++) {save(h.rec, `f${i}.ts`);} // 34 events with session_started
	const sid = h.rec.state.current!;
	h.rec.shutdown();
	fail = true;                         // VS Code cancels SecretStorage IPC on shutdown
	// the same path syncNow() takes: refresh, then sync
	assert.equal(await h.rec.sync(await keys.refresh()), 'ok');
	assert.equal(h.posts.length, 1);
	assert.equal(h.posts[0].clientSessionId, sid);
	assert.equal(h.posts[0].finalize, true);
	assert.equal(h.posts[0].events.length, 35, '34 events plus session_ended, nothing dropped');
	assert.equal(h.rec.state.queue.length, 0);
});

test('concurrent sync calls share one run (no double send)', async () => {
	const h = harness();
	save(h.rec);
	await Promise.all([h.rec.sync('key'), h.rec.sync('key'), h.rec.sync('key')]);
	assert.equal(h.posts.length, 1);
});

test('durationMinutes is clamped to the backend limit of 1440', async () => {
	const h = harness();
	save(h.rec);
	for (let i = 0; i < 200; i++) { h.advance(10 * MIN); save(h.rec); } // 2000 min, never idle
	await h.rec.sync('key');
	assert.ok(h.posts.every(p => p.durationMinutes <= 1440));
});

// ---------- idempotency ----------

test('event id is generated once and survives retries and persistence', async () => {
	const h = harness([500]);
	save(h.rec);
	const ids = h.rec.state.queue.map(e => e.clientEventId);
	assert.equal(new Set(ids).size, ids.length);
	await h.rec.sync('key'); // 500
	const reloaded: State = JSON.parse(JSON.stringify(h.rec.state)); // what persistence writes
	assert.deepEqual(reloaded.queue.map(e => e.clientEventId), ids, 'persisted queue keeps ids');
	await h.rec.sync('key'); // 201
	assert.deepEqual(h.posts[0].events.map(e => e.clientEventId), ids);
	assert.deepEqual(h.posts[1].events.map(e => e.clientEventId), ids, 'retry keeps ids');
});

test('the wire format never includes the internal session tag or a client error tally', async () => {
	const h = harness();
	save(h.rec);
	h.rec.trackErrors(20000);
	await h.rec.sync('key');
	assert.ok(h.posts[0].events.every(e => !('sid' in e)));
	assert.ok(!('errorSummary' in h.posts[0]), 'errorSummary is not sent (backend ignores it; it could exceed its limits)');
	assert.deepEqual(Object.keys(h.posts[0]).sort(), ['clientSessionId', 'durationMinutes', 'events', 'finalize', 'project', 'startedAt']);
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
	// callers pass the workspace-relative path, so a project under ~/build is fine:
	assert.ok(!isGeneratedPath('src/app.ts'));
	assert.ok(isGeneratedPath('build/app.js'));
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
	assert.deepEqual(parseReflogCommit(line('cherry-pick: port fix')), { sha: B });
	assert.deepEqual(parseReflogCommit(line('revert: Revert "x"')), { sha: B });
	assert.deepEqual(parseReflogCommit(line("merge feature: Merge made by the 'ort' strategy.")), { sha: B });
	assert.deepEqual(parseReflogCommit(line("pull: Merge made by the 'ort' strategy.")), { sha: B });
	for (const msg of ['pull: Fast-forward', 'checkout: moving from main to x', 'reset: moving to HEAD~1',
		'rebase (pick): thing', 'merge feature: Fast-forward', 'pull --rebase (finish): returning to refs/heads/main']) {
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
	fs.writeFileSync(file, line('commit: old entry kept by expire') + '\n'); // git gc / reflog expire shrank it
	const shrunk = readReflogSince(file, r.size);
	assert.equal(shrunk.lines.length, 0, 'a shrunken log replays nothing');
	assert.equal(shrunk.size, fs.statSync(file).size, 'offset resets to the new end');
	const half = line('commit: written in two parts');
	fs.appendFileSync(file, half.slice(0, 30)); // caught mid-write
	const p1 = readReflogSince(file, shrunk.size);
	assert.deepEqual(p1.lines, [], 'partial line not consumed');
	assert.equal(p1.size, shrunk.size);
	fs.appendFileSync(file, half.slice(30) + '\n');
	const p2 = readReflogSince(file, p1.size);
	assert.deepEqual(p2.lines.map(parseReflogCommit), [{ sha: B }], 'whole line read once complete');
	assert.deepEqual(readReflogSince(path.join(dir, 'missing'), 10), { lines: [], size: 10 });
	fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 0.1.11 legacy migration ----------

const LEGACY = 'codeography-2026-09-01.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T0 = Date.parse('2026-09-01T09:00:00Z');

/** A 0.1.11-shaped queue: session_started every `perSession` events, 1 s apart, 20 min between sessions. */
function legacyQueue(count: number, perSession = count) {
	const out: Record<string, unknown>[] = [];
	let t = T0;
	for (let i = 0; i < count; i++) {
		if (i > 0 && i % perSession === 0) {t += 20 * MIN;}
		const start = i % perSession === 0;
		out.push(start
			? { type: 'session_started', project: 'Client Co', timestamp: new Date(t).toISOString() }
			: { type: 'file_saved', project: 'Client Co', fileName: `/Users/me/Client Co/f${i % 7}.ts`, language: 'typescript', timestamp: new Date(t).toISOString() });
		t += 1000;
	}
	return out;
}

const ids = (s: State) => s.queue.map(e => e.clientEventId);

test('uuidV5 matches the RFC test vector and yields valid v5 ids', () => {
	assert.equal(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
	const s = emptyState();
	importLegacy(s, legacyQueue(50, 10), LEGACY);
	assert.ok([...ids(s), ...Object.keys(s.sessions)].every(id => UUID.test(id)));
});

test('legacy sessions split at session_started markers and gaps over 15 min, order preserved', () => {
	const at = (m: number) => new Date(T0 + m * MIN).toISOString();
	const s = emptyState();
	const n = importLegacy(s, [
		{ type: 'session_started', timestamp: at(0) },
		{ type: 'file_saved', fileName: 'a.ts', timestamp: at(5) },
		{ type: 'file_saved', fileName: 'b.ts', timestamp: at(20) },            // exactly 15 min: same session
		{ type: 'file_saved', fileName: 'c.ts', timestamp: at(19) },            // clock went back: same session
		{ type: 'file_saved', fileName: 'd.ts', timestamp: at(35) },            // 16 min gap: new session
		{ type: 'session_started', timestamp: at(36) },                         // marker: new session
		{ type: 'file_saved', fileName: 'e.ts', timestamp: at(37) },
	], LEGACY);
	assert.equal(n, 7);
	assert.deepEqual(s.queue.map(e => e.fileName ?? e.type), ['session_started', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'session_started', 'e.ts']);
	const sids = [...new Set(s.queue.map(e => e.sid))];
	assert.equal(sids.length, 3);
	assert.deepEqual(s.queue.map(e => sids.indexOf(e.sid)), [0, 0, 0, 0, 1, 2, 2]);
	const [a, b, c] = sids.map(id => s.sessions[id]);
	assert.deepEqual([a.startedAt, a.lastActivityAt], [at(0), Date.parse(at(20))]);
	assert.deepEqual([b.startedAt, b.lastActivityAt], [at(35), Date.parse(at(35))]);
	assert.deepEqual([c.startedAt, c.lastActivityAt], [at(36), Date.parse(at(37))]);
	assert.ok([a, b, c].every(m => m.ended));
});

test('legacy import is idempotent and ids never collide across files, positions or sessions', () => {
	const q = legacyQueue(3000, 250);
	const s = emptyState();
	assert.equal(importLegacy(s, q, LEGACY), 3000);
	const first = ids(s);
	assert.equal(importLegacy(s, q, LEGACY), 0, 'second import adds nothing');
	assert.equal(importLegacy(s, JSON.parse(JSON.stringify(q)), LEGACY), 0, 'a re-read copy adds nothing');
	assert.deepEqual(ids(s), first);
	assert.equal(Object.keys(s.sessions).length, 12);

	const fresh = emptyState();
	importLegacy(fresh, q, LEGACY);
	assert.deepEqual(ids(fresh), first, 'a restarted window derives the same ids');
	assert.deepEqual(Object.keys(fresh.sessions), Object.keys(s.sessions));

	const other = emptyState();
	importLegacy(other, q, 'codeography-2026-09-02.json');
	const all = new Set([...first, ...ids(other), ...Object.keys(s.sessions), ...Object.keys(other.sessions)]);
	assert.equal(all.size, 2 * (3000 + 12), 'another file name gets disjoint event and session ids');

	const dup = { type: 'file_saved', fileName: 'x.ts', timestamp: new Date(T0).toISOString() };
	const same = emptyState();
	assert.equal(importLegacy(same, [dup, dup, dup], LEGACY), 3, 'identical events at different positions stay distinct');
	assert.equal(new Set(ids(same)).size, 3);
});

test('legacy ids are derived only from fields that are sent', () => {
	const s = emptyState();
	importLegacy(s, [{ type: 'file_saved', fileName: '/a/.env', timestamp: new Date(T0).toISOString() }], LEGACY);
	const t = emptyState();
	importLegacy(t, [{ type: 'file_saved', fileName: '/b/.env.local', timestamp: new Date(T0).toISOString() }], LEGACY);
	assert.deepEqual(ids(s), ids(t), 'a withheld secret name does not influence the id');
});

test('legacy import is all-or-nothing: a failure part-way leaves the state untouched', () => {
	const q: unknown[] = legacyQueue(1000);
	Object.defineProperty(q[999] as object, 'timestamp', { get() { throw new Error('unreadable'); } });
	const s = emptyState();
	assert.throws(() => importLegacy(s, q, LEGACY), /unreadable/);
	assert.equal(s.queue.length, 0);
	assert.deepEqual(s.sessions, {});
});

test('legacy import of 300k events: no stack overflow, order and ids preserved', () => {
	const q = legacyQueue(300_000, 5000);
	const s = emptyState();
	const t = Date.now();
	assert.equal(importLegacy(s, q, LEGACY), 300_000);
	assert.ok(Date.now() - t < 20_000);
	assert.equal(new Set(ids(s)).size, 300_000);
	assert.equal(Object.keys(s.sessions).length, 60);
	assert.ok(s.queue.every((e, i) => e.timestamp === q[i].timestamp), 'file order kept');
	const one = emptyState();
	assert.equal(importLegacy(one, legacyQueue(300_000).map(e => ({ ...e, type: 'file_saved' })), LEGACY), 300_000);
	const [only] = Object.values(one.sessions);
	assert.equal(only.startedAt, new Date(T0).toISOString());
	assert.equal(only.lastActivityAt, T0 + 299_999 * 1000);
});

// A storage directory with the extension's on-disk layout. persist() writes this
// window's state file; restart() is a new window recovering every state file.
function storage(legacy: Record<string, unknown> = { [LEGACY]: legacyQueue(2000, 400) }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-legacy-'));
	for (const [name, events] of Object.entries(legacy)) {fs.writeFileSync(path.join(dir, name), JSON.stringify(events, null, 2));}
	let window = 0;
	const snapshot = () => Object.fromEntries(fs.readdirSync(dir).filter(n => n.startsWith('codeography-')).map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
	const before = snapshot();
	const io = (over: Partial<MigrationIo> = {}): MigrationIo => {
		const file = path.join(dir, `state-${++window}.json`);
		return {
			persist: (st) => { writeFileDurable(file, JSON.stringify(st)); return true; },
			writeFile: writeFileDurable,
			...over,
		};
	};
	const restart = () => {
		const st = emptyState();
		for (const n of fs.readdirSync(dir).filter(f => /^state-.*\.json$/.test(f))) {
			mergeRecovered(st, JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
		}
		return st;
	};
	return {
		dir, io, restart,
		marker: () => fs.existsSync(path.join(dir, LEGACY_MARKER)),
		legacyUntouched: () => assert.deepEqual(snapshot(), before, 'legacy files never modified or deleted'),
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

test('migration imports the newest legacy file once, keeps every legacy file, then skips it', () => {
	const d = storage({ 'codeography-2026-08-31.json': legacyQueue(10), [LEGACY]: legacyQueue(2000, 400) });
	const s = emptyState();
	assert.deepEqual(migrateLegacy(d.dir, s, d.io()), { status: 'migrated', events: 2000 });
	assert.equal(Object.keys(s.sessions).length, 5);
	assert.ok(d.marker());
	d.legacyUntouched();
	const next = d.restart();
	assert.equal(migrateLegacy(d.dir, next, d.io()).status, 'already-migrated');
	assert.equal(next.queue.length, 2000);
	d.legacyUntouched();
	d.cleanup();
});

test('migration failure before persistence: no marker, next start imports the same ids', () => {
	const d = storage();
	const s = emptyState();
	assert.equal(migrateLegacy(d.dir, s, d.io({ persist: () => false })).status, 'not-persisted');
	assert.ok(!d.marker(), 'not marked migrated');
	const next = d.restart();
	assert.equal(next.queue.length, 0, 'nothing was persisted');
	assert.equal(migrateLegacy(d.dir, next, d.io()).status, 'migrated');
	assert.deepEqual(ids(next), ids(s));
	d.legacyUntouched();
	d.cleanup();
});

test('migration crash during persistence: half-written temp file is ignored, nothing orphaned', () => {
	const d = storage();
	const crash = new Error('process killed');
	const s = emptyState();
	assert.throws(() => migrateLegacy(d.dir, s, d.io({
		persist: (st) => { fs.writeFileSync(path.join(d.dir, 'state-9.json.tmp'), JSON.stringify(st).slice(0, 1000)); throw crash; },
	})), crash);
	assert.ok(!d.marker());
	const next = d.restart();
	assert.equal(next.queue.length, 0);
	assert.equal(migrateLegacy(d.dir, next, d.io()).status, 'migrated');
	assert.equal(next.queue.length, 2000);
	assert.deepEqual(ids(next), ids(s));
	d.legacyUntouched();
	d.cleanup();
});

test('migration crash after persistence, before the marker: recovery plus re-import queues nothing twice', () => {
	const d = storage();
	const s = emptyState();
	const r = migrateLegacy(d.dir, s, d.io({ writeFile: () => { throw new Error('ENOSPC'); } }));
	assert.equal(r.status, 'not-marked');
	assert.ok(!d.marker());
	const next = d.restart();                     // recovers the persisted state file
	assert.equal(next.queue.length, 2000);
	const sessions = Object.keys(next.sessions).sort();
	assert.deepEqual(migrateLegacy(d.dir, next, d.io()), { status: 'migrated', events: 0 });
	assert.equal(next.queue.length, 2000, 'no event queued twice');
	assert.deepEqual(Object.keys(next.sessions).sort(), sessions, 'no logical session duplicated');
	assert.ok(d.marker());
	d.legacyUntouched();
	d.cleanup();
});

test('unreadable legacy file or marker: left in place, nothing marked, import stays idempotent', () => {
	const d = storage();
	fs.writeFileSync(path.join(d.dir, 'codeography-2026-09-02.json'), '[{"type":"file_sa');   // 0.1.11 died mid-write
	const s = emptyState();
	assert.equal(migrateLegacy(d.dir, s, d.io()).status, 'unreadable');
	assert.equal(s.queue.length, 0);
	assert.ok(!d.marker());
	fs.rmSync(path.join(d.dir, 'codeography-2026-09-02.json'));
	assert.equal(migrateLegacy(d.dir, s, d.io()).status, 'migrated');
	fs.writeFileSync(path.join(d.dir, LEGACY_MARKER), '{not json');
	assert.deepEqual(migrateLegacy(d.dir, s, d.io()), { status: 'migrated', events: 0 }, 'corrupt marker: re-import adds nothing');
	d.cleanup();
});

test('a legacy file that grew after migration adds only its new events', () => {
	const q = legacyQueue(1000, 400);
	const d = storage({ [LEGACY]: q });
	const s = emptyState();
	migrateLegacy(d.dir, s, d.io());
	fs.writeFileSync(path.join(d.dir, LEGACY), JSON.stringify(legacyQueue(1200, 400)));
	const last = (st: State) => Object.values(st.sessions).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)!;
	const before = last(s).lastActivityAt;
	assert.deepEqual(migrateLegacy(d.dir, s, d.io()), { status: 'migrated', events: 200 });
	assert.equal(new Set(ids(s)).size, 1200);
	assert.equal(last(s).lastActivityAt, before + 200 * 1000, 'the grown session covers its new events');
	const fresh = emptyState();
	importLegacy(fresh, legacyQueue(1200, 400), LEGACY);
	assert.deepEqual(s.sessions, fresh.sessions, 'same sessions as a fresh import of the grown file');
	d.cleanup();
});

// Mock backend: (session, clientEventId) dedupe and a 30-per-60 s limiter
// without Retry-After, like production. Never touches the network.
function mockServer(script: number[] = []) {
	let now = Date.parse('2026-10-20T09:00:00Z');
	let window: number[] = [];
	const stored = new Map<string, Set<string>>();
	const finalized = new Map<string, number>();
	let accepted = 0, limited = 0, requests = 0;
	const post = async (body: SyncBody) => {
		requests++;
		let status = script.length ? script.shift()! : 0;
		if (!status) {
			window = window.filter(t => now - t < MIN);
			if (window.length >= 30) {status = 429;} else { window.push(now); status = 201; }
		}
		if (status === 429) {limited++;}
		if (status === 201) {
			const set = stored.get(body.clientSessionId) ?? new Set<string>();
			for (const e of body.events) {set.add(e.clientEventId);}
			stored.set(body.clientSessionId, set);
			accepted += body.events.length;
			if (body.finalize) {finalized.set(body.clientSessionId, (finalized.get(body.clientSessionId) ?? 0) + 1);}
		}
		now += 50;
		return status;
	};
	const recorder = (state: State) => new Recorder(state, { now: () => now, uuid: () => 'unused', post, persist() {} });
	const drain = async (rec: Recorder) => {
		for (let tick = 0; tick < 1000; tick++) {
			await rec.sync('key');
			if (rec.state.queue.length === 0 && Object.keys(rec.state.sessions).length === 0) {return tick;}
			now += 5 * MIN;                       // the extension's retry timer
		}
		throw new Error('did not drain');
	};
	const delivered = () => [...stored.values()].reduce((n, s) => n + s.size, 0);
	return { recorder, drain, stored, finalized, delivered, stats: () => ({ accepted, limited, requests }) };
}

test('imported legacy backlog drains in chunks through 429s with no loss or duplicates', async () => {
	for (const size of [999, 1000, 1001, 7000]) {
		const srv = mockServer([429, 201, 429, 429]);
		const s = emptyState();
		importLegacy(s, legacyQueue(size, 2500), LEGACY);
		const sessions = Object.keys(s.sessions).length;
		await srv.drain(srv.recorder(s));
		assert.equal(srv.delivered(), size, `${size}: every event stored once`);
		assert.equal(srv.stats().accepted, size, `${size}: no acknowledged chunk resent`);
		assert.equal(srv.finalized.size, sessions);
		assert.ok([...srv.finalized.values()].every(n => n === 1), `${size}: each session finalized once`);
	}
});

test('300k legacy backlog: drains through the limiter, survives a restart mid-drain without duplicates', async () => {
	const d = storage({ [LEGACY]: legacyQueue(300_000, 5000) });
	const srv = mockServer();
	const s = emptyState();
	assert.equal(migrateLegacy(d.dir, s, d.io()).status, 'migrated');
	// First window: sends until rate limited, then is killed; its state is lost
	// except for what was persisted at migration (the worst case).
	const first = srv.recorder(s);
	assert.equal(await first.sync('key'), 'retry');
	const sentBeforeCrash = srv.stats().accepted;
	assert.ok(sentBeforeCrash > 0 && sentBeforeCrash < 300_000);
	fs.rmSync(path.join(d.dir, LEGACY_MARKER));     // and the marker never reached disk
	const next = d.restart();
	assert.equal(migrateLegacy(d.dir, next, d.io()).status, 'migrated');
	assert.equal(next.queue.length, 300_000, 'resent events reuse their ids');
	const ticks = await srv.drain(srv.recorder(next));
	assert.equal(srv.delivered(), 300_000, 'backend stores every event exactly once');
	assert.equal(srv.finalized.size, 60);
	assert.ok(srv.stats().limited <= ticks + 1, 'at most one rate-limited request per retry tick');
	d.legacyUntouched();
	d.cleanup();
});

test('writeFileDurable replaces the file atomically and reports real I/O failures', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-durable-'));
	const file = path.join(dir, 'x.json');
	writeFileDurable(file, 'one');
	writeFileDurable(file, 'two');
	assert.equal(fs.readFileSync(file, 'utf8'), 'two');
	assert.deepEqual(fs.readdirSync(dir), ['x.json'], 'no temp file left behind');
	assert.throws(() => writeFileDurable(path.join(dir, 'missing', 'y.json'), 'z'), /ENOENT/);
	fs.rmSync(dir, { recursive: true, force: true });
});
