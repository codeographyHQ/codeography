import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Module = require('module');

// Runs the real extension.ts wiring (activate, save handler, status bar,
// syncNow, postSessions) without VS Code: `vscode` is a minimal stub and the
// global fetch is a fake of the session API. Nothing touches the network.

type Handler = (arg: unknown) => void;
const saves: Handler[] = [];
const secretChanges: Handler[] = [];
const status = { text: '', tooltip: '', backgroundColor: undefined as unknown, command: '', show() {}, dispose() {} };
const noop = () => ({ dispose() {} });
const vscodeStub = {
	StatusBarAlignment: { Left: 1 }, ThemeColor: class { constructor(public id: string) {} },
	ExtensionMode: { Production: 1, Development: 2, Test: 3 }, DiagnosticSeverity: { Error: 0 },
	window: {
		createStatusBarItem: () => status, registerUriHandler: noop,
		showInformationMessage: async () => undefined, showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined, showInputBox: async () => undefined,
	},
	commands: { registerCommand: noop, executeCommand: async () => undefined },
	workspace: {
		onDidSaveTextDocument: (fn: Handler) => { saves.push(fn); return { dispose() {} }; },
		onDidOpenTextDocument: noop,
		createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, dispose() {} }),
		asRelativePath: (u: { fsPath: string }) => path.basename(u.fsPath),
		getConfiguration: () => ({ get: <T>(_k: string, d: T) => d }), workspaceFolders: [],
	},
	languages: { onDidChangeDiagnostics: noop, getDiagnostics: () => [] },
};

// Fake session API with the staging contract: 410 session_deleted by client_session_id.
const posts: { sid: string; files: string[] }[] = [];
const deleted = new Set<string>();
const fakeFetch = async (_url: string, init: RequestInit) => {
	const body = JSON.parse(String(init.body)) as { clientSessionId: string; events: { fileName?: string }[] };
	posts.push({ sid: body.clientSessionId, files: body.events.map(e => e.fileName ?? '') });
	return deleted.has(body.clientSessionId)
		? new Response(JSON.stringify({ error: 'This session was deleted.', code: 'session_deleted' }), { status: 410 })
		: new Response('{}', { status: 201 });
};

const until = async (cond: () => boolean, what: string) => {
	for (let i = 0; i < 200 && !cond(); i++) {await new Promise(r => setTimeout(r, 10));}
	assert.ok(cond(), `timed out waiting for ${what}`);
};

test('extension wiring: after 410 for the active session, new saves record and sync under a new id', async () => {
	const mod = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
	const load = mod._load;
	mod._load = (req, ...rest) => req === 'vscode' ? vscodeStub : load(req, ...rest);
	const realFetch = globalThis.fetch;
	globalThis.fetch = fakeFetch as typeof fetch;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-wiring-'));
	const subscriptions: { dispose(): void }[] = [];
	const ext = require('../../extension') as { activate(c: unknown): void; deactivate(): Promise<void> };
	try {
		ext.activate({
			subscriptions, extensionMode: 3, globalStorageUri: { fsPath: dir },
			secrets: {
				get: async () => 'cdg_live_SYNTHETIC_WIRING_KEY_00',
				store: async () => {},
				onDidChange: (fn: Handler) => { secretChanges.push(fn); return { dispose() {} }; },
			},
		});
		const save = (name: string) => saves.forEach(f => f({ uri: { scheme: 'file', fsPath: `/w/${name}` }, fileName: `/w/${name}`, languageId: 'typescript' }));
		const sync = async () => { const n = posts.length; secretChanges.forEach(f => f({ key: 'codeography.apiKey' })); await until(() => posts.length > n, 'a sync'); await new Promise(r => setTimeout(r, 30)); };

		await until(() => status.text === '$(circle-filled) Codeography', 'activation');
		for (let i = 0; i < 4; i++) {save(`a${i}.ts`);}
		await until(() => status.text.endsWith('· 5 events'), 'status count');
		await sync();
		const first = posts[0].sid;
		deleted.add(first);                                   // owner deletes it on the dashboard

		save('b.ts');
		await sync();
		assert.equal(posts.at(-1)!.sid, first, 'the deleted session got its 410');
		await until(() => status.text === '$(circle-filled) Codeography', 'status after 410');

		for (let i = 0; i < 3; i++) {save(`c${i}.ts`);}
		await until(() => status.text.endsWith('· 4 events'), 'new session counted in the status bar');
		await sync();
		const last = posts.at(-1)!;
		assert.notEqual(last.sid, first, 'a new session id');
		assert.deepEqual(last.files.filter(Boolean), ['c0.ts', 'c1.ts', 'c2.ts'], 'new activity reached the server');
		assert.equal(posts.filter(p => p.sid === first).length, 2, 'deleted id sent only before its 410');
		await until(() => status.text === '$(circle-filled) Codeography', 'queue drained');
	} finally {
		await ext.deactivate();
		subscriptions.forEach(s => s.dispose());
		globalThis.fetch = realFetch;
		mod._load = load;
		fs.rmSync(dir, { recursive: true, force: true });
	}
	assert.ok(posts.every(p => p.sid === posts[0].sid || !deleted.has(p.sid)), 'no other session was refused');
});
