# V0-5 findings: local speech input with end-of-speech detection

Date: 2026-09-30, this Mac, mlx-audio 0.5.7. ASR `mlx-community/Qwen3-ASR-0.6B-8bit`, VAD
`mlx-community/silero-vad` driven by mlx-audio's `StreamingVad` (OpenAI `server_vad` semantics:
threshold 0.5, 300 ms prefix padding). Clips: the six V0-4 sentences (known text; synthetic voice),
resampled to 16 kHz, with 1.5 s of silence appended, fed in 30 ms frames like a microphone. No
microphone was used. Script: `bench.py`; raw numbers in `out/bench.json` (git-ignored).

## Push-to-talk (the spec's default input mode)
Release = end of speech, so the only wait is one decode of the whole utterance.

| Clip | Decode after release | Error rate | Detected language |
|---|---|---|---|
| zh-1 / zh-2 | 111 / 111 ms | 0% / 0% (CER) | Chinese ✓ |
| en-1 / en-2 | 122 / 112 ms | 0% / 0% (WER) | English ✓ |
| ja-1 / ja-2 | 135 / 118 ms | 7.9% / 22.7% (CER) | Japanese ✓ |

**End of speech → text: 111–135 ms (budget 400 ms).** Japanese errors are the same words in every
run (やっと → 夜, 正直 → ジョルギ); the clips are synthetic, so whether the voice or the recogniser
is at fault needs a test with real speech in Part 2.

## Hands-free (VAD endpointing)
| Silence before "stopped" | Turns per two-clause clip | Speech end → text |
|---|---|---|
| 300 ms | 1–3 (splits at sentence pauses) | 451–502 ms |
| 500 ms | 1–2 | 632–700 ms |
| 800 ms | 1–2 | 931–987 ms |

- Natural pauses between sentences (0.3–1 s in these clips) end a turn early at 300–500 ms, so a
  hands-free mode must merge turns that restart within about 1 s, or use a longer silence.
- The spec's 400 ms budget is met only by push-to-talk; the best hands-free setting (500 ms silence
  + merge) lands near 700 ms.
- VAD cost: ~50× real time on CPU/GPU (a 30 ms frame takes ~0.6 ms). **0 false triggers** on 10 s of
  pink noise at −50 dBFS.
- Partial text: re-decoding the growing buffer every 0.5 s costs at most 137 ms per pass, so live
  partials keep up comfortably (≤ 27% of the interval).

## Result: GO-WITH-CHANGES
Local ASR is fast and accurate for Chinese and English with correct language detection. Changes for
the spec: the 400 ms budget applies to push-to-talk; hands-free gets a ~700 ms budget with 500 ms
silence and turn merging; Japanese accuracy is re-checked with real speech.
