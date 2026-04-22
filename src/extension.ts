import * as vscode from 'vscode';

// Session state
let sessionStart: Date | null = null;
let activeProject: string | null = null;
let eventQueue: any[] = [];
let errorDebounceTimer: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext) {
	vscode.window.showInformationMessage('Codeography is running!');
	
	startSession();

	// Track file saves
	const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
		trackEvent({
			type: 'file_saved',
			fileName: doc.fileName.split('/').pop(),
			language: doc.languageId,
			timestamp: new Date().toISOString()
		});
	});

	// Track file opens
	const onOpen = vscode.workspace.onDidOpenTextDocument((doc) => {
		trackEvent({
			type: 'file_opened',
			fileName: doc.fileName.split('/').pop(),
			language: doc.languageId,
			timestamp: new Date().toISOString()
		});
	});

	// Track errors — debounced 2 seconds
	const onDiagnosticsChange = vscode.languages.onDidChangeDiagnostics((e) => {
		if (errorDebounceTimer) {
			clearTimeout(errorDebounceTimer);
		}
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

	context.subscriptions.push(onSave, onOpen, onDiagnosticsChange);
}

function startSession() {
	sessionStart = new Date();
	const workspaceFolders = vscode.workspace.workspaceFolders;
	activeProject = workspaceFolders 
		? workspaceFolders[0].name 
		: 'unknown';

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
}

export function deactivate() {
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