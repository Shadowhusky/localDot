# V0-1 findings: layer split with See-through

Date: 2026-09-30. Input: one ORIGINAL anime bust (no existing character) made with Codex image
generation, 1024×1536, flat dark background (`out/input.png`, git-ignored).

## Route
- **Works: the hosted Hugging Face Space `24yearsold/see-through-demo`** through `gradio_client`
  (`run.py`). Endpoint `/inference(image, resolution, seed, tblr_split) -> (layered_psd, layers)`.
  No account or token needed. One run at 1280: **179 s** including queue, $0.
- Resolution slider on the Space: **768–1280** (step 64). The output canvas is always square
  (1280×1280); a 2:3 input is scaled to 1280 tall and padded, so the character's effective
  resolution is **853×1280**.
- Higher resolution, if the rig needs it: the ModelScope studio (`ljsabc/See-Through`) advertises
  higher resolution (not tried; China-hosted), or a rented 24 GB GPU (RTX 4090 class, about
  $0.35–0.70/h; one image takes about 3 min, so cents per image; nothing was rented). Upscaling each
  layer with an anime upscaler is the cheaper alternative.
- Local Apple Silicon: not attempted. The README ships CUDA-only installs (torch cu128,
  bitsandbytes/NF4 for 8 GB cards) and never mentions MPS, so per the plan this was skipped.

## Output
- `layered.psd` (9.8 MB) with **13 non-empty layers in real draw order**, bottom to top: back hair,
  neck, topwear, ears, face, nose, mouth, eyewhite, irides, front hair, eyelash, headwear,
  eyebrow. Eyelashes and eyebrows sit above the front hair, as anime rigs expect.
- The gallery returns all 24 tags (empty ones included: wings, tail, legwear…) plus an intermediate
  `head` composite that is not in the PSD.

## Quality (judged from `out/res1280/contact-sheet.png` and `face-zoom.png`)
- Separation is clean: front/back hair, ears, brows, lashes, eye whites, irises, nose, mouth, face,
  neck, clothing and the hair clip each come out alone. No visible halos at 1:1.
- Hidden areas are filled: the forehead under the bangs, the scalp, the back hair behind the head,
  the neck under the chin, and **fully round irises** (the parts under the lids are painted) — the
  last is what eye movement needs.
- Flaws: the bangs' shadow stays baked into the `face` layer (it will not move when the hair moves);
  one mouth (closed) and one eye state (open) only.

## What the pipeline still has to add (as the spec planned)
- Mouth shapes A/I/U/E/O/N and eye states (half, closed, smiling-closed) by masked, reference-
  attached image edits.
- A clean-up edit removing the baked bang shadow from `face`.

## Result: GO
The hosted demo is enough for the first theme's reference at 1280 (free, ~3 min). Revisit resolution
after the rig review: if 853 px wide is too soft for Glance, run once on a rented GPU or upscale the
layers.
