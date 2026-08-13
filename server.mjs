import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash, timingSafeEqual } from 'node:crypto'

const FASHN_KEY = process.env.FASHN_API_KEY
const OPENAI_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2'
// The cost/quality dial. 'low' is a few cents; 'high' is several times that.
const OPENAI_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'high'
// Portrait, because a try-on is always a standing person. Edges must be /16.
const OPENAI_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1536'
// tryon-v1.6 is the accurate default at 1 credit; tryon-max trades credits for
// resolution up to 4k. Quality mode costs no extra credits, only seconds.
const FASHN_MODEL = process.env.FASHN_MODEL || 'tryon-v1.6'
const FASHN_MODE = process.env.FASHN_MODE || 'quality'
const FASHN_RESOLUTION = process.env.FASHN_RESOLUTION || '2k'
// An OpenAI key wins when both are present, so switching back is one line in .env.
const PROVIDER = OPENAI_KEY ? 'openai' : 'fashn'
const KEY = OPENAI_KEY || FASHN_KEY
const PASSWORD = process.env.ACCESS_PASSWORD // set this before exposing the app to the internet
const PORT = Number(process.env.PORT) || 3000
// Behind a reverse proxy, set HOST=127.0.0.1 so the app is not reachable on :PORT directly.
const HOST = process.env.HOST
const TRUST_PROXY = process.env.TRUST_PROXY === '1'
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 20
const RATE_WINDOW = (Number(process.env.RATE_WINDOW_MIN) || 10) * 60_000
const UPSTREAM = 'https://api.fashn.ai/v1'
const MAX_BODY = 25 * 1024 * 1024 // two ~1.5k-px data URIs fit well under this
const TIMEOUT = Number(process.env.REQUEST_TIMEOUT_S || 180) * 1000

const send = (res, code, body, headers = {}) => {
  if (res.headersSent) return // an earlier guard already answered
  res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(body)
}

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

const readBody = (req, res) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        // Answer before hanging up. Destroying the socket first leaves the
        // browser with a bare network error ("Failed to fetch") and no clue why.
        err(res, 413, 'PayloadTooLarge',
          `Those images are too big. Keep the pair under ${Math.floor(MAX_BODY / 1024 / 1024)}MB.`)
        res.once('finish', () => req.destroy())
        reject(new Error('Payload too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

/* ---------- OpenAI provider ---------- */
// gpt-image-* has no try-on mode; it re-renders the photo from a prompt, so the
// wording below leans hard on preserving everything except the clothing.
const PROMPTS = {
  clothing: [
    'Dress the person in the first image in the garment shown in the second image.',
    "Keep the person's face, hair, body shape, pose, skin tone and the background exactly as they are.",
    'Replace only the clothing item that the garment corresponds to.',
    "Reproduce the garment's colour, pattern, print, texture, neckline and cut faithfully.",
    'Photorealistic result, with lighting and shadows consistent with the original photo.',
  ].join(' '),
  // Jewellery is added, not swapped, and the usual failure is scale — models
  // render a necklace the size of a dinner plate unless told otherwise.
  jewellery: [
    'Add the jewellery shown in the second image onto the person in the first image.',
    'The second image is a product shot on a plain backdrop — that backdrop is not',
    'clothing and must be ignored entirely. Do not change what the person is wearing.',
    "Keep the person's face, hair, skin tone, pose, clothing and the background exactly as they are.",
    'Add only the jewellery, worn where that kind of piece is naturally worn:',
    'necklaces and pendants at the collarbone, earrings on the earlobes, rings on fingers,',
    'bracelets and watches on the wrist, bangles on the forearm.',
    'Keep it at realistic scale relative to the body — jewellery is small.',
    "Reproduce the piece's metal colour, gemstones, shape and detailing faithfully.",
    'Photorealistic, with metal reflections and shadows consistent with the original lighting.',
  ].join(' '),
}

const toBlob = async (src) => {
  if (src.startsWith('data:')) {
    const [meta, base64] = src.split(',')
    return new Blob([Buffer.from(base64, 'base64')], { type: meta.slice(5).split(';')[0] || 'image/png' })
  }
  const r = await fetch(src)
  if (!r.ok) throw new Error(`Could not load that image (HTTP ${r.status})`)
  return r.blob()
}

/* ---------- FASHN provider ---------- */
// Purpose-built try-on: it composites the garment rather than redrawing the
// person, so identity and print detail survive. The two models take different
// field names for the same two images.
const fashnRun = async (inputs, mode, res) => {
  if (mode === 'jewellery') {
    return err(res, 400, 'UnsupportedMode',
      'FASHN\'s try-on model only handles garments. Jewellery mode needs the OpenAI provider.')
  }
  const isMax = FASHN_MODEL === 'tryon-max'
  const seed = Math.floor(Math.random() * 4294967295)
  const body = {
    model_name: FASHN_MODEL,
    inputs: isMax
      ? {
          model_image: inputs.model_image,
          product_image: inputs.garment_image,
          resolution: FASHN_RESOLUTION,
          generation_mode: FASHN_MODE,
          num_images: 1,
          output_format: 'png',
          seed,
        }
      : {
          model_image: inputs.model_image,
          garment_image: inputs.garment_image,
          category: 'auto',
          mode: FASHN_MODE,
          garment_photo_type: 'auto',
          segmentation_free: true,
          moderation_level: 'permissive',
          num_samples: 1,
          output_format: 'png',
          seed,
        },
  }

  const upstream = await fetch(`${UPSTREAM}/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  send(res, upstream.status, await upstream.text())
}

const openaiRun = async (inputs, mode, res) => {
  const form = new FormData()
  form.append('model', OPENAI_MODEL)
  form.append('prompt', PROMPTS[mode] || PROMPTS.clothing)
  form.append('quality', OPENAI_QUALITY)
  form.append('size', OPENAI_SIZE)
  form.append('image[]', await toBlob(inputs.model_image), 'person.png')
  form.append('image[]', await toBlob(inputs.garment_image), 'garment.png')

  // Without this a stalled upstream leaves the browser waiting forever behind a
  // progress bar that can only creep toward 100%.
  const upstream = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch((e) => {
    throw new Error(e.name === 'TimeoutError'
      ? `Gave up after ${TIMEOUT / 1000}s. Try a tighter box, or set OPENAI_IMAGE_QUALITY=medium.`
      : e.message)
  })
  const data = await upstream.json().catch(() => ({}))
  if (!upstream.ok) {
    return err(res, upstream.status, 'ImageError', data.error?.message || `HTTP ${upstream.status}`)
  }

  const image = data.data?.[0] || {}
  const output = image.b64_json ? `data:image/png;base64,${image.b64_json}` : image.url
  if (!output) return err(res, 502, 'NoImage', 'The image service returned nothing usable.')

  // Same envelope the polling client already understands, minus the polling.
  send(res, 200, JSON.stringify({ id: 'sync', status: 'completed', output: [output] }))
}

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
  if (pathname === '/api/_key') {
    return send(res, 200, JSON.stringify({ ok: Boolean(KEY), provider: PROVIDER }))
  }

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
    return err(res, 503, 'NoApiKey', 'Add OPENAI_API_KEY (or FASHN_API_KEY) to .env and restart the server.')
  }

  // The client sends only the two images; provider-specific payloads are built here.
  if (pathname === '/api/run') {
    const { inputs = {}, mode = 'clothing' } = JSON.parse(await readBody(req, res))
    if (!inputs.model_image || !inputs.garment_image) {
      return err(res, 400, 'MissingImage', 'Both photos are required.')
    }
    return PROVIDER === 'openai' ? openaiRun(inputs, mode, res) : fashnRun(inputs, mode, res)
  }

  if (PROVIDER === 'openai') {
    // Synchronous provider: nothing to poll, and no credit balance to report.
    return err(res, 404, 'Unsupported', `${pathname} is not available on this provider.`)
  }

  // Generic passthrough: /api/run -> /v1/run, /api/status/:id -> /v1/status/:id.
  // Headers are rebuilt from scratch so nothing the client sends reaches FASHN.
  try {
    const upstream = await fetch(UPSTREAM + pathname.slice(4), {
      method: req.method,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: req.method === 'POST' ? await readBody(req, res) : undefined,
    })
    send(res, upstream.status, await upstream.text())
  } catch (e) {
    err(res, 502, 'ProxyError', e.message)
  }
}

export const start = (port = PORT, host = HOST) =>
  createServer((req, res) =>
    handler(req, res).catch((e) => err(res, 500, 'ServerError', e.message)),
  ).listen(port, host)

if (import.meta.filename === process.argv[1]) {
  start()
  console.log(
    `Dizrupt Try-On on http://localhost:${PORT}` +
      `\n  rate limit: ${RATE_LIMIT} generations / ${RATE_WINDOW / 60_000} min per IP` +
      `\n  access: ${PASSWORD ? 'password required' : 'open — set ACCESS_PASSWORD before deploying'}` +
      `\n  provider: ${PROVIDER}${PROVIDER === 'openai' ? ` (${OPENAI_MODEL})` : ''}` +
      (KEY ? '' : '\n  ! No API key set — copy .env.example to .env and add one.'),
  )
}
