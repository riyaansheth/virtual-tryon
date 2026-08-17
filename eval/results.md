# Eval

Fixtures are generated, not shot, so the set can live in the repo without anyone's
face in it: `node eval/fixtures.mjs` rebuilds them from `.env`'s OpenAI key. Real
brand packshots are still the better test — a generated one is cleaner than
anything a brand actually sends.

Run a case by opening `/jewel?debug`, which puts the pipeline on `window.jewels`.
`jewels.setPiece`/`setPhoto` take data URLs, `jewels.fake(cx, cy, width)` places
without landmarks for photos with no face in them, and `jewels.state.stats` holds
what the passes measured.

## Case: photo-neck × piece-necklace

A hairline gold chain with a pear pendant, on a portrait lit hard from the left,
head turned about 25°, hair covering her right ear. Deliberately the hard case:
the chain is 1–2px wide once placed, which is where thin work goes to die.

| | Measured |
|---|---|
| Cutout | 1.84% of the packshot kept — i.e. 98% backdrop, the case `815c746` had to relax the guard for. 3696 edge pixels carry partial alpha from the matte. |
| Landmarks | necklace read from the packshot automatically; anchor at cy 0.695 with the chin at 0.583, tilted 3.6° to match her shoulders |
| Light | direction (−0.69, −0.72) — upper left, which is where the window is. Illuminant r1.37 g0.93 b0.65 off skin. |
| Placed → Natural | +0.2s, free |
| Polished | 57–73s, `light 6% · colour 1 · discarded 5 outside the mask` |

**Verdict.** Placed → Natural is a real gain: the gold reads as gold rather than
as a cool grey line. Natural → Polished is very subtle *on this piece*, because a
1–2px chain has almost no surface for relighting or a contact shadow to act on.
Expect that gap to widen on a chunky piece, where there is metal to light. Natural
is the right default.

## What this case caught

Four bugs, all found by measuring rather than by looking:

1. **Enforcement took a per-channel delta.** A hostile response painting a magenta
   stripe across the piece drove gold `242,170,48` → `255,94,104`, and pushed
   skin's green channel to `0`, because "accept the darkening" was applied per
   channel and a saturated colour is a darkening in one of them. Drift measured
   17.7 against a threshold of 60, so the gate waved it through. Now light is
   accepted only as a **luminance ratio** — that same stripe moves the product's
   hue by 1.45° and the skin's by 0.27°.
2. **The focus blur erased the product.** Blur radius came from a sharpness ratio,
   which is highest exactly when the piece is a hairline chain. Thickness now
   decides: under 5px of stroke width, no blur at all.
3. **Exposure matched a t-shirt.** The light was read from everything around the
   piece, and a necklace sits above a dark top, so `meanL` came out at 57 and the
   chain was darkened ~24% to match. Reading it off the segmenter's skin classes
   instead gives 90.
4. **A flat-lay's aspect ratio is not how it hangs.** Matched on width to the
   shoulder span, a near-square packshot reached 1652px down a 1536px photo — off
   the chest entirely. Height is now capped by chin-to-shoulder distance, whichever
   limit binds first.

And one the model used to hide: the cutout left anti-aliased edge pixels opaque,
which was invisible while a model repainted every pixel and a white fringe the
moment real product pixels land on skin.

## Still open

- **The chain is a warped flat-lay, not a curve around a neck.** It reads
  acceptably here because hair covers one side, but both chain ends stop in
  mid-air rather than continuing behind the neck. This is the curve-fitting work
  the plan defers, and it is the biggest remaining gap on necklaces.
- **Earrings, rings and bracelets are untested.** The geometry is restored and the
  maths is the same, but no case has been run. `photo-hand` and `piece-ring` are
  in `fixtures.mjs` and not yet generated.
- **Polished has been run twice, on one piece.** Its value is unproven on anything
  chunky, which is where it should matter most.
- `gpt-image-2` does not honour `mask`: it changed pixels outside it by ~2% per
  channel on both runs. Modest, but it confirms the enforcement is load-bearing —
  without it the face and background drift on every render.
