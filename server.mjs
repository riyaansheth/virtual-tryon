import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'

const KEY = process.env.FASHN_API_KEY
const PASSWORD = process.env.ACCESS_PASSWORD // set this before exposing the app to the internet
const PORT = Number(process.env.PORT) || 3000
const TRUST_PROXY = process.env.TRUST_PROXY === '1'
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 20
const RATE_WINDOW = (Number(process.env.RATE_WINDOW_MIN) || 10) * 60_000
const UPSTREAM = 'https://api.fashn.ai/v1'
const MAX_BODY = 25 * 1024 * 1024 // two ~1.5k-px data URIs fit well under this

const send = (res, code, body, headers = {}) =>
  res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(body)

const err = (res, code, error, message, headers) =>
  send(res, code, JSON.stringify({ error, message }), headers)

/* ---------- access control ---------- */
// Hashing first keeps the comparison constant-time and length-blind.
const digest = (s) => createHash('sha256').update(String(s)).digest()
const matches = (a, b) => timingSafeEqual(digest(a), digest(b))

const authorized = (req) => {
  if (!PASSWORD) return true
  const [scheme, encoded] = (req.headers.authorization || '').split(' ')
  if (scheme !== 'Basic' || !encoded) return false
  const password = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':')
  return matches(password, PASSWORD)
}

/* ---------- rate limiting ---------- */
// ponytail: in-memory sliding window — resets on restart and counts per process.
// Move to Redis only if you run more than one instance.
const hits = new Map()

const clientIp = (req) =>
  (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
  req.socket.remoteAddress ||
  'unknown'

const withinLimit = (ip) => {
  const now = Date.now()
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW)
  hits.set(ip, recent)
  if (hits.size > 1000) for (const [k, v] of hits) if (!v.length) hits.delete(k)
  if (recent.length >= RATE_LIMIT) return false
  recent.push(now)
  return true
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

export const handler = async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost')

  if (!authorized(req)) {
    return err(res, 401, 'Unauthorized', 'This console is password protected.', {
      'www-authenticate': 'Basic realm="Dizrupt Try-On", charset="UTF-8"',
    })
  }

  // Everything that is not /api/* is the single-page console.
  if (!pathname.startsWith('/api/')) {
    const html = await readFile(new URL('./public/index.html', import.meta.url))
    return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' })
  }

  // Lets the UI say "no key" without guessing from an upstream error.
  if (pathname === '/api/_key') return send(res, 200, JSON.stringify({ ok: Boolean(KEY) }))

  // Only /run spends credits, so that is the one worth throttling — and it is
  // checked before anything else that could reach the network.
  if (pathname === '/api/run' && !withinLimit(clientIp(req))) {
    return err(
      res,
      429,
      'RateLimited',
      `Limit is ${RATE_LIMIT} generations per ${RATE_WINDOW / 60_000} minutes. Try again shortly.`,
      { 'retry-after': String(Math.ceil(RATE_WINDOW / 1000)) },
    )
  }

  if (!KEY) {
    return err(res, 503, 'NoApiKey', 'Add FASHN_API_KEY to .env and restart the server.')
  }

  // Generic passthrough: /api/run -> /v1/run, /api/status/:id -> /v1/status/:id.
  // Headers are rebuilt from scratch so nothing the client sends reaches FASHN.
  try {
    const upstream = await fetch(UPSTREAM + pathname.slice(4), {
      method: req.method,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: req.method === 'POST' ? await readBody(req) : undefined,
    })
    send(res, upstream.status, await upstream.text())
  } catch (e) {
    err(res, 502, 'ProxyError', e.message)
  }
}

export const start = (port = PORT) =>
  createServer((req, res) =>
    handler(req, res).catch((e) => err(res, 500, 'ServerError', e.message)),
  ).listen(port)

if (import.meta.filename === process.argv[1]) {
  start()
  console.log(
    `Dizrupt Try-On on http://localhost:${PORT}` +
      `\n  rate limit: ${RATE_LIMIT} generations / ${RATE_WINDOW / 60_000} min per IP` +
      `\n  access: ${PASSWORD ? 'password required' : 'open — set ACCESS_PASSWORD before deploying'}` +
      (KEY ? '' : '\n  ! FASHN_API_KEY is not set — copy .env.example to .env and add your key.'),
  )
}
