# Change Log

All notable changes to the "codeography" extension will be documented in this file.

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
