// Smallest check that fails if access control, rate limiting or routing breaks.
// Run with: npm test   (deliberately runs WITHOUT .env loaded, so no key is set)
import assert from 'node:assert/strict'

for (const k of ['FASHN_API_KEY', 'OPENAI_API_KEY']) {
  assert.equal(process.env[k], undefined, `run this without ${k} set`)
}

process.env.ACCESS_PASSWORD = 'open-sesame'
process.env.RATE_LIMIT = '2'
const { start } = await import('./server.mjs')

const server = start(0)
const base = `http://localhost:${server.address().port}`
const auth = { authorization: `Basic ${Buffer.from(':open-sesame').toString('base64')}` }
const get = (path, headers) => fetch(base + path, { headers })
const run = () => fetch(`${base}/api/run`, { method: 'POST', headers: auth, body: '{}' })

// access control
const noAuth = await get('/')
assert.equal(noAuth.status, 401, 'page must be closed when ACCESS_PASSWORD is set')
assert.match(noAuth.headers.get('www-authenticate') || '', /^Basic/, 'browser needs the challenge')
const wrong = await get('/', { authorization: `Basic ${Buffer.from(':nope').toString('base64')}` })
assert.equal(wrong.status, 401, 'wrong password must not get in')

// routing
const page = await get('/', auth)
assert.equal(page.status, 200)
assert.match(await page.text(), /Dizrupt Try-On/i, 'root should serve the console')
assert.deepEqual(await (await get('/api/_key', auth)).json(), { ok: false, provider: 'fashn' })

// rate limiting, then the missing-key guard behind it
for (const attempt of [1, 2]) {
  const res = await run()
  assert.equal(res.status, 503, `attempt ${attempt} should pass the limiter and hit the key guard`)
  assert.equal((await res.json()).error, 'NoApiKey')
}
const limited = await run()
assert.equal(limited.status, 429, 'third generation must be throttled')
assert.equal((await limited.json()).error, 'RateLimited')
assert.ok(limited.headers.get('retry-after'), 'clients need retry-after')

server.close()

// Provider selection is read at import time, so it needs a fresh process.
const { execFileSync } = await import('node:child_process')
const child = execFileSync(
  process.execPath,
  ['--input-type=module', '-e', `
    const { start } = await import(${JSON.stringify(new URL('./server.mjs', import.meta.url).href)})
    const s = start(0)
    const base = 'http://localhost:' + s.address().port
    const key = await (await fetch(base + '/api/_key')).json()
    const polled = await fetch(base + '/api/status/abc')
    console.log(JSON.stringify({ key, polledStatus: polled.status }))
    s.close()
  `],
  { env: { ...process.env, ACCESS_PASSWORD: '', OPENAI_API_KEY: 'sk-not-a-real-key' }, encoding: 'utf8' },
)
const openai = JSON.parse(child)
assert.deepEqual(openai.key, { ok: true, provider: 'openai' }, 'an OpenAI key must win over no FASHN key')
assert.equal(openai.polledStatus, 404, 'the synchronous provider has nothing to poll')

console.log('ok — 15 checks passed')
