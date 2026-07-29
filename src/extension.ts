import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const API_URL = 'https://codeography-api.codeography.workers.dev';
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_GAP_MS = 15 * 60 * 1000; // 15 min of no activity ends a session
const MIN_SESSION_EVENTS = 5; // sessions with fewer real events aren't worth narrating
const SECRET_KEY = 'codeography.apiKey';

let sessionStart: Date | null = null;
let clientSessionId: string | null = null;
let lastActivityAt: number = Date.now();
let activeProject: string | null = null;
let eventQueue: any[] = [];
let errorDebounceTimer: NodeJS.Timeout | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let peakErrors = 0;
let totalErrorsFixed = 0;
let errorsEverAppeared = false;
let lastErrorCount = 0;
let storageDir: string | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let lastSyncFailed = false;

// The status bar must tell the truth about state — not just that the
// extension exists. A missing/invalid key looks identical to a working
// setup otherwise, and the user has no way to know nothing is syncing.
async function refreshStatusBar() {
	if (!statusBar) return;

	const key = secretStorage ? await secretStorage.get(SECRET_KEY) : undefined;
	const warn = new vscode.ThemeColor('statusBarItem.warningBackground');

	if (!key) {
		statusBar.text = '$(warning) Codeography · set API key';
		statusBar.tooltip = 'Codeography needs an API key. Click to set it.';
		statusBar.backgroundColor = warn;
		return;
	}

	if (lastSyncFailed) {
		statusBar.text = '$(warning) Codeography · sync failed';
		statusBar.tooltip = 'Codeography could not sync. Check your API key.';
		statusBar.backgroundColor = warn;
		return;
	}

	const count = eventQueue.length;
	statusBar.text = count > 0
		? `$(circle-filled) Codeography · ${count} events`
		: '$(circle-filled) Codeography';
	statusBar.tooltip = 'Codeography is recording your session';
	statusBar.backgroundColor = undefined;
}
let secretStorage: vscode.SecretStorage | null = null;

export function activate(context: vscode.ExtensionContext) {
	storageDir = context.globalStorageUri.fsPath;
	secretStorage = context.secrets;

	if (!fs.existsSync(storageDir)) {
		fs.mkdirSync(storageDir, { recursive: true });
	}

	statusBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100
	);
	statusBar.command = 'codeography.setApiKey';
	statusBar.show();
	context.subscriptions.push(statusBar);

	// Reflect the REAL state: a user with a dead key must never see a
	// confident "recording" light while nothing is actually syncing.
	void refreshStatusBar();

	// Command: Set API Key
	const setKeyCommand = vscode.commands.registerCommand(
		'codeography.setApiKey',
		async () => {
			const key = await vscode.window.showInputBox({
				prompt: 'Paste your Codeography API key (from codeography.dev/dashboard)',
				password: true,
				placeHolder: 'cdg_live_...',
			});
			if (key && secretStorage) {
				await secretStorage.store(SECRET_KEY, key.trim());
				lastSyncFailed = false;
				void refreshStatusBar();
				vscode.window.showInformationMessage('Codeography: API key saved.');
			}
		}
	);
	context.subscriptions.push(setKeyCommand);

	startSession();

	syncTimer = setInterval(() => {
		syncEvents();
	}, SYNC_INTERVAL_MS);

	const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
		trackEvent({
			type: 'file_saved',
			fileName: doc.fileName.split('/').pop(),
			language: doc.languageId,
			timestamp: new Date().toISOString()
		});
	});

	const onOpen = vscode.workspace.onDidOpenTextDocument((doc) => {
		trackEvent({
			type: 'file_opened',
			fileName: doc.fileName.split('/').pop(),
			language: doc.languageId,
			timestamp: new Date().toISOString()
		});
	});

	const onDiagnosticsChange = vscode.languages.onDidChangeDiagnostics((e) => {
		if (errorDebounceTimer) clearTimeout(errorDebounceTimer);
		// Short debounce so even brief errors that are quickly fixed get captured
		errorDebounceTimer = setTimeout(() => {
			// Count total errors across ALL open files, not just changed ones
			let totalErrors = 0;
			vscode.languages.getDiagnostics().forEach(([, diags]) => {
				totalErrors += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
			});

			// Track the session-wide error arc
			if (totalErrors > peakErrors) peakErrors = totalErrors;
			if (totalErrors > 0) errorsEverAppeared = true;
			// If error count dropped, the developer fixed that many errors
			if (totalErrors < lastErrorCount) {
				totalErrorsFixed += (lastErrorCount - totalErrors);
			}
			lastErrorCount = totalErrors;

			trackEvent({
				type: 'error_count_changed',
				errorCount: totalErrors,
				timestamp: new Date().toISOString()
			});
		}, 300);
	});

	const gitWatcher = vscode.workspace.createFileSystemWatcher(
		'**/.git/COMMIT_EDITMSG'
	);
	gitWatcher.onDidChange(() => {
		trackEvent({
			type: 'git_commit_created',
			project: activeProject,
			timestamp: new Date().toISOString()
		});
	});

	context.subscriptions.push(onSave, onOpen, onDiagnosticsChange, gitWatcher);
}

function startSession() {
	sessionStart = new Date();
	clientSessionId = (globalThis.crypto?.randomUUID?.() ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`);
	lastActivityAt = Date.now();
	const workspaceFolders = vscode.workspace.workspaceFolders;
	activeProject = workspaceFolders ? workspaceFolders[0].name : 'unknown';
	trackEvent({
		type: 'session_started',
		project: activeProject,
		timestamp: sessionStart.toISOString()
	});
	console.log(`Session started: ${activeProject} (${clientSessionId})`);
}

function trackEvent(event: object) {
	const now = Date.now();
	if (sessionStart && (now - lastActivityAt) > IDLE_GAP_MS) {
		console.log('Idle gap detected — finalizing previous session.');
		void syncEvents(true);
		startSession();
	}
	lastActivityAt = now;
	eventQueue.push(event);
	void refreshStatusBar();
	console.log('Event tracked:', event);
	persistEvents();
}

function persistEvents() {
	if (!storageDir) return;
	try {
		const fileName = `codeography-${new Date().toISOString().split('T')[0]}.json`;
		const filePath = path.join(storageDir, fileName);
		fs.writeFileSync(filePath, JSON.stringify(eventQueue, null, 2));
	} catch (error) {
		console.error('Failed to persist events:', error);
	}
}

async function syncEvents(finalize: boolean = false) {
	if (!API_URL.startsWith('https://')) {
		console.error('Codeography: API_URL must use HTTPS. Aborting sync.')
		return
	}
	if (eventQueue.length === 0 || !activeProject) return;
	if (!secretStorage) return;

	// Substance gate: on finalize, a session with too few events is
	// trivial background noise, not real work. Discard it instead of
	// sending junk to the backend.
	if (finalize && eventQueue.length < MIN_SESSION_EVENTS) {
		console.log(`Codeography: discarding trivial session (${eventQueue.length} events).`);
		eventQueue = [];
		persistEvents();
		sessionStart = null;
		clientSessionId = null;
		peakErrors = 0;
		totalErrorsFixed = 0;
		errorsEverAppeared = false;
		lastErrorCount = 0;
		return;
	}

	const apiKey = await secretStorage.get(SECRET_KEY);
	if (!apiKey) {
		console.warn('Codeography: No API key set. Run "Codeography: Set API Key" first.');
		return;
	}

	try {
		const response = await fetch(`${API_URL}/api/sessions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				project: activeProject,
				clientSessionId: clientSessionId,
				finalize: finalize,
				events: eventQueue,
				startedAt: sessionStart?.toISOString(),
				durationMinutes: sessionStart
					? Math.round((Date.now() - sessionStart.getTime()) / 60000)
					: 0,
				errorSummary: {
					peakErrors,
					totalErrorsFixed,
					errorsEverAppeared,
					resolved: errorsEverAppeared && lastErrorCount === 0
				}
			})
		});

		if (response.ok) {
			lastSyncFailed = false;
			void refreshStatusBar();
			console.log(`Synced ${eventQueue.length} events to backend`);
			// Clear the queue after a successful sync so we don't re-send
			eventQueue = [];
			persistEvents();
			// Do NOT reset sessionStart here — the session clock keeps running
			// across syncs so duration measures the whole session. Error trackers
			// also persist across the session and only reset on a fresh startSession().
			if (finalize) {
				// Session ended: clear session state so the next activity starts clean
				sessionStart = null;
				clientSessionId = null;
				peakErrors = 0;
				totalErrorsFixed = 0;
				errorsEverAppeared = false;
				lastErrorCount = 0;
			}
		} else if (response.status === 401) {
			lastSyncFailed = true;
			void refreshStatusBar();
			console.error('Codeography: Invalid API key. Run "Codeography: Set API Key" to fix.');
		} else {
			console.error('Sync failed:', response.status);
		}
	} catch (error) {
		// Silent fail — events are still saved locally
		console.error('Sync error:', error);
	}
}

// VS Code waits for a Promise returned from deactivate() before killing the
// extension host. Returning the finalize promise (instead of firing and
// forgetting) is what lets the session actually finalize on a clean close —
// so the user's story appears in seconds, not minutes.
export async function deactivate() {
	if (syncTimer) clearInterval(syncTimer);

	if (statusBar) {
		statusBar.text = '$(circle-outline) Codeography';
		statusBar.tooltip = 'Codeography session ended';
	}

	// Record the session_ended event BEFORE syncing, so it actually gets sent.
	trackEvent({
		type: 'session_ended',
		project: activeProject,
		timestamp: new Date().toISOString(),
		totalEvents: eventQueue.length,
		durationMinutes: sessionStart
			? Math.round((Date.now() - sessionStart.getTime()) / 60000)
			: 0
	});

	console.log('Session ended. Total events:', eventQueue.length);

	// Finalize the session. Await it so VS Code waits for the network call,
	// but cap the wait so a slow/offline network can never hang shutdown.
	// If this doesn't land, the backend cron sweep finalizes it anyway.
	await Promise.race([
		syncEvents(true),
		new Promise<void>((resolve) => setTimeout(resolve, 3000)),
	]);
}
