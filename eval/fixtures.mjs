// Makes the eval fixtures: photos to wear pieces on, and pieces to wear.
// Run with: node eval/fixtures.mjs [name ...]     (no args = all of them)
//
// These are generated rather than shot so the set can be regenerated and shared
// without anyone's face in the repo. Real product shots are still better for
// judging fidelity — a generated packshot is cleaner than anything a brand sends.
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
const KEY = env.match(/^OPENAI_API_KEY=(.+)$/m)?.[1]?.trim()
if (!KEY) throw new Error('no OPENAI_API_KEY in .env')

const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2'
const QUALITY = process.env.FIXTURE_QUALITY || 'medium'

const FIXTURES = {
  // Photos. Directional light is deliberate: a flat-lit photo cannot show
  // whether the relight pass is doing anything.
  'photo-neck': {
    size: '1024x1536',
    prompt: 'Photorealistic candid portrait photograph of a woman, head and shoulders, bare neck and collarbone clearly visible, plain dark scoop-neck top, absolutely no jewellery of any kind, shoulder-length dark hair with a few strands falling in front of her left ear, strong natural window light from the left, warm indoor tone, shot on a phone camera, slight sensor grain, plain grey wall behind her',
  },
  'photo-hand': {
    size: '1536x1024',
    prompt: "Photorealistic photograph of a woman's hand, palm down, fingers slightly apart and straight, resting on a plain light grey surface, absolutely no rings or jewellery of any kind, soft natural window light from the upper left, shot on a phone camera, slight sensor grain",
  },
  // Pieces. Plain seamless backdrop, because the cutout learns the backdrop from
  // the border and a busy prop shot has no palette to learn.
  'piece-necklace': {
    size: '1024x1024',
    prompt: 'E-commerce packshot of a delicate gold chain pendant necklace laid flat on a pure white seamless background, chain forming a wide open U curve, small teardrop diamond pendant hanging at the centre bottom, sharp focus throughout, flat even studio lighting, no shadows, no props, no hands, nothing in frame but the necklace',
  },
  'piece-ring': {
    size: '1024x1024',
    prompt: 'E-commerce packshot of a single gold solitaire diamond ring on a pure white seamless background, photographed straight on from the front so the band forms a complete circle with a fully open empty centre, sharp focus, flat even studio lighting, no shadows, no props, nothing in frame but the ring',
  },
}

const out = new URL('./cases/', import.meta.url)
await mkdir(out, { recursive: true })

const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(FIXTURES)

for (const name of names) {
  const spec = FIXTURES[name]
  if (!spec) { console.error(`unknown fixture: ${name}`); continue }
  process.stdout.write(`${name} … `)
  const t = Date.now()
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: spec.prompt, size: spec.size, quality: QUALITY, n: 1 }),
    signal: AbortSignal.timeout(300000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) { console.log(`failed — ${data.error?.message || res.status}`); continue }
  const b64 = data.data?.[0]?.b64_json
  if (!b64) { console.log('no image returned'); continue }
  await writeFile(new URL(`./${name}.png`, out), Buffer.from(b64, 'base64'))
  console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`)
}
