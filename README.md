# FASHN Try-On Console

A local UI + thin server wrapper for the [FASHN](https://fashn.ai) virtual try-on API.
Zero dependencies — Node's stdlib http server, one HTML file.

## Setup

```bash
cp .env.example .env      # paste your key from https://app.fashn.ai/api
npm start                 # http://localhost:3000
```

The key never reaches the browser: the page calls `/api/*` on the local server,
which attaches `Authorization: Bearer $FASHN_API_KEY` and forwards to
`https://api.fashn.ai/v1/*`.

```bash
npm test                  # access control, rate limiting, routing
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FASHN_API_KEY` | — | Required. Server-side only. |
| `ACCESS_PASSWORD` | unset (open) | Required before deploying. Basic auth on every route — the browser prompts; leave the username blank. |
| `PORT` | `3000` | |
| `RATE_LIMIT` | `20` | Generations per IP per window. Only `/api/run` is counted; it is the only route that spends credits. |
| `RATE_WINDOW_MIN` | `10` | Window length in minutes. |
| `TRUST_PROXY` | `0` | Set to `1` behind a proxy/load balancer so the limiter reads `X-Forwarded-For`. Leave `0` otherwise — the header is client-controlled and spoofable. |

## Hosting

The app is a plain Node process that reads `PORT`, so anything that runs
`npm start` works: Render, Railway, Fly.io, a VPS behind Caddy or nginx.

1. Set `FASHN_API_KEY` and `ACCESS_PASSWORD` as secrets in the platform's
   dashboard. Never bake them into the repo or an image layer.
2. Set `TRUST_PROXY=1` — every managed platform terminates TLS in front of you,
   so without it every visitor looks like one IP and shares one rate limit.
3. Build command: none. Start command: `npm start`. Node 22+.

Without `ACCESS_PASSWORD`, anyone who finds the URL spends your credits. The
rate limit caps the damage, it does not prevent it.

## Using it

Drop (or click, or paste) a person photo and a garment photo, pick a model, hit
**Generate try-on**. The result lands in the mirror — drag the seam to wipe
between the original photo and the try-on.

Inputs larger than 1536px are downscaled in the browser before upload. Small PNGs
pass through untouched so transparent flat-lays keep their alpha.

## Models

| | `tryon-v1.6` | `tryon-max` |
|---|---|---|
| Garment field | `garment_image` | `product_image` |
| Controls | category, mode, garment shot type, moderation, segmentation-free | prompt, resolution (1K/2K/4K), generation mode |
| Output | up to 4 (`num_samples`) | up to 4 (`num_images`) |

Both post to `POST /v1/run` with `{ model_name, inputs }` and are polled at
`GET /v1/status/{id}` until `completed` or `failed`.

## Server routes

| Route | Behaviour |
|---|---|
| `GET /*` | serves `public/index.html` |
| `GET /api/_key` | `{ ok: true\|false }` — is a key configured |
| `* /api/<path>` | proxied to `https://api.fashn.ai/v1/<path>` with the key attached |

Because the proxy is generic, any current or future FASHN endpoint works without
server changes — `/api/credits`, `/api/status/:id`, and so on.

## Limits worth knowing

- 50 requests / 60s on `/run`, 50 / 10s on `/status`, 6 concurrent (FASHN side).
- Result URLs expire after 3 days.
- Failed predictions are not charged.
- Request bodies are capped at 25 MB by the proxy.
