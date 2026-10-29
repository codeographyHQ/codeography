# Codeography

### You code. Codeography tells the story.

Record the shape of a coding session without uploading its source code. Codeography captures editor activity, syncs it to your account, and gives you a session story with claims linked to recorded evidence. You decide which eligible sessions to publish.

**[Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=codeographyHQ.codeography)** · [Open your dashboard](https://codeography.dev/dashboard) · [Privacy policy](https://codeography.dev/privacy)

[Get started](#get-started) · [Capabilities](#what-gets-recorded) · [Privacy](#privacy-and-control) · [Troubleshooting](#troubleshooting) · [Development](#development)

---

## Get started

**Requires VS Code 1.115.0 or newer.** Extension users do not need a separate Node.js installation.

1. Install **Codeography** by **codeographyHQ** from the Marketplace, or run:

   ```sh
   code --install-extension codeographyHQ.codeography
   ```

2. Sign in with GitHub at [codeography.dev](https://codeography.dev).
3. In the dashboard, generate an API key and choose **Connect to VS Code**. Allow VS Code to open the connection link.
4. Open a project folder and work normally. The Codeography status bar shows recording and setup problems.

If the connection link does not open, use the Command Palette (`Cmd/Ctrl+Shift+P`) and run **Codeography: Set API Key**. Keys are stored through VS Code SecretStorage, not in workspace settings.

## What gets recorded

| Signal | What it means | What it does not establish |
|---|---|---|
| File opens and saves | Activity in supported file-backed documents | The contents or purpose of the code |
| Writes outside VS Code's save command | A watched file changed on disk, recorded separately from saves | Which person, agent, or process made the change |
| Diagnostic-count changes | Changes in the editor's reported error count | Which bugs were fixed or why |
| Git commit activity | Supported commit operations observed in the reflog | The commit message or a measure of work quality |
| Session timing and languages | When activity was recorded and the languages associated with it | Continuous attention, intent, or productivity |

Generated files and common build output are filtered. Diff views and other non-file documents do not count as file activity. A VS Code save is deduplicated against the corresponding disk-write event.

## From activity to a story

```text
Editor activity → local queue → API ingestion → finalized evidence → cited narrative
```

- Queued events sync every **5 minutes**. The recorder starts a new session when activity resumes after more than **15 minutes** of inactivity.
- Each event has a stable identity. Uploads are chunked at **1,000 events** and remain queued when a request fails. Backend idempotency prevents known-ID retries from being stored twice.
- The queue is persisted per window and recovered after a crash or offline shutdown. Persistence is debounced, so activity not yet written to disk can still be lost in a sudden crash.
- The backend finalizes quiet sessions after **25 minutes** of server-observed silence and generates narratives asynchronously. A sync is not a promise that a story is ready immediately.
- Late events can reopen a session and clear an outdated narrative. `pending`, `ready`, `failed`, and `skipped` describe narrative processing, not the quality of your coding session.

Narratives describe stored evidence. They do not establish developer intent, debugging reasoning, or who authored a change. Developer-authored reasoning is not captured by this extension.

## Privacy and control

**Source code is not part of the event payload.** The recorder does not collect code text, keystrokes, clipboard contents, or diagnostic message text.

| Data | Current behavior |
|---|---|
| File identity | Basenames only, without full paths. Sensitive names such as `.env*`, keys, and credential files are omitted; activity can still be counted. |
| Project identity | The workspace folder name is not sent. |
| Commits | Messages are not sent. A seven-character SHA is included only when `codeography.includeCommitSha` is enabled; it defaults to `false`. |
| Local queue | Metadata is stored in VS Code's extension storage for recovery. Legacy queue files are retained after import and may contain older, less-filtered metadata. |
| Publication | Sessions start private. The owner chooses whether to publish an eligible session from the website. |
| Public evidence | Uses file labels rather than real basenames, and excludes commit SHAs and internal event IDs. |

Old narrative text without evidence citations cannot be published under the current rules. Do not attach queue files, API keys, or private session details to a public issue. See the [privacy policy](https://codeography.dev/privacy) for the service's data practices.

## Troubleshooting

| What you see | What to check |
|---|---|
| **Set API key** | Connect from the dashboard or run **Codeography: Set API Key**. |
| **Can't read API key** | VS Code could not read SecretStorage. Check the system keychain, reload VS Code, and reconnect if needed. Events stay queued. |
| **Sync failed** | Check whether the key was revoked or expired. Generate a replacement in the dashboard. |
| **Sync rejected** | The server refused the payload. Update the extension and report the symptom without sharing the queue. Events are retained for retry. |
| No story yet | Check the narrative status in the dashboard. Finalization and generation run asynchronously; a short or unrecognized-language session can be skipped. |
| Offline or a request timed out | Pending events are retried on a later sync or recovered on the next start. Do not delete extension storage as a troubleshooting shortcut. |
| Disk changes appear without saves | These are external-write events. The extension cannot identify the tool or author responsible. |

For a reproducible problem, [open an issue](https://github.com/codeographyHQ/codeography/issues) with the extension version, VS Code version, operating system, and a description of the status shown. Remove private information from logs and screenshots.

## Development

Use Node.js and npm with the checked-in lockfile. Security CI currently uses Node 20; VS Code supplies the runtime when the extension is running.

```sh
git clone https://github.com/codeographyHQ/codeography.git
cd codeography
npm ci
npm run compile
```

Open the repository in VS Code and press **F5** to launch an Extension Development Host. The API origin is fixed in `src/extension.ts`; do not treat a development-host run as isolated from the live service. Use only an explicitly authorized test account and approved API configuration for integration work.

| Check | Command |
|---|---|
| Typecheck without output | `npx tsc --noEmit -p .` |
| Lint | `npm run lint` |
| Compile and unit tests | `npm run test:unit` |
| VS Code integration tests | `npx vscode-test --code-version 1.115.0` |
| Watch compilation | `npm run watch` |

Integration tests may download a VS Code test runtime. Packaging and publishing are separate release actions, not prerequisites for the unit tests.

### Source map

| File | Responsibility |
|---|---|
| [src/core.ts](src/core.ts) | Recorder, session identities, retries, queue recovery, legacy import, filename filtering, and commit parsing |
| [src/extension.ts](src/extension.ts) | VS Code event wiring, SecretStorage, status bar, disk persistence, and network sync |
| [Unit tests](src/test/unit/core.test.ts) | Recorder and recovery behavior without a VS Code host |
| [Integration test](src/test/extension.test.ts) | Extension activation in the test host |
| [AGENTS.md](AGENTS.md) | Shared assistant safety and handoff rules |

## Release notes

Version **0.1.13** updates this guide. Recording, synchronization, privacy behavior, and VS Code requirements are unchanged from **0.1.12**. See [CHANGELOG.md](CHANGELOG.md) for the release history.

## License

[MIT](LICENSE).
