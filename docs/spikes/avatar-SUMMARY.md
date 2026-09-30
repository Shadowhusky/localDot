# Avatar spikes: summary (2026-09-30)

Four throwaway spikes answered the avatar sub-project's risky questions before the rig and voice
work starts. Details and raw numbers live in each spike's `FINDINGS.md`.

| Spike | Question | Result |
|---|---|---|
| `spikes/v01-seethrough` | Can one anime bust become rig-ready layers here? | GO |
| `spikes/v02-spine-toy` | Do scripted Spine 4.3 rigs with additive head-turn sliders work end to end? | GO |
| `spikes/v04-tts` | Is local TTS fast, light and multilingual in one designed voice, with usable lip-sync timing? | GO |
| `spikes/v05-asr` | Is local speech input fast and accurate, and how should end of speech be detected? | GO-WITH-CHANGES |

## Decisions
- **Layer split:** the free hosted See-through demo (`24yearsold/see-through-demo`, `gradio_client`),
  1280 px, about 3 minutes per image. It returns a PSD with real draw order and fills hidden areas
  (forehead, scalp, back hair, round irises). A 2:3 portrait comes back 853 px wide. Mouth shapes,
  eye states and a clean-up of the baked bang shadow are still made by reference-attached image
  edits.
- **Rig format:** `rig-gen` emits Spine 4.3 JSON directly — one top-level `constraints` array holding
  sliders (`"type": "slider", "additive": true, "animation"`) and physics constraints; head turns
  are deform animations keyed −1 / 0 / +1 at times 0 / 0.5 / 1. Import:
  `Spine -i rig.json -o rig.spine -r`; export: `Spine -i rig.spine -o <absolute path> -e binary+pack`
  (a relative `-o` resolves against the project folder). Stamp `skeleton.spine` with the editor
  version (4.3.26).
- **Runtime:** spine-pixi-v8 4.3.13 on PixiJS 8.21: additive sliders blend cleanly at every corner,
  145 fps mean / 115 minimum. A slider is driven with `findConstraint(name, Slider).pose.time`;
  physics reacts to `skeleton.x/y`, not the Pixi container, and writes the world transform.
- **Voice output:** Qwen3-TTS 1.7B Base 8-bit cloning a text-designed reference: first audio
  121–128 ms after a sentence arrives, 3.8× real time, 3.8 GB peak, one identity across Chinese,
  English and Japanese. Three designed voices exist; the user picks one.
- **Lip-sync:** Qwen3-ForcedAligner 0.6B 8-bit aligns a sentence in 69–80 ms. Mapping by pypinyin
  finals (uei/iou restored), pyopenjtalk morae and CMUdict vowels: 91–100% of open shapes start on
  voiced audio and 93–100% of rest time is silent. Japanese alignment needs `nagisa`.
- **Voice input:** Qwen3-ASR 0.6B 8-bit decodes a whole utterance in 111–135 ms with correct language
  detection; Chinese and English were error-free, Japanese 8–23% on synthetic clips. Silero VAD via
  mlx-audio's `StreamingVad` costs ~50× real time and raised no false triggers on quiet room noise;
  partial text by re-decoding every 0.5 s costs ≤ 137 ms per pass.

## Spec amendments
Spec: `docs/superpowers/specs/2026-09-30-localdot-avatar-voice-design.md`.

1. Success criterion 4 — current: "with voice input on, end of speech to recognised text within
   400 ms locally". Replacement: "with voice input on, push-to-talk release to recognised text
   within 400 ms locally; hands-free end of speech to text within 750 ms".
2. Voice input, Endpointing — current: "Silero VAD in `voiced` decides end of speech; the utterance
   is decoded then." Replacement: "Silero VAD in `voiced` decides end of speech after 500 ms of
   silence; a turn that restarts within 1 s joins the same utterance, which is decoded when it
   ends."
3. Testing, latency budgets — current: "end of speech to final text (≤ 400 ms)". Replacement:
   "push-to-talk release to final text (≤ 400 ms), hands-free end of speech to final text
   (≤ 750 ms)".
4. Voice output, Engine — current: "3.4× real time, first audio 171 ms after a sentence starts,
   about 8 GB peak". Replacement: "3.8× real time, first audio about 125 ms after a sentence
   arrives, 3.8 GB peak (V0-4)".
5. Art pipeline, Layers — current: "It needs a CUDA GPU, so it runs on its hosted demo or a short
   rented GPU (spike V0-1 decides)." Replacement: "It runs on its free hosted demo at up to 1280 px
   (V0-1); a rented GPU or layer upscaling is used only if the rig review finds the 853 px width too
   soft."
6. Art pipeline, Rig — current: "the exact invocations are fixed in spike V0-2". Replacement: the
   import and export commands above, with an absolute `-o`.

## Risks that remain
- Which designed voice fits the character (user listening pending), and whether a redesign is
  needed.
- Japanese recognition accuracy on real speech (V0-5 used synthetic clips).
- Whether 853 px wide layers are sharp enough for the large Glance view.
- The real rig: a toy mesh proved the mechanics, not the look of 2.5D head turns on painted layers.
- Golden-pose captures need a page-ready flag; headless `--screenshot` fires before assets load.
