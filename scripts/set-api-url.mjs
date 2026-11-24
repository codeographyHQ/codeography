// Post-compile step: writes the build-time API URL into out/apiUrl.js.
// Unset CODEOGRAPHY_API_URL = production (the default, and the only URL a
// published build may contain). Usage: node scripts/set-api-url.mjs [file]
import fs from 'node:fs'

export const PRODUCTION = 'https://codeography-api.codeography.workers.dev'
const file = process.argv[2] ?? new URL('../out/apiUrl.js', import.meta.url)
const fail = (msg) => { console.error(`set-api-url: ${msg}`); process.exit(1) }

const url = (process.env.CODEOGRAPHY_API_URL ?? '').trim() || PRODUCTION
let parsed
try { parsed = new URL(url) } catch { fail('CODEOGRAPHY_API_URL is not a URL') }
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
if (parsed.origin !== url || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))) {
  fail('CODEOGRAPHY_API_URL must be a bare origin (no path or trailing slash): https, or http on localhost')
}

const source = fs.readFileSync(file, 'utf8')
const literal = `'${PRODUCTION}'`
// Exactly one occurrence, straight from tsc. Anything else means the file was
// already rewritten or changed shape: refuse rather than guess.
if (source.split(literal).length !== 2) fail(`expected the production URL exactly once in ${file}; run tsc first`)
fs.writeFileSync(file, source.replace(literal, `'${url}'`))
console.log(url === PRODUCTION
  ? `Codeography API (build-time): ${parsed.host}`
  : `Codeography API (build-time): ${parsed.host}  <- NOT production: never package this build`)
