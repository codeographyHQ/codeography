// Starts the extension against the staging build in a SEPARATE VS Code process
// with its own user data and extensions folders, so it never shares settings,
// extensions or SecretStorage (the API key) with your normal VS Code.
//
// Why not an "extensionHost" launch with --user-data-dir: that launch type asks
// the VS Code you are running to open the window in its own process, which
// ignores --user-data-dir and --extensions-dir. --profile-temp is not enough
// either: SecretStorage is application-scoped, shared by every profile.
//
// Usage (the "Run (staging)" launch configuration runs this after compiling
// with the staging URL): node scripts/run-staging.mjs
// Exits once the extension host's inspector is listening, so the debugger
// can attach on INSPECT_PORT.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const VSCODE_VERSION = '1.115.0'      // the same build the integration tests use
const INSPECT_PORT = 9339
const userData = path.join(ROOT, '.vscode-test', 'user-data-staging')
const extensions = path.join(ROOT, '.vscode-test', 'extensions-staging')
const fail = (msg) => { console.error(`run-staging: ${msg}`); process.exit(1) }

const apiUrl = /exports\.API_URL\s*=\s*'([^']*)'/.exec(fs.readFileSync(path.join(ROOT, 'out', 'apiUrl.js'), 'utf8'))?.[1]
if (!apiUrl) {fail('out/apiUrl.js has no API_URL; compile first')}

fs.mkdirSync(path.join(userData, 'User'), { recursive: true })
fs.mkdirSync(extensions, { recursive: true })
// Created once; later edits in that window are kept. No restored folders, so
// it opens an empty window; no updates, telemetry or extension auto-updates.
const settings = path.join(userData, 'User', 'settings.json')
if (!fs.existsSync(settings)) {
  fs.writeFileSync(settings, JSON.stringify({
    'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'update.mode': 'none',
    'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
  }, null, 2))
}

const { downloadAndUnzipVSCode } = createRequire(import.meta.url)('@vscode/test-electron')
const exe = await downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: path.join(ROOT, '.vscode-test') })

// Drop variables that make a child VS Code hand off to the running one or run as Node.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VSCODE_|ELECTRON_)/.test(k)))
const args = [
  `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, '--disable-extensions',
  `--extensionDevelopmentPath=${ROOT}`, `--inspect-extensions=${INSPECT_PORT}`,
  '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
]
spawn(exe, args, { detached: true, stdio: 'ignore', env }).unref()
console.log(`Staging host: API ${new URL(apiUrl).host}, VS Code ${VSCODE_VERSION}\n  user data:  ${userData}\n  extensions: ${extensions}`)

const open = () => new Promise(resolve => {
  const s = net.connect(INSPECT_PORT, '127.0.0.1', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
})
for (let i = 0; i < 120; i++) {
  if (await open()) { console.log(`Extension host inspector on ${INSPECT_PORT}`); process.exit(0) }
  await new Promise(r => setTimeout(r, 500))
}
fail(`the staging host did not open its inspector on ${INSPECT_PORT} within 60 s`)
