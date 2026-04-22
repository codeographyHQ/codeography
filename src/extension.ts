import * as vscode from 'vscode';

// Session state
let sessionStart: Date | null = null;
let activeProject: string | null = null;
let eventQueue: any[] = [];

export function activate(context: vscode.ExtensionContext) {
	vscode.window.showInformationMessage('Codeography is running!');
	console.log('Codeography is now active');

	// Start session when extension activates
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

	context.subscriptions.push(onSave, onOpen);
}

function startSession() {
	sessionStart = new Date();
	activeProject = vscode.workspace.name || 'unknown';
	console.log(`Session started: ${activeProject}`);
}

function trackEvent(event: object) {
	eventQueue.push(event);
	console.log('Event tracked:', event);
}

export function deactivate() {
	console.log('Session ended. Events captured:', eventQueue.length);
}