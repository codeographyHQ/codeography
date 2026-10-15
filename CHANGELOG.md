# Change Log

All notable changes to the "codeography" extension will be documented in this file.

## [Unreleased]

- Fixed: an idle session could be finalized under the next session's id,
  after which every sync created a separate session. Each event now carries
  the session it belongs to, and a session id is kept until its finalize
  request succeeds.
- Fixed: events recorded while a sync was in flight were dropped.
- Fixed: a session's last 1-4 events were discarded on finalize.
- Fixed: more than 1000 queued events, or a session over 24 hours, caused a
  permanent sync failure. Syncs are now sent in chunks of at most 1000, and
  fields are clamped to the server's limits. If the server still rejects an
  upload, the events stay queued and the status bar says so.
- Fixed: the queue saved to disk was never read back. It is now recovered
  after a crash or an offline shutdown, per window.
- Every event has a stable `clientEventId` so the backend can drop retries.
- Git diff views and other non-file documents are no longer counted as files.
- A VS Code save is no longer also counted as an outside write; generated
  files and build output (`.git`, `node_modules`, `.next`, `out`, `dist`,
  `*.map`, ...) are ignored for opens, saves and outside writes.
- Commits are read from the git reflog: only real commits count (not aborted
  commits, pulls, checkouts or resets), and hooks or `--wait` editors no
  longer cause missed commits. Optional short SHA via
  `codeography.includeCommitSha` (off by default). Commit messages are never read
  into events.
- Secret file names (`.env*`, keys, credentials) are no longer sent, and the
  project folder name is no longer sent.
- Error-count changes no longer keep a session alive on their own.
- Requests time out after 15 seconds instead of hanging.
- The client-side `errorSummary` tally is no longer sent. The server builds
  evidence from stored events and ignores it, and its limits could reject
  uploads from very large workspaces.
- The package now contains only the runtime files.

## [0.1.11]

- Documentation update only: the README now states that the project
  folder name is sent, and that only file names are sent, never full paths

## [0.1.10]

- Hardened language detection for files changed outside VS Code: the
  language now comes from the file name only and is limited to a known
  list, so nothing path-like can be sent

## [0.1.9]

- Fixed a Windows bug where the full file path was recorded instead of
  just the file name. Only file names are recorded now, on every platform

## [0.1.8]

- Fixed sessions made only of AI agent file changes never producing a
  story, because those events had no language attached

## [0.1.7]

- Documentation update only (README corrections)

## [0.1.6]

- Added detection for file changes made outside VS Code's own save
  command (e.g. AI coding agents that write directly to disk), tracked
  as a new `file_changed_externally` event

## [0.1.5]

- Added a one-click "Connect to VS Code" flow from the dashboard,
  replacing manual API key copy-paste as the default setup path
- Manual key entry remains available as a fallback

## [0.1.4]

- Fixed a bug where local session data could be saved under an
  unstable filename, causing some sessions to go untracked

## [0.1.1] - [0.1.3]

- Early stability and bug fixes following initial launch

## [0.1.0]

- Initial release
