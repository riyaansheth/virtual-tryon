// Smallest check that fails if routing or the missing-key guard breaks.
// Run with: npm test   (deliberately runs WITHOUT .env loaded)
import assert from 'node:assert/strict'
import { start } from './server.mjs'

assert.equal(process.env.FASHN_API_KEY, undefined, 'run this without FASHN_API_KEY set')

const server = start(0)
const base = `http://localhost:${server.address().port}`

const page = await fetch(base)
assert.equal(page.status, 200)
assert.match(await page.text(), /Try-on console/i, 'root should serve the console')

assert.deepEqual(await (await fetch(`${base}/api/_key`)).json(), { ok: false })

const run = await fetch(`${base}/api/run`, { method: 'POST', body: '{}' })
assert.equal(run.status, 503, 'proxy must refuse before calling upstream when no key is set')
assert.equal((await run.json()).error, 'NoApiKey')

server.close()
console.log('ok — 4 checks passed')
