// Packaging guard: a published build must talk to the production API only.
//   node scripts/check-package-api-url.mjs [outDir]      (vscode:prepublish)
//   node scripts/check-package-api-url.mjs --vsix <file> (inspect a built .vsix)
// Fails if any shipped JavaScript contains an API-looking URL (workers.dev or
// loopback) other than production, or if out/apiUrl.js is not production.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PRODUCTION = 'https://codeography-api.codeography.workers.dev'
const SHIPPED = ['extension.js', 'core.js', 'apiUrl.js']
const API_LIKE = /https?:\/\/[^\s'"`]*(?:workers\.dev|localhost|127\.0\.0\.1|\[::1\])[^\s'"`]*/g

const problems = []
const scan = (name, text) => {
  for (const found of text.match(API_LIKE) ?? []) if (found !== PRODUCTION) problems.push(`${name}: ${found}`)
}

const args = process.argv.slice(2)
if (args[0] === '--vsix') {
  if (!args[1]) { console.error('usage: --vsix <file>'); process.exit(2) }
  const entries = execFileSync('unzip', ['-Z1', args[1]], { encoding: 'utf8' }).split('\n').filter(e => e.endsWith('.js'))
  for (const e of entries) scan(e, execFileSync('unzip', ['-p', args[1], e], { encoding: 'utf8' }))
} else {
  const dir = args[0] ?? 'out'
  for (const f of SHIPPED) {
    const p = path.join(dir, f)
    if (!fs.existsSync(p)) { problems.push(`${p}: missing`); continue }
    scan(p, fs.readFileSync(p, 'utf8'))
  }
  const m = /exports\.API_URL\s*=\s*'([^']*)'/.exec(fs.existsSync(path.join(dir, 'apiUrl.js')) ? fs.readFileSync(path.join(dir, 'apiUrl.js'), 'utf8') : '')
  if (!m || m[1] !== PRODUCTION) problems.push(`${path.join(dir, 'apiUrl.js')}: API_URL is ${m ? m[1] : 'not found'}, not production`)
}

if (problems.length) {
  console.error('Refusing to package: this build does not use the production API URL.')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('Rebuild without CODEOGRAPHY_API_URL (npm run compile).')
  process.exit(1)
}
console.log(`API URL check passed: production only (${PRODUCTION})`)
