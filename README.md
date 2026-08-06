# Dizrupt Try-On

Virtual try-on: add a garment, add a photo, get the person wearing it.
Zero dependencies — Node's stdlib http server, one HTML file.

## Setup

```bash
cp .env.example .env      # fill in ONE provider key
npm start                 # http://localhost:3000
npm test                  # access control, rate limiting, routing, provider choice
```

Keys never reach the browser. The page calls `/api/*` on this server, which
attaches the bearer token and talks to the provider.

## Providers

Set one key. `OPENAI_API_KEY` wins if both are present.

| | OpenAI (`gpt-image-2`) | FASHN (`tryon-v1.6`) |
|---|---|---|
| Approach | General image editor, re-renders the whole photo from a prompt | Purpose-built try-on model |
| Garment fidelity | Approximate — prints, logos and fine patterns drift | High; the model is trained for exactly this |
| Identity | Face and body can shift between runs | Preserved by design |
| Call shape | Synchronous `POST /v1/images/edits`, base64 back | Submit + poll, CDN URL back |

The UI is identical either way. If try-on quality matters more than reusing an
existing key, FASHN is the better tool for the job.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Use OpenAI as the provider. Server-side only. |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | Override if your account has different image models enabled. |
| `FASHN_API_KEY` | — | Use FASHN as the provider. Server-side only. |
| `ACCESS_PASSWORD` | unset (open) | Required before deploying. Basic auth on every route — the browser prompts; leave the username blank. |
| `PORT` | `3000` | |
| `RATE_LIMIT` | `20` | Generations per IP per window. Only `/api/run` is counted; it is the only route that spends credits. |
| `RATE_WINDOW_MIN` | `10` | Window length in minutes. |
| `TRUST_PROXY` | `0` | Set to `1` behind a proxy/load balancer so the limiter reads `X-Forwarded-For`. Leave `0` otherwise — the header is client-controlled and spoofable. |

## Hosting

The app is a plain Node process that reads `PORT`, so anything that runs
`npm start` works: Render, Railway, Fly.io, a VPS behind Caddy or nginx.

1. Set your provider key and `ACCESS_PASSWORD` as secrets in the platform's
   dashboard. Never bake them into the repo or an image layer.
2. Set `TRUST_PROXY=1` — every managed platform terminates TLS in front of you,
   so without it every visitor looks like one IP and shares one rate limit.
3. Build command: none. Start command: `npm start`. Node 22+.

Without `ACCESS_PASSWORD`, anyone who finds the URL spends your credits. The
rate limit caps the damage, it does not prevent it.

## Using it

Two steps: add the garment, add your photo, press **Generate**. The result lands
in the mirror — drag the seam to wipe between the original photo and the try-on.
Pressing Generate again re-runs with a fresh seed for a different attempt.

No settings are exposed. On FASHN every run uses `tryon-v1.6` with auto
category, auto garment-shot detection, balanced mode, one PNG out; on OpenAI it
is a single fixed prompt. If you ever need the knobs back, they are a few lines
in `public/index.html` (the `inputs` object) and `server.mjs` (`TRY_ON_PROMPT`).

Inputs larger than 1536px are downscaled in the browser before upload. Small PNGs
pass through untouched so transparent flat-lays keep their alpha.

## Server routes

| Route | Behaviour |
|---|---|
| `GET /*` | serves `public/index.html` |
| `GET /api/_key` | `{ ok, provider }` — is a key configured, and whose |
| `POST /api/run` | Starts a try-on. Returns the finished image (OpenAI) or an id to poll (FASHN). |
| `* /api/<path>` | FASHN only: proxied to `https://api.fashn.ai/v1/<path>` with the key attached |

The FASHN proxy is generic, so any of its endpoints work without server changes
— `/api/credits`, `/api/status/:id`, and so on.

## Limits worth knowing

- FASHN: 50 requests / 60s on `/run`, 6 concurrent, result URLs expire after 3
  days, failed predictions are not charged.
- OpenAI: edits are billed per generated image whether or not you like the
  result. Check current rates on OpenAI's pricing page.
- Request bodies are capped at 25 MB by the proxy.
