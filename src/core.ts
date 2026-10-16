import * as fs from 'fs';

// Session recording and sync, kept free of the `vscode` module so it can be
// unit-tested with plain Node. extension.ts wires VS Code events into this.
//
// Invariants:
// - Every queued event carries the clientSessionId it was created under, so a
//   session rotation can never move events into another session.
// - A session id stays in `sessions` until a sync with finalize:true for it
//   has succeeded.
// - Events leave the queue only after the backend acknowledged that exact
//   request (2xx). A session the backend refuses stays queued and is skipped
//   for that pass, so it cannot block other sessions.
// - Each event gets its clientEventId once, at creation; retries resend it.

export const IDLE_GAP_MS = 15 * 60 * 1000;
export const MAX_EVENTS_PER_SYNC = 1000;   // backend: events.max(1000)
export const MAX_DURATION_MIN = 1440;      // backend: durationMinutes.max(1440)
export const WRITE_DEDUPE_MS = 2000;
// Backend field limits (CreateSessionSchema). Values are clamped before sending
// so recorded data can never trigger a 400.
const MAX_FILENAME = 500, MAX_LANGUAGE = 50, MAX_ERROR_COUNT = 10000;

export interface QueuedEvent {
	clientEventId: string;
	sid: string;
	type: string;
	timestamp: string;
	fileName?: string;
	language?: string;
	errorCount?: number;
	sha?: string;
}

export interface SessionMeta {
	id: string;
	startedAt: string;
	lastActivityAt: number;
	ended: boolean;
	lastErrorCount: number;
}

export interface State {
	version: 1;
	current: string | null;
	sessions: Record<string, SessionMeta>;
	queue: QueuedEvent[];
}

export type NewEvent = Omit<QueuedEvent, 'clientEventId' | 'sid' | 'timestamp'>;

export interface SyncBody {
	project: string;
	clientSessionId: string;
	finalize: boolean;
	events: Omit<QueuedEvent, 'sid'>[];
	startedAt: string;
	durationMinutes: number;
}

export interface Deps {
	now(): number;
	uuid(): string;
	/** Resolves with the HTTP status, or 0 for network error / timeout. */
	post(body: SyncBody): Promise<number>;
	persist(state: State): void;
}

/**
 * rejected: the backend refused the request shape (400/413/422). Events stay
 * queued and are retried on the next tick; nothing is dropped. With field
 * clamping and chunking this means a client/backend contract mismatch, which
 * a newer extension or backend fixes.
 */
export type SyncResult = 'ok' | 'unauthorized' | 'retry' | 'rejected' | 'no-key';

export const emptyState = (): State => ({ version: 1, current: null, sessions: {}, queue: [] });

export class Recorder {
	private inFlight: Promise<SyncResult> | null = null;
	private again = false;
	private closed = false;
	/** Last workspace error count seen, used as the baseline of a new session. */
	private knownErrorCount: number | null = null;

	constructor(public state: State, private deps: Deps, private project = 'vscode') {}

	/** Developer or tool activity. Starts a session if needed. */
	track(e: NewEvent): void {
		if (this.closed) { return; }
		const now = this.deps.now();
		this.endIfIdle(now);
		const s = this.state.current ? this.state.sessions[this.state.current] : this.startSession(now);
		this.push(s, e, now);
		s.lastActivityAt = now;
		this.deps.persist(this.state);
	}

	/**
	 * Workspace error count changed. Diagnostics are passive: they never start
	 * or extend a session, so background analysis cannot keep a session alive.
	 */
	trackErrors(count: number): void {
		if (this.closed) { return; }
		const now = this.deps.now();
		this.knownErrorCount = count;
		this.endIfIdle(now);
		const s = this.state.current ? this.state.sessions[this.state.current] : null;
		if (!s || s.lastErrorCount === count) {return;}
		this.recordErrors(s, count, now);
		this.deps.persist(this.state);
	}

	/** Ends the current session if it has been idle longer than IDLE_GAP_MS. */
	endIfIdle(now = this.deps.now()): void {
		const s = this.state.current ? this.state.sessions[this.state.current] : null;
		if (s && now - s.lastActivityAt > IDLE_GAP_MS) {this.endCurrent();}
	}

	/** Marks the current session as ended. Its id is kept until finalize succeeds. */
	endCurrent(): void {
		if (!this.state.current) {return;}
		const s = this.state.sessions[this.state.current];
		if (s) {s.ended = true;}
		this.state.current = null;
		this.deps.persist(this.state);
	}

	/**
	 * Records session_ended for the current session, ends it, and stops
	 * recording: callbacks that fire while the window closes must not start a
	 * new session that nothing will ever end.
	 */
	shutdown(): void {
		// A session that already went idle ended at its last activity, not now.
		this.endIfIdle();
		const id = this.state.current;
		if (id) {
			this.push(this.state.sessions[id], { type: 'session_ended' }, this.deps.now());
			this.endCurrent();
		}
		this.closed = true;
	}

	/**
	 * One sync at a time. A call during a running sync joins it and forces one
	 * more pass, so state changed meanwhile (e.g. a session ended on shutdown)
	 * is not missed by the running pass's snapshot.
	 */
	sync(hasKey: boolean): Promise<SyncResult> {
		if (!hasKey) {return Promise.resolve('no-key');}
		if (this.inFlight) { this.again = true; return this.inFlight; }
		this.inFlight = (async () => {
			let result: SyncResult;
			do { this.again = false; result = await this.drain(); } while (this.again && result === 'ok');
			return result;
		})().finally(() => { this.inFlight = null; });
		return this.inFlight;
	}

	private async drain(): Promise<SyncResult> {
		let refused = false;
		const ordered = Object.values(this.state.sessions)
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		for (const meta of ordered) {
			for (;;) {
				const pending = this.state.queue.filter(e => e.sid === meta.id);
				if (pending.length === 0 && !meta.ended) {break;}
				const chunk = pending.slice(0, MAX_EVENTS_PER_SYNC);
				const finalize = meta.ended && pending.length <= MAX_EVENTS_PER_SYNC;
				const status = await this.deps.post(this.body(meta, chunk, finalize));

				if (status >= 200 && status < 300) {
					this.remove(chunk);
					if (finalize) { delete this.state.sessions[meta.id]; this.deps.persist(this.state); break; }
					this.deps.persist(this.state);
					continue;
				}
				if (status === 401) {return 'unauthorized';}
				if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
					// Refused for this session: keep its events, move on to the others.
					refused = true;
					break;
				}
				return 'retry'; // 0 (network/timeout), 408, 429, 5xx
			}
		}
		return refused ? 'rejected' : 'ok';
	}

	private body(meta: SessionMeta, chunk: QueuedEvent[], finalize: boolean): SyncBody {
		const minutes = (meta.lastActivityAt - Date.parse(meta.startedAt)) / 60000;
		return {
			project: this.project,
			clientSessionId: meta.id,
			finalize,
			events: chunk.map(({ sid: _sid, ...e }) => ({
				...e,
				...(e.fileName !== undefined ? { fileName: e.fileName.slice(0, MAX_FILENAME) } : {}),
				...(e.language !== undefined ? { language: e.language.slice(0, MAX_LANGUAGE) } : {}),
				...(e.errorCount !== undefined ? { errorCount: Math.min(MAX_ERROR_COUNT, Math.max(0, Math.round(e.errorCount))) } : {}),
			})),
			startedAt: meta.startedAt,
			durationMinutes: Math.min(MAX_DURATION_MIN, Math.max(0, Math.round(minutes))),
		};
	}

	private remove(chunk: QueuedEvent[]): void {
		const sent = new Set(chunk.map(e => e.clientEventId));
		this.state.queue = this.state.queue.filter(e => !sent.has(e.clientEventId));
	}

	private startSession(now: number): SessionMeta {
		const s: SessionMeta = {
			id: this.deps.uuid(), startedAt: new Date(now).toISOString(), lastActivityAt: now, ended: false,
			lastErrorCount: 0,
		};
		this.state.sessions[s.id] = s;
		this.state.current = s.id;
		this.push(s, { type: 'session_started' }, now);
		if (this.knownErrorCount !== null) {
			// Baseline: the count when the session began. It is a recorded fact, but
			// errors that already existed are not errors this session ran into.
			s.lastErrorCount = this.knownErrorCount;
			this.push(s, { type: 'error_count_changed', errorCount: this.knownErrorCount }, now);
		}
		return s;
	}

	private recordErrors(s: SessionMeta, count: number, now: number): void {
		s.lastErrorCount = count;
		this.push(s, { type: 'error_count_changed', errorCount: count }, now);
	}

	private push(s: SessionMeta, e: NewEvent, now: number): void {
		this.state.queue.push({ ...e, clientEventId: this.deps.uuid(), sid: s.id, timestamp: new Date(now).toISOString() });
	}
}

/**
 * The single owner of the API key in memory. VS Code cancels SecretStorage
 * IPC while the extension host shuts down (reads reject with "Canceled"), so
 * a failed read keeps the last known key instead of aborting a sync. A read
 * that succeeds with no key is honored (the key was removed). A read that
 * started before set() was called cannot overwrite the newer key.
 */
export class KeyCache {
	private key: string | undefined;
	private version = 0;

	constructor(private read: () => PromiseLike<string | undefined>) {}

	get value(): string | undefined { return this.key; }

	/** A key that was just stored (Set API Key, connect link). */
	set(key: string | undefined): void {
		this.key = key;
		this.version++;
	}

	/** Re-reads storage; on failure keeps the last known key. */
	async refresh(): Promise<string | undefined> {
		const started = this.version;
		try {
			const key = await this.read();
			if (this.version === started) {this.key = key;}
		} catch {
			// host shutting down or keychain unavailable: keep the last known key
		}
		return this.key;
	}
}

/** Merges recovered state (from a closed window) into `into`. Recovered sessions are ended. */
export function mergeRecovered(into: State, recovered: State): void {
	for (const s of Object.values(recovered.sessions ?? {})) {
		if (!into.sessions[s.id]) {into.sessions[s.id] = { ...s, ended: true };}
	}
	if (recovered.current && into.sessions[recovered.current]) {into.sessions[recovered.current].ended = true;}
	const have = new Set(into.queue.map(e => e.clientEventId));
	for (const e of recovered.queue ?? []) {
		if (have.has(e.clientEventId)) {continue;}
		if (!into.sessions[e.sid]) {
			// Events without session metadata still get delivered under their own id.
			const t = Date.parse(e.timestamp) || 0;
			into.sessions[e.sid] = {
				id: e.sid, startedAt: e.timestamp, lastActivityAt: t, ended: true,
				lastErrorCount: 0,
			};
		}
		into.queue.push(e);
	}
}

const EVENT_TYPES = new Set(['session_started', 'session_ended', 'file_opened', 'file_saved',
	'file_changed_externally', 'error_count_changed', 'git_commit_created']);

/**
 * Imports an event array persisted by extension <= 0.1.11 (no session or
 * event ids) as one ended session. Only known fields are kept and file names
 * pass the same filter as new events. Returns the number of events imported.
 */
export function importLegacy(into: State, events: unknown, uuid: () => string): number {
	if (!Array.isArray(events)) {return 0;}
	const valid = events.filter((e): e is Record<string, unknown> =>
		!!e && typeof e === 'object' && EVENT_TYPES.has(String((e as Record<string, unknown>).type))
		&& !Number.isNaN(Date.parse(String((e as Record<string, unknown>).timestamp))));
	if (valid.length === 0) {return 0;}
	const sid = uuid();
	for (const e of valid) {
		into.queue.push({
			clientEventId: uuid(), sid, type: String(e.type), timestamp: new Date(String(e.timestamp)).toISOString(),
			...(typeof e.fileName === 'string' ? { fileName: reportableName(e.fileName) } : {}),
			...(typeof e.language === 'string' ? { language: e.language } : {}),
			...(typeof e.errorCount === 'number' ? { errorCount: e.errorCount } : {}),
		});
	}
	const times = valid.map(e => Date.parse(String(e.timestamp)));
	into.sessions[sid] = {
		id: sid, startedAt: new Date(Math.min(...times)).toISOString(), lastActivityAt: Math.max(...times),
		ended: true, lastErrorCount: 0,
	};
	return valid.length;
}

// ---------- commits ----------

/**
 * Parses one line of .git/logs/HEAD. Git appends a line only after a ref
 * update has happened, and the message prefix says what kind. Counted as a
 * new commit: `commit:` (also amend/initial/merge), `cherry-pick:`, `revert:`,
 * and a merge or pull that says "Merge made by" (a real merge commit).
 * Not counted: fast-forwards, checkout, reset, rebase rewrites. Aborted
 * commits write nothing. The commit message is never returned.
 */
export function parseReflogCommit(line: string): { sha: string } | null {
	const tab = line.indexOf('\t');
	if (tab < 0) {return null;}
	const sha = line.split(' ')[1];
	if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {return null;}
	const msg = line.slice(tab + 1);
	const isCommit = /^(commit( \([a-z]+\))?|cherry-pick|revert):/.test(msg)
		|| /^(merge|pull)\b[^:]*: Merge made by/.test(msg);
	return isCommit ? { sha } : null;
}

/**
 * Complete reflog lines appended since `offset` (bytes), and the offset to
 * remember. The offset only advances past a full line, so a line caught
 * mid-write is read whole next time. With no known offset, only the newest
 * line is returned. If the log shrank (expired/rewritten), nothing is
 * returned: old commits are never re-counted.
 */
export function readReflogSince(file: string, offset: number | undefined): { lines: string[]; size: number } {
	try {
		const size = fs.statSync(file).size;
		if (offset !== undefined && size <= offset) {return { lines: [], size };}
		const from = offset ?? Math.max(0, size - 4096);
		const len = Math.min(size - from, 1 << 20);
		const buf = Buffer.alloc(len);
		const fd = fs.openSync(file, 'r');
		try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }
		const end = buf.lastIndexOf(0x0a);
		if (end < 0) {return { lines: [], size: from };}
		const lines = buf.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
		return { lines: offset === undefined ? lines.slice(-1) : lines, size: from + end + 1 };
	} catch {
		return { lines: [], size: offset ?? 0 };
	}
}

// ---------- event quality ----------

/**
 * Pairs VS Code saves with file-system change events so one write is counted
 * once. Changes within WRITE_DEDUPE_MS of a save to the same path belong to
 * that save (atomic writes and format-on-save produce several fs events).
 * Repeated external changes to one path inside the window count as one write.
 */
export class WriteDeduper {
	private saved = new Map<string, number>();
	private pending = new Map<string, number>();

	save(path: string, t: number): void {
		this.saved.set(path, t);
		this.pending.delete(path);
	}

	external(path: string, t: number): void {
		const s = this.saved.get(path);
		if (s !== undefined && Math.abs(t - s) <= WRITE_DEDUPE_MS) {return;}
		if (!this.pending.has(path)) {this.pending.set(path, t);}
	}

	/** Returns external writes whose window has closed without a matching save. */
	flush(now: number): { path: string; t: number }[] {
		const out: { path: string; t: number }[] = [];
		for (const [path, t] of this.pending) {
			if (now - t < WRITE_DEDUPE_MS) {continue;}
			this.pending.delete(path);
			const s = this.saved.get(path);
			if (s !== undefined && Math.abs(t - s) <= WRITE_DEDUPE_MS) {continue;}
			out.push({ path, t });
		}
		for (const [path, t] of this.saved) {if (now - t > 10 * WRITE_DEDUPE_MS) {this.saved.delete(path);}}
		return out;
	}
}

export function baseName(fullPath: string): string {
	return fullPath.split(/[\\/]/).pop() ?? fullPath;
}

const GENERATED_SEGMENTS = new Set([
	'.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.vercel',
	'.wrangler', '__pycache__', 'coverage', '.vscode-test',
	// common build output folders
	'out', 'dist', 'build', 'target', '.output', '.parcel-cache', '.gstack',
]);
const GENERATED_SUFFIXES = ['.map', '.tsbuildinfo', '.pyc', '.log'];

/**
 * Tool output and VCS internals that are not authored files. Pass the path
 * relative to the workspace folder: folders above the project (a project
 * kept under ~/build/...) must not count.
 */
export function isGeneratedPath(fullPath: string): boolean {
	const parts = fullPath.split(/[\\/]/);
	if (parts.some(p => GENERATED_SEGMENTS.has(p))) {return true;}
	const base = parts[parts.length - 1].toLowerCase();
	return GENERATED_SUFFIXES.some(s => base.endsWith(s));
}

const SENSITIVE_EXACT = new Set([
	'.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd', '.dev.vars', '.pgpass',
	'credentials', 'credentials.json', 'secrets.json', 'secrets.yml', 'secrets.yaml', 'kubeconfig',
	'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SENSITIVE_EXT = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.tfvars', '.secret', '.secrets'];
const ENV_EXAMPLES = /^\.env\.(example|sample|template|dist|defaults)$/;

/** True for file names that should never leave the machine. */
export function isSensitiveName(base: string): boolean {
	const b = base.toLowerCase();
	if (SENSITIVE_EXACT.has(b)) {return true;}
	if (b.startsWith('.env.')) {return !ENV_EXAMPLES.test(b);}
	if (/^service[-_]?account.*\.json$/.test(b)) {return true;}
	return SENSITIVE_EXT.some(e => b.endsWith(e));
}

/** The file name to send: basename only, or undefined if it is sensitive. */
export function reportableName(fullPath: string): string | undefined {
	const b = baseName(fullPath);
	return isSensitiveName(b) ? undefined : b;
}

const EXT_LANGUAGE: Record<string, string> = {
	ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact',
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
	py: 'python', java: 'java', kt: 'kotlin', swift: 'swift', go: 'go', rs: 'rust',
	c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', dart: 'dart', lua: 'lua',
	json: 'json', jsonc: 'jsonc', md: 'markdown', html: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
	vue: 'vue', svelte: 'svelte', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', sql: 'sql',
	sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', rb: 'ruby', php: 'php', r: 'r',
	ex: 'elixir', exs: 'elixir', zig: 'zig', txt: 'plaintext',
};
const NAME_LANGUAGE: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile' };

/** Language id for a file seen only on disk (no TextDocument). */
export function languageForPath(fullPath: string): string {
	const b = baseName(fullPath).toLowerCase();
	if (NAME_LANGUAGE[b]) {return NAME_LANGUAGE[b];}
	const dot = b.lastIndexOf('.');
	return (dot > 0 && EXT_LANGUAGE[b.slice(dot + 1)]) || 'plaintext';
}
