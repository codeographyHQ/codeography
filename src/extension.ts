import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
	Recorder, State, SyncBody, SyncResult, WriteDeduper, WRITE_DEDUPE_MS,
	emptyState, mergeRecovered, reportableName, isGeneratedPath, languageForPath,
	parseReflogCommit, readReflogSince, importLegacy, KeyCache,
} from './core';

const API_URL = 'https://codeography-api.codeography.workers.dev';
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 15_000;
const SECRET_KEY = 'codeography.apiKey';
const STATE_PREFIX = 'state-';

let recorder: Recorder | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let storageDir: string | null = null;
let stateFile: string | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let flushPendingWrites: (() => void) | null = null;
// Cached so the status bar never needs a keychain read per event.
let keys: KeyCache | null = null; // read once per sync pass, not per request
let closing = false;
let syncProblem: Extract<SyncResult, 'unauthorized' | 'rejected'> | null = null;

// The status bar must tell the truth about state — not just that the
// extension exists. A missing/invalid key looks identical to a working
// setup otherwise, and the user has no way to know nothing is syncing.
function refreshStatusBar() {
	if (!statusBar || closing) {return;}

	const warn = new vscode.ThemeColor('statusBarItem.warningBackground');

	if (keys?.unreadable) {
		statusBar.text = '$(warning) Codeography · can\'t read API key';
		statusBar.tooltip = 'Codeography could not read its API key from the system keychain, so nothing is syncing. Events stay queued.';
		statusBar.backgroundColor = warn;
		return;
	}

	// Until the keychain has answered once, the key is unknown, not missing.
	if (!keys?.known) {
		statusBar.text = '$(circle-outline) Codeography';
		statusBar.tooltip = 'Codeography is starting';
		statusBar.backgroundColor = undefined;
		return;
	}

	if (!keys.value) {
		statusBar.text = '$(warning) Codeography · set API key';
		statusBar.tooltip = 'Codeography needs an API key. Click to set it.';
		statusBar.backgroundColor = warn;
		return;
	}

	if (syncProblem === 'unauthorized') {
		statusBar.text = '$(warning) Codeography · sync failed';
		statusBar.tooltip = 'Codeography could not sync. Check your API key.';
		statusBar.backgroundColor = warn;
		return;
	}

	if (syncProblem === 'rejected') {
		statusBar.text = '$(warning) Codeography · sync rejected';
		statusBar.tooltip = 'The server rejected the upload. Your events are kept and will be retried; updating the extension may be needed.';
		statusBar.backgroundColor = warn;
		return;
	}

	const count = recorder?.state.queue.length ?? 0;
	statusBar.text = count > 0
		? `$(circle-filled) Codeography · ${count} events`
		: '$(circle-filled) Codeography';
	statusBar.tooltip = 'Codeography is recording your session';
	statusBar.backgroundColor = undefined;
}

// ---------- persistence (one file per window, recovered after a crash) ----------

function writeState(state: State) {
	if (!stateFile) {return;}
	try {
		const tmp = `${stateFile}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ ...state, ownerPid: process.pid }));
		fs.renameSync(tmp, stateFile);
	} catch (error) {
		console.error('Codeography: failed to persist queue:', error);
	}
}

// Writing the whole queue on every keystroke-driven event is wasteful; a
// short debounce bounds crash loss to ~1 s while keeping disk writes cheap.
function schedulePersist(state: State) {
	if (persistTimer) {return;}
	persistTimer = setTimeout(() => { persistTimer = null; writeState(state); refreshStatusBar(); }, 1000);
}

function flushPersist() {
	if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
	if (recorder) {writeState(recorder.state);}
}

// Persist, or remove the file if this window has nothing left to send.
function persistOrRemove() {
	flushPersist();
	if (stateFile && recorder && recorder.state.queue.length === 0 && Object.keys(recorder.state.sessions).length === 0) {
		try { fs.unlinkSync(stateFile); } catch { /* already gone */ }
	}
}

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

// Adopt queues left by windows whose extension host is gone (crash, kill,
// offline shutdown). The rename is an atomic claim, so two windows starting
// together cannot both adopt (and double-send) the same file.
function recoverOrphans(dir: string, into: State) {
	for (const name of fs.readdirSync(dir)) {
		if (!name.startsWith(STATE_PREFIX) || !name.endsWith('.json')) {continue;}
		const file = path.join(dir, name);
		if (file === stateFile) {continue;}
		try {
			const owner = JSON.parse(fs.readFileSync(file, 'utf8')).ownerPid;
			// Our own pid on a file that is not ours means a previous activation in
			// this same extension host (extension disabled and re-enabled).
			if (typeof owner === 'number' && owner !== process.pid && isAlive(owner)) {continue;}
			// Still matches state-*.json, so a crash mid-recovery leaves it
			// recoverable; mergeRecovered de-duplicates by clientEventId.
			const claimed = path.join(dir, `${STATE_PREFIX}claimed-${process.pid}-${name.slice(STATE_PREFIX.length)}`);
			fs.renameSync(file, claimed);
			mergeRecovered(into, JSON.parse(fs.readFileSync(claimed, 'utf8')));
			writeState(into);
			fs.unlinkSync(claimed);
		} catch (error) {
			console.error('Codeography: could not recover', name, error);
		}
	}
}

// Extension <= 0.1.11 kept its in-memory queue in codeography-YYYY-MM-DD.json,
// rewritten on every event. The newest file holds the latest unsent queue and
// is imported as one ended session. An older day's file is either a stale copy
// of events that were sent later or the queue of a window that quit without
// sending it; nothing tells the two apart, so it is kept (renamed so it is not
// imported) instead of uploaded or deleted.
//
// The newest file is claimed by an atomic rename before it is read, so two
// windows starting together cannot both import it. A claim whose window died
// before the import was saved is taken over on the next start; importLegacy's
// derived ids make importing it again safe.
const LEGACY = /^codeography-\d{4}-\d{2}-\d{2}\.json$/;
const LEGACY_CLAIMED = /^legacy-claimed-(\d+)-(codeography-\d{4}-\d{2}-\d{2}\.json)$/;

function retainLegacy(dir: string, name: string) {
	let target = path.join(dir, `legacy-retained-${name}`);
	for (let i = 1; fs.existsSync(target); i++) {target = path.join(dir, `legacy-retained-${i}-${name}`);}
	try { fs.renameSync(path.join(dir, name), target); } catch { /* another window moved it */ }
}

function importClaimed(dir: string, claimed: string, into: State) {
	const file = path.join(dir, claimed);
	try {
		const n = importLegacy(into, JSON.parse(fs.readFileSync(file, 'utf8')));
		writeState(into);
		fs.unlinkSync(file);
		console.log(`Codeography: migrated ${n} unsent events from an older version.`);
	} catch (error) {
		console.error('Codeography: could not import the old queue file; it is kept and retried on the next start.', error);
	}
}

function migrateLegacy(dir: string, into: State) {
	const names = fs.readdirSync(dir);
	for (const name of names) {
		const m = LEGACY_CLAIMED.exec(name);
		if (!m) {continue;}
		const owner = Number(m[1]);
		if (owner !== process.pid && isAlive(owner)) {continue;}
		const mine = `legacy-claimed-${process.pid}-${m[2]}`;
		try { if (name !== mine) {fs.renameSync(path.join(dir, name), path.join(dir, mine));} } catch { continue; }
		importClaimed(dir, mine, into);
	}

	const files = names.filter(n => LEGACY.test(n)).sort();
	if (files.length === 0) {return;}
	const newest = files[files.length - 1];
	// Older days first: if this window dies midway, the newest is still newest.
	for (const f of files.slice(0, -1)) {retainLegacy(dir, f);}
	const claimed = `legacy-claimed-${process.pid}-${newest}`;
	try { fs.renameSync(path.join(dir, newest), path.join(dir, claimed)); } catch { return; } // another window has it
	importClaimed(dir, claimed, into);
}

// ---------- network ----------

async function post(body: SyncBody, apiKey: string): Promise<number> {
	try {
		const response = await fetch(`${API_URL}/api/sessions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		return response.status;
	} catch (error) {
		console.error('Codeography: sync request failed:', error);
		return 0;
	}
}

async function syncNow() {
	if (!recorder || !keys) {return;}
	const key = await keys.refresh();
	refreshStatusBar();
	const result = await recorder.sync(key);
	if (result === 'ok') {syncProblem = null;}
	if (result === 'unauthorized') {
		syncProblem = 'unauthorized';
		console.error('Codeography: Invalid API key. Run "Codeography: Set API Key" to fix.');
	}
	if (result === 'rejected') {
		syncProblem = 'rejected';
		console.error('Codeography: the server rejected the upload; events stay queued and will retry.');
	}
	if (result === 'retry') {console.warn('Codeography: sync deferred; events stay queued and will retry.');}
	refreshStatusBar();
}

function keySaved() {
	syncProblem = null;
	refreshStatusBar();
	void syncNow();
}

export function activate(context: vscode.ExtensionContext) {
	storageDir = context.globalStorageUri.fsPath;
	fs.mkdirSync(storageDir, { recursive: true });
	stateFile = path.join(storageDir, `${STATE_PREFIX}${randomUUID()}.json`);

	const state = emptyState();
	recorder = new Recorder(state, {
		now: () => Date.now(),
		uuid: () => randomUUID(),
		post,
		persist: schedulePersist,
	});
	recoverOrphans(storageDir, state);
	migrateLegacy(storageDir, state);

	statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.command = 'codeography.setApiKey';
	statusBar.show();
	context.subscriptions.push(statusBar);

	// Reflect the REAL state: a user with a dead key must never see a
	// confident "recording" light while nothing is actually syncing, and a
	// configured user must not see a "set API key" warning while the key is
	// still being read. Neutral until the keychain answers.
	statusBar.text = '$(circle-outline) Codeography';
	keys = new KeyCache(() => context.secrets.get(SECRET_KEY), (k) => context.secrets.store(SECRET_KEY, k));
	// The key is read by the first syncNow() below. A key changed or removed in
	// another window triggers a sync here, which re-reads it and clears a stale
	// "sync failed" state, so shutdown never uses an outdated key.
	context.subscriptions.push(context.secrets.onDidChange(e => {
		if (e.key === SECRET_KEY) {void syncNow();}
	}));

	// Command: Set API Key
	const setKeyCommand = vscode.commands.registerCommand(
		'codeography.setApiKey',
		async () => {
			const key = await vscode.window.showInputBox({
				prompt: 'Paste your Codeography API key (from codeography.dev/dashboard)',
				password: true,
				placeHolder: 'cdg_live_...',
			});
			if (key && keys) {
				await keys.store(key.trim());
				vscode.window.showInformationMessage('Codeography: API key saved.');
				keySaved();
			}
		}
	);
	context.subscriptions.push(setKeyCommand);

	// URI handler: vscode://codeographyHQ.codeography/connect?key=<apiKey>
	// Triggered by the "Connect to VS Code" button on codeography.dev/dashboard.
	const uriHandler = vscode.window.registerUriHandler({
		handleUri(uri: vscode.Uri) {
			if (uri.path !== '/connect') {return;}
			const key = new URLSearchParams(uri.query).get('key')?.trim();
			// Basic sanity check — only accept something shaped like a real key.
			// Prevents a malicious link from storing arbitrary junk in SecretStorage.
			if (!key || !key.startsWith('cdg_live_') || key.length < 20) {
				vscode.window.showErrorMessage('Codeography: Invalid connection link.');
				return;
			}
			if (keys) {
				keys.store(key).then(() => {
					vscode.window.showInformationMessage('Codeography: Connected! Your session recording is now active.');
					keySaved();
				});
			}
		}
	});
	context.subscriptions.push(uriHandler);

	// The timer also ends idle sessions, so a session finalizes ~15-20 min
	// after the last activity instead of waiting for the next keystroke.
	syncTimer = setInterval(() => {
		recorder?.endIfIdle();
		void syncNow();
	}, SYNC_INTERVAL_MS);
	void syncNow(); // reads the key state and delivers anything recovered from a previous run

	// Only real files on disk. Git diff views, settings, output panels and
	// untitled buffers use other URI schemes and are not the developer's files.
	// Generated paths (node_modules, .git, build output) are not authored files.
	// Judged on the path inside the workspace, so a project kept under a folder
	// like ~/build or C:\\work\\dist is not treated as generated as a whole.
	const isGenerated = (uri: vscode.Uri) => {
		const rel = vscode.workspace.asRelativePath(uri, false);
		return isGeneratedPath(path.isAbsolute(rel) ? path.basename(uri.fsPath) : rel);
	};
	const isFile = (doc: vscode.TextDocument) => doc.uri.scheme === 'file' && !isGenerated(doc.uri);

	const deduper = new WriteDeduper();

	const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
		if (!isFile(doc)) {return;}
		deduper.save(doc.uri.fsPath, Date.now());
		recorder?.track({ type: 'file_saved', fileName: reportableName(doc.fileName), language: doc.languageId });
	});

	// Watches for file changes written directly to disk — catches AI coding
	// agents (like the standalone Claude Code CLI), formatters and other tools
	// that write files without going through VS Code's save. These stay a
	// separate event type and are never counted as developer saves.
	const fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');
	const onDisk = (uri: vscode.Uri) => {
		if (uri.scheme !== 'file' || isGenerated(uri)) {return;}
		deduper.external(uri.fsPath, Date.now());
	};
	fsWatcher.onDidChange(onDisk);
	fsWatcher.onDidCreate(onDisk);
	const emitWrites = (now: number) => {
		for (const w of deduper.flush(now)) {
			recorder?.track({ type: 'file_changed_externally', fileName: reportableName(w.path), language: languageForPath(w.path) });
		}
	};
	const dedupeTimer = setInterval(() => emitWrites(Date.now()), WRITE_DEDUPE_MS / 2);
	// On shutdown, writes still inside their dedupe window belong to this session.
	flushPendingWrites = () => { clearInterval(dedupeTimer); emitWrites(Number.POSITIVE_INFINITY); };

	const onOpen = vscode.workspace.onDidOpenTextDocument((doc) => {
		if (!isFile(doc)) {return;}
		recorder?.track({ type: 'file_opened', fileName: reportableName(doc.fileName), language: doc.languageId });
	});

	let errorDebounceTimer: NodeJS.Timeout | null = null;
	const onDiagnosticsChange = vscode.languages.onDidChangeDiagnostics(() => {
		if (errorDebounceTimer) {clearTimeout(errorDebounceTimer);}
		// Short debounce so even brief errors that are quickly fixed get captured
		errorDebounceTimer = setTimeout(() => {
			// Count total errors across ALL open files (workspace-wide)
			let totalErrors = 0;
			vscode.languages.getDiagnostics().forEach(([, diags]) => {
				totalErrors += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
			});
			recorder?.trackErrors(totalErrors);
		}, 300);
	});

	// Commits: git appends a line to .git/logs/HEAD after every ref update.
	// Only `commit:` lines (including amend/initial/merge) are commits; pulls,
	// checkouts and resets write other prefixes, and aborted commits write
	// nothing. Hooks, GPG prompts and `--wait` editors cannot race this.
	const reflogOffset = new Map<string, number>();
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const log = path.join(folder.uri.fsPath, '.git', 'logs', 'HEAD');
		if (fs.existsSync(log)) {reflogOffset.set(log, fs.statSync(log).size);}
	}
	const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/logs/HEAD');
	const onReflog = (uri: vscode.Uri) => {
		const { lines, size } = readReflogSince(uri.fsPath, reflogOffset.get(uri.fsPath));
		reflogOffset.set(uri.fsPath, size);
		const includeSha = vscode.workspace.getConfiguration('codeography').get<boolean>('includeCommitSha', false);
		for (const line of lines) {
			const commit = parseReflogCommit(line);
			if (commit) {recorder?.track({ type: 'git_commit_created', ...(includeSha ? { sha: commit.sha.slice(0, 7) } : {}) });}
		}
	};
	gitWatcher.onDidChange(onReflog);
	gitWatcher.onDidCreate(onReflog);

	context.subscriptions.push(
		onSave, onOpen, onDiagnosticsChange, fsWatcher, gitWatcher,
		{ dispose: () => clearInterval(dedupeTimer) },
	);
}

// VS Code waits for a Promise returned from deactivate() before killing the
// extension host. Returning the finalize promise (instead of firing and
// forgetting) is what lets the session actually finalize on a clean close —
// so the user's story appears in seconds, not minutes.
export async function deactivate() {
	if (syncTimer) {clearInterval(syncTimer);}

	if (statusBar) {
		statusBar.text = '$(circle-outline) Codeography';
		statusBar.tooltip = 'Codeography session ended';
	}
	closing = true; // keep the status bar as it is from here on

	// Record session_ended and mark the session for finalization, then
	// persist BEFORE the network call: if the sync does not land within the
	// cap, the next VS Code start recovers the queue and finalizes it.
	flushPendingWrites?.();
	recorder?.shutdown();
	flushPersist();

	// The same key path as any sync: a canceled SecretStorage read keeps the
	// key already in memory. If the cap wins and the sync lands later, persist
	// again so the next start does not resend what was already accepted.
	let capped = false;
	const finalSync = syncNow();
	void finalSync.then(() => { if (capped) {persistOrRemove();} }, () => {});
	try {
		await Promise.race([
			finalSync,
			new Promise<void>((resolve) => setTimeout(() => { capped = true; resolve(); }, 3000)),
		]);
	} catch (error) {
		console.error('Codeography: shutdown sync failed; the queue is saved and is sent on the next start.', error);
	} finally {
		persistOrRemove(); // a fully drained window leaves nothing to recover
	}
}
