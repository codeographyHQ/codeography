import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const API_URL = 'https://codeography-api.codeography.workers.dev';
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SECRET_KEY = 'codeography.apiKey';

let sessionStart: Date | null = null;
let activeProject: string | null = null;
let eventQueue: any[] = [];
let errorDebounceTimer: NodeJS.Timeout | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let storageDir: string | null = null;
let statusBar: vscode.StatusBarItem | null = null;
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
	statusBar.text = '$(circle-filled) Codeography';
	statusBar.tooltip = 'Codeography is recording your session';
	statusBar.backgroundColor = new vscode.ThemeColor(
		'statusBarItem.warningBackground'
	);
	statusBar.show();
	context.subscriptions.push(statusBar);

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
		errorDebounceTimer = setTimeout(() => {
			e.uris.forEach((uri) => {
				const diagnostics = vscode.languages.getDiagnostics(uri);
				const errors = diagnostics.filter(
					d => d.severity === vscode.DiagnosticSeverity.Error
				);
				trackEvent({
					type: 'error_count_changed',
					fileName: uri.path.split('/').pop(),
					errorCount: errors.length,
					timestamp: new Date().toISOString()
				});
			});
		}, 2000);
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
	const workspaceFolders = vscode.workspace.workspaceFolders;
	activeProject = workspaceFolders ? workspaceFolders[0].name : 'unknown';
	trackEvent({
		type: 'session_started',
		project: activeProject,
		timestamp: sessionStart.toISOString()
	});
	console.log(`Session started: ${activeProject}`);
}

function trackEvent(event: object) {
	eventQueue.push(event);
	console.log('Event tracked:', event);
	persistEvents();
}

function persistEvents() {
	if (!storageDir || !activeProject) return;
	try {
		const fileName = `${activeProject}-${new Date().toISOString().split('T')[0]}.json`;
		const filePath = path.join(storageDir, fileName);
		fs.writeFileSync(filePath, JSON.stringify(eventQueue, null, 2));
	} catch (error) {
		console.error('Failed to persist events:', error);
	}
}

async function syncEvents() {
	if (!API_URL.startsWith('https://')) {
		console.error('Codeography: API_URL must use HTTPS. Aborting sync.')
		return
	}
	if (eventQueue.length === 0 || !activeProject) return;
	if (!secretStorage) return;

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
				events: eventQueue,
				startedAt: sessionStart?.toISOString(),
				durationMinutes: sessionStart
					? Math.round((Date.now() - sessionStart.getTime()) / 60000)
					: 0
			})
		});

		if (response.ok) {
			console.log(`Synced ${eventQueue.length} events to backend`);
		} else if (response.status === 401) {
			console.error('Codeography: Invalid API key. Run "Codeography: Set API Key" to fix.');
		} else {
			console.error('Sync failed:', response.status);
		}
	} catch (error) {
		// Silent fail — events are still saved locally
		console.error('Sync error:', error);
	}
}

export function deactivate() {
	if (syncTimer) clearInterval(syncTimer);

	syncEvents();

	if (statusBar) {
		statusBar.text = '$(circle-outline) Codeography';
		statusBar.tooltip = 'Codeography session ended';
	}

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
}
