# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Codeography is a VS Code extension (publisher `codeographyHQ`) that passively tracks the *shape* of a coding session (files touched, saves, error counts, git commits, session duration/timing — never source code or keystrokes) and syncs it to a backend at `https://codeography-api.codeography.workers.dev`, which turns it into a narrative "story" on the user's codeography.dev dashboard.

The entire extension is currently a single file: `src/extension.ts`. There is no separate backend code in this repo — only the VS Code client.

## Commands

```bash
npm install          # install dependencies
npm run compile       # one-shot TypeScript build (src -> out)
npm run watch         # incremental compile on save (used by the default VS Code build task)
npm run lint          # eslint src
npm test              # compile + lint (pretest), then run the extension test suite via @vscode/test-cli
```

There is no separate "build single test" script — `@vscode/test-cli` runs everything matching `out/test/**/*.test.js` (configured in `.vscode-test.mjs`). To scope to one test, narrow the `files` glob in `.vscode-test.mjs` or use the "Extension Test Runner" VS Code extension mentioned in `vsc-extension-quickstart.md` to run individual tests from the Testing view.

To manually try the extension: open this folder in VS Code and press `F5` (runs the `Run Extension` launch config in `.vscode/launch.json`, which triggers the `watch` build task first) to open an Extension Development Host window with Codeography loaded.

## Architecture

Everything lives in `activate()`/`deactivate()` in `src/extension.ts`, built around a single in-memory session state (module-level `let`s — no classes, no DI):

- **Session lifecycle**: `startSession()` begins a session (new `clientSessionId`, resets error/activity counters) tied to the first workspace folder name (`activeProject`). A session auto-finalizes and a new one starts when `trackEvent()` observes a gap longer than `IDLE_GAP_MS` (15 min) since the last activity.
- **Event tracking**: VS Code listeners (`onDidSaveTextDocument`, `onDidOpenTextDocument`, `onDidChangeDiagnostics`, a `FileSystemWatcher` on `**/.git/COMMIT_EDITMSG`) push typed event objects into `eventQueue` via `trackEvent()`. Every event also updates `lastActivityAt` and calls `persistEvents()` to write the queue to disk as JSON (`<project>-<date>.json` under `context.globalStorageUri`), so events survive a crash before they're synced.
- **Error arc tracking**: diagnostics changes are debounced 300ms, then diagnostics are summed across *all* open files (not just the changed one) to compute `peakErrors`, `totalErrorsFixed`, and whether errors were ever present and are now resolved — this becomes the `errorSummary` sent with each sync.
- **Sync**: `syncEvents()` POSTs the queue plus session metadata to `${API_URL}/api/sessions`, gated by an API key stored in `context.secrets` (`SecretStorage`, key `codeography.apiKey`) — never in plain settings. Runs on a 5-minute interval (`SYNC_INTERVAL_MS`) and again on `deactivate()` with `finalize: true`. On finalize, sessions with fewer than `MIN_SESSION_EVENTS` (5) events are discarded locally rather than synced — trivial noise isn't worth narrating. On success the queue is cleared; `sessionStart`/counters only reset when `finalize` is true (mid-session syncs keep the session clock running). A 401 response marks `lastSyncFailed` for the status bar; other failures fail silently since events are already persisted locally.
- **Status bar**: `refreshStatusBar()` is the single source of truth for the status bar item and must reflect *actual* state (no key set / last sync failed / recording N queued events) rather than just "the extension is installed" — this is a deliberate invariant called out in code comments.
- **Shutdown**: `deactivate()` records a `session_ended` event before syncing (so it's included), then races `syncEvents(true)` against a 3s timeout so a slow/offline network can never hang VS Code shutdown — if the sync doesn't land in time, a backend cron sweep is expected to finalize the session later.

## Conventions

- Tabs for indentation in `src/extension.ts` (existing style — match it).
- ESLint config (`eslint.config.mjs`) enforces `curly`, `eqeqeq`, `no-throw-literal`, `semi`, and camelCase/PascalCase import naming as warnings.
- `tsconfig.json` targets ES2022/Node16 with `strict: true`; output goes to `out/`, source is `src/`.
- `API_URL` must stay `https://` — `syncEvents()` hard-aborts otherwise.
- CI (`.github/workflows/security.yml`) runs on push/PR to `main`: `npm audit --audit-level=high`, TypeScript compile, and a TruffleHog secret scan. Keep changes passing these.
