// Smallest check that fails if access control, rate limiting or routing breaks.
// Run with: npm test   (deliberately runs WITHOUT .env loaded, so no key is set)
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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

/* ---------- clothing must not move ---------- */
// The jewellery branch keeps changing; clothing is not supposed to. Comparing the
// prompt as source text catches an edit to it that no behavioural test would.
const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8')
const CLOTHING_PROMPT = `  clothing: [
    'Dress the person in the first image in the garment shown in the second image.',
    "Keep the person's face, hair, body shape, pose, skin tone and the background exactly as they are.",
    'Replace only the clothing item that the garment corresponds to.',
    "Reproduce the garment's colour, pattern, print, texture, neckline and cut faithfully.",
    'Photorealistic result, with lighting and shadows consistent with the original photo.',
  ].join(' '),`
assert.ok(source.includes(CLOTHING_PROMPT), 'the clothing prompt must stay byte-identical')

/* ---------- the harmonize path is wired ---------- */
// Harmonizing sends one already-composited image, so the two-photo guard must not
// fire on it — but it does still need the OpenAI provider. Checking that under a
// FASHN key proves both without reaching the network.
const jewelChild = execFileSync(
  process.execPath,
  ['--input-type=module', '-e', `
    const { start } = await import(${JSON.stringify(new URL('./server.mjs', import.meta.url).href)})
    const s = start(0)
    const base = 'http://localhost:' + s.address().port
    const post = async (body) => {
      const r = await fetch(base + '/api/run', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      return { status: r.status, ...(await r.json()) }
    }
    const harmonize = await post({ mode: 'jewellery', harmonize: true, inputs: { model_image: 'data:image/png;base64,iVBORw0KGgo=' } })
    const clothing = await post({ mode: 'clothing', inputs: { model_image: 'data:image/png;base64,iVBORw0KGgo=' } })
    console.log(JSON.stringify({ harmonize, clothing }))
    s.close()
  `],
  { env: { ...process.env, ACCESS_PASSWORD: '', FASHN_API_KEY: 'fa-not-a-real-key', RATE_LIMIT: '10' }, encoding: 'utf8' },
)
const jewel = JSON.parse(jewelChild)
assert.notEqual(jewel.harmonize.error, 'MissingImage', 'harmonizing must not be asked for a second photo')
assert.equal(jewel.harmonize.error, 'Unsupported', 'harmonizing without the OpenAI provider must say so')
assert.equal(jewel.clothing.error, 'MissingImage', 'clothing still needs both photos')

console.log('ok — 20 checks passed')
