// The Codeography API base URL, fixed at BUILD time. scripts/set-api-url.mjs
// rewrites this literal in the compiled out/apiUrl.js when CODEOGRAPHY_API_URL
// is set (the "Run (staging)" launch configuration does). Deliberately not a
// user or workspace setting: a workspace could otherwise send the API key to
// another server. Packaging refuses any build whose URL is not this one
// (scripts/check-package-api-url.mjs, run by vscode:prepublish).
export const API_URL: string = 'https://codeography-api.codeography.workers.dev';
