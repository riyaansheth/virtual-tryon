import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const KEY = process.env.FASHN_API_KEY
const PORT = Number(process.env.PORT) || 3000
const UPSTREAM = 'https://api.fashn.ai/v1'
const MAX_BODY = 25 * 1024 * 1024 // two ~1.5k-px data URIs fit well under this

const send = (res, code, body, type = 'application/json') =>
  res.writeHead(code, { 'content-type': type }).end(body)

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

  // Everything that is not /api/* is the single-page console.
  if (!pathname.startsWith('/api/')) {
    const html = await readFile(new URL('./public/index.html', import.meta.url))
    return send(res, 200, html, 'text/html; charset=utf-8')
  }

  // Lets the UI say "no key" without guessing from an upstream error.
  if (pathname === '/api/_key') return send(res, 200, JSON.stringify({ ok: Boolean(KEY) }))

  if (!KEY) {
    return send(res, 503, JSON.stringify({
      error: 'NoApiKey',
      message: 'Add FASHN_API_KEY to .env and restart the server.',
    }))
  }

  // Generic passthrough: /api/run -> /v1/run, /api/status/:id -> /v1/status/:id
  try {
    const upstream = await fetch(UPSTREAM + pathname.slice(4), {
      method: req.method,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: req.method === 'POST' ? await readBody(req) : undefined,
    })
    send(res, upstream.status, await upstream.text())
  } catch (err) {
    send(res, 502, JSON.stringify({ error: 'ProxyError', message: err.message }))
  }
}

export const start = (port = PORT) =>
  createServer((req, res) =>
    handler(req, res).catch((err) =>
      send(res, 500, JSON.stringify({ error: 'ServerError', message: err.message })),
    ),
  ).listen(port)

if (import.meta.filename === process.argv[1]) {
  start()
  console.log(
    `FASHN console on http://localhost:${PORT}` +
      (KEY ? '' : '\n  ! FASHN_API_KEY is not set — copy .env.example to .env and add your key.'),
  )
}
