# Dizrupt Try-On

Virtual try-on: add a garment, add a photo, get the person wearing it.
Zero dependencies — Node's stdlib http server, one HTML file per product.

Two products, two different problems:

- **`/`** — clothing. A garment's identity is its colour, silhouette and print, and
  a model that redraws the whole photo keeps those, so it hands the model
  everything and shows what comes back.
- **`/jewel`** — jewellery. A chain's identity is a few pixels wide, and no model
  reliably reproduces it, so this one never asks a model to draw the piece. The
  real product pixels are measured into place and only their *lighting* is ever
  generated. See [Jewels](#jewels).

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
| `JEWEL_IMAGE_QUALITY` | `high` | Quality for the jewellery whole-photo path. |
| `JEWEL_HARMONIZE_QUALITY` | `medium` | Quality for Polished. Lower than above on purpose: this pass only supplies light, not detail. |
| `IDENTIFY_MODEL` | `gpt-4.1-mini` | Reads which kind of piece a product photo shows. |
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

No settings are exposed in the UI. The browser sends only the two photos; the
server picks the provider and its settings. Tune them with the environment
variables above — `FASHN_MODE=quality` and `OPENAI_IMAGE_QUALITY=high` are the
accuracy dials, `FASHN_MODEL=tryon-max` and `OPENAI_IMAGE_SIZE` the resolution
ones. The OpenAI prompt lives in `server.mjs` as `TRY_ON_PROMPT`.

Inputs larger than 1536px are downscaled in the browser before upload. Small PNGs
pass through untouched so transparent flat-lays keep their alpha.

## Jewels

At `/jewel`. Add the piece, add the photo, press **Try it on**. The kind of piece
is read from the product shot, and the four buttons override it if that is wrong.

It runs in three layers, and each one is a place you can stop:

| | What it does | Cost | Result |
|---|---|---|---|
| **Placed** | MediaPipe landmarks measure the body, the backdrop is flood-filled off the product, and the piece is scaled and angled from measured distances — shoulder span for a necklace, jaw width for earrings, the ring finger's knuckle-to-joint axis for a ring. Hair is segmented and redrawn over the top so a chain passes behind it. | ~0.7s, free | Exact, and flat |
| **Natural** | Five local passes: the piece takes on the luminance gradient and light colour of the skin around it, gains a contact shadow offset away from the light, and is matched to the photo's grain and focus. | +0.2s, free | Exact, and plausible. **The default.** |
| **Polished** | The composite goes to `gpt-image-2` with a mask, asking only for lighting. | ~1 min, billed | Exact, and photographic |

Nothing leaves the browser on the first two layers.

**Why Polished can be trusted.** OpenAI's own support says `gpt-image` ignores
`mask` and regenerates the whole image, so the mask is treated as a request and
the guarantee is enforced locally on the response instead. Outside the editable
region our own pixels are kept, byte for byte. Inside it, light is accepted as a
**luminance ratio**, never a per-channel delta — because light scales
reflectance, it does not add colour. A response that paints a magenta stripe
across the piece can therefore make it darker or lighter and nothing else;
measured, that stripe moves the product's hue by 1.5°. Past a threshold on how
far the brightness or colour moved, the local render is kept instead and the
status line says so.

Sliders adjust size and turn, dragging the photo nudges the piece, and the
finishing passes toggle individually — all of which re-run locally, so no slider
ever spends a credit. `?debug` exposes the pipeline on `window.jewels` for
building an eval set.

## Server routes

| Route | Behaviour |
|---|---|
| `GET /*` | serves `public/index.html` |
| `GET /jewel*` | serves `public/jewel.html` |
| `GET /api/_key` | `{ ok, provider }` — is a key configured, and whose |
| `POST /api/identify` | `{ kind }` — which of the four kinds a product photo shows. OpenAI only. |
| `POST /api/run` | Starts a try-on. Returns the finished image (OpenAI) or an id to poll (FASHN). `mode: 'jewellery'` picks the jewellery prompt; adding `harmonize: true` sends one already-composited image plus a `mask` and asks only for lighting. |
| `* /api/<path>` | FASHN only: proxied to `https://api.fashn.ai/v1/<path>` with the key attached |

The FASHN proxy is generic, so any of its endpoints work without server changes
— `/api/credits`, `/api/status/:id`, and so on.

## Limits worth knowing

- FASHN: 50 requests / 60s on `/run`, 6 concurrent, result URLs expire after 3
  days, failed predictions are not charged.
- OpenAI: edits are billed per generated image whether or not you like the
  result. Check current rates on OpenAI's pricing page.
- Request bodies are capped at 25 MB by the proxy.
- Jewels' first two layers cost nothing and never call out. Only **Polished**
  spends credits, and only when you press the button — not on a slider drag.
- Jewels downloads the MediaPipe models from a CDN the first time you press Try
  it on, and caches them after. Rings and bracelets skip hair segmentation.
