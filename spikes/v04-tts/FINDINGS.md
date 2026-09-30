# V0-4 findings: local TTS, designed voice and lip-sync timing

Date: 2026-09-30, on this Mac (M3 Ultra), mlx-audio 0.5.7 / mlx 0.32.3, run while the core session
was idle on the GPU. Scripts: `design_voice.py` → `stream_bench.py` → `visemes.py` (outputs in
`out/`, git-ignored).

## 1. Designed voice (Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit)
Three ORIGINAL voices from text descriptions only (no audio of any person), each speaking the same
27-syllable Chinese line (`common.py`):

| Variant | Description (short) | Median pitch | Pitch range (10–90%) | Rate | Made in |
|---|---|---|---|---|---|
| a | early twenties, clear, calm, dry, warm | 242 Hz | 124 Hz | 4.6 syl/s | 3.6 s |
| b | ~18, bright, slightly high, teasing, "anime heroine" | 358 Hz | 188 Hz | 3.9 syl/s | 1.7 s |
| c | ~18, mid-pitched, cool, composed, dry wit | 361 Hz | 151 Hz | 4.6 syl/s | 1.4 s |

Pitch and rate are measured (autocorrelation F0); I cannot listen, so "anime-ness" is the user's
call — the three clips were sent for listening. By the numbers: b is the most expressive and
typical of anime heroines, c is as high but steadier, a is a calmer, lower adult voice.

## 2. Streaming in the designed voice (Qwen3-TTS-12Hz-1.7B-Base-8bit cloning `ref.wav` = a)
Two sentences per language, streamed with a 0.32 s interval, sentence by sentence:

| Sentence | Audio | First audio | Speed |
|---|---|---|---|
| zh-1 / zh-2 | 4.3 s / 4.7 s | 121 / 128 ms | 3.8× real time |
| en-1 / en-2 | 5.8 s / 4.2 s | 128 / 126 ms | 3.8× |
| ja-1 / ja-2 | 5.3 s / 4.1 s | 125 / 127 ms | 3.7–3.8× |

- **First audio ≤ 128 ms after a sentence arrives** (budget: 700 ms). Model load 2.4 s.
- **Peak memory: 3.8 GB (MLX), 3.3 GB RSS** — less than half the research estimate (8 GB).
- One identity across Chinese, English and Japanese from a Chinese reference clip.

## 3. Lip-sync timing (Qwen3-ForcedAligner-0.6B-8bit → A/I/U/E/O/N/rest)
Mapping: zh by pypinyin finals (with uei/iou restored from the abbreviated ui/iu), ja by
pyopenjtalk phonemes (one shape per mora, ん → N), en by CMUdict vowels (+ N for a word-initial
m/b/p). Gaps ≥ 120 ms become rests. Tracks are in `SpeechTrack.visemes` shape (`out/*.visemes.json`).

| Sentence | Align time | Units (zero-length) | Open shapes starting on voiced audio | Rest time on silence |
|---|---|---|---|---|
| zh-1 | 72 ms | 23 (2) | 100% | 100% |
| zh-2 | 73 ms | 19 (1) | 94% | 100% |
| en-1 | 79 ms | 13 (0) | 100% | 100% |
| en-2 | 71 ms | 12 (0) | 100% | 100% |
| ja-1 | 80 ms | 22 (1) | 96% | 100% |
| ja-2 | 69 ms | 11 (0) | 91% | 93% |

Where timing looked wrong: 4 onsets in 6 sentences land on a quiet consonant rather than the vowel
(zh-2 @640 ms, ja-1 @3360 ms, ja-2 @2640 and @3600 ms — each within one 80 ms aligner step of the
voiced part), and one short Japanese comma pause (ja-2, 2320–2640 ms) holds 50 ms of voice inside a
rest. The aligner also returns zero-length units (e.g. き at 0.80–0.80 s); those are given a 60 ms
mora or dropped when another shape starts at the same instant.

## Dependencies
Japanese alignment needs `nagisa` (added to `pyproject.toml`); `pyopenjtalk-plus` works without
onnxruntime (warning only).

## Result: GO
Local TTS is fast (first audio ~125 ms, 3.8× real time), light (3.8 GB) and multilingual in one
designed identity; aligner-driven mouth shapes line up with the audio. Open: which designed voice
the user prefers (a/b/c, or a redesign).
