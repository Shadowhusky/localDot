# Speech models

Which on-device speech-to-text models localDot offers, and why. Researched and measured on 9 November
2026. [Voice input](voice.md) says how the install works.

## The choice

Change engine: **sherpa-onnx runs the models localDot installs**, and a Whisper someone set up by hand
stays on whisper.cpp, unchanged. No Whisper model was close on Chinese or mixed speech at a size or speed
a modest machine can bear.

| Tier | Model | Download | On disk | Memory at most | Short message (4 cores / 2 cores) | Two minutes (4 / 2) |
| --- | --- | --- | --- | --- | --- | --- |
| Light | SenseVoice Small int8, 2024-07-17 | about 180 MB | about 260 MB | 520 MB | 0.6 s / 1.9 s | 5.5 s / 8.7 s |
| **Balanced** (the default) | X-ASR zh-en int8, 2026-06-03 | about 155 MB | about 200 MB | 870 MB | 2.2 s / 5.2 s | 14 s / 24 s |
| Most languages | Qwen3-ASR 0.6B int8, 2026-03-25 | about 860 MB | about 975 MB | 2 GB | 5.3 s / not measured | 33 s / not measured |

The heaviest isn't called Best because it isn't: Balanced beats it on Chinese and mixed speech, the two
criteria that come first. It is there for people who dictate mainly in English or in another language.

## What was measured

Everything ran one transcription at a time, program start included, as the voice route does.

| Model | Real English | Real Chinese | Real mixed | English words in real mixed | Synthetic en / zh / mixed | Memory | Median per clip | Traditional characters |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **X-ASR zh-en int8** | 19.5% | **4.9%** | **11.3%** | **22%** | 1.5 / 0.0 / 27.7% | 590 MB | 2.2 s | 0% |
| X-ASR zh-en full precision | 18.0% | 4.9% | 11.4% | 23% | 1.5 / 0.0 / 28.7% | 1.5 GB | 3.7 s | 0% |
| **SenseVoice Small int8, 2024** | 19.1% | 7.2% | 12.6% | 31% | 4.5 / 1.2 / 31.2% | 460 MB | **0.6 s** | 0% |
| SenseVoice Small int8, 2025 | 35.3% | 5.8% | 13.0% | 30% | 26.5 / 2.4 / 37.6% | 330 MB | 0.6 s | 0% |
| **Qwen3-ASR 0.6B int8** | **15.8%** | 13.9% | 15.4% | 39% | 0.8 / 1.8 / 33.2% | 1.8 GB | 5.3 s | 0.4% |
| FireRedASR2 CTC int8 | 39.7% | 6.0% | 16.6% | 60% | 13.6 / 2.4 / 41.6% | 1.2 GB | 3.0 s | 0% |
| Paraformer zh int8 | spells letters | 7.7% | 56.9% | spells letters | spells letters / 1.2 / 81.2% | 450 MB | 1.1 s | 0% |
| Whisper tiny q5_1 | 35.3% | 27.1% | 47.0% | 87% | 5.3 / 13.9 / 57.4% | 150 MB | 0.5 s | 19% |
| Whisper base q5_1 | 28.3% | 24.1% | 40.2% | 79% | 3.8 / 10.2 / 44.1% | 210 MB | 1.0 s | 20% |
| Whisper small q5_1 | 22.1% | 17.6% | 24.9% | 54% | 3.0 / 4.8 / 32.7% | 480 MB | 3.2 s | 20% |
| Whisper large-v3-turbo q5_0 | 22.1% | 13.7% | 17.3% | 41% | 1.5 / 2.4 / 23.3% | 810 MB | **19 s** | 6% |

Lower is better. Errors are edit distance over Chinese characters and Latin words, ignoring case and
punctuation, with Traditional folded into Simplified so that isn't counted twice.

**Real speech** is the test split of [ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND) (CC-BY-SA-4.0):
spontaneous conversation recorded in Hong Kong, 110 clips of 2–12 seconds, 30 English, 30 Chinese and 50
mixed. Its speakers talk over each other and hesitate, which is harder than dictation, so the numbers
compare models rather than predict a person's experience. **Synthetic speech** is macOS `say` reading
dictation sentences: 8 English, 8 Chinese and 12 mixed, in two voices each. Those voices aren't real
speech; one reads English inside Chinese badly enough to fool every model, which is why the mixed column
is so much worse than ASCEND's. Treat those numbers as a smoke test.

**Where they ran.** Whisper is whisper.cpp 1.9.5 built from source, CPU only with four threads, natively
on this Mac (Apple M3 Ultra). The rest are sherpa-onnx 2.0.1's Linux arm64 build in a Docker Desktop
container capped at four CPUs on the same Mac, again CPU only. That container is the nearest this could
get to Linux with no GPU, and its file sharing makes model loading slower than native, so it's somewhat
pessimistic for those models. The Mac was also busy with other work. "2 cores" is a container capped at
two CPUs, with two threads, as a rough stand-in for a modest machine: M3 Ultra cores are much faster than
an older Intel's, so a real one will be slower.

**Long recordings** needed work. X-ASR **crashes** past about a minute of audio (an ONNX Runtime reshape
error), and SenseVoice quietly loses words on long audio. So installed models read pieces of at most 15
seconds, cut at pauses. One run holds all its pieces in memory, reaching 1.8 GB with X-ASR for a
two-minute recording, so there are at most three to a run, which holds it at 870 MB. Across synthetic
clips of 13 to 125 seconds, that gives 4.8% errors for X-ASR, 5.5% for SenseVoice and 5.2% for Qwen3-ASR.

**Starting the program is most of the wait.** X-ASR takes about 1.9 s to load and 0.09 s to read a
five-second clip; Qwen3-ASR about 4.3 s and 0.6 s. A program kept running while someone dictates would cut
the wait for words to a fraction of a second. It isn't built: it needs a local server, its lifetime and
its failure handling, and the one-run-per-request route is good enough for now. It is the obvious next
step for speed.

## Why not the others

- **Whisper.** On a CPU, turbo took 19 s for a few seconds of speech, because Whisper's encoder always
  reads a full 30 seconds however short the recording is. Small is the largest that keeps up, and is much
  worse on Chinese and mixed speech. It also answers in Traditional Chinese about a fifth of the time.
  Metal helps on a Mac (small took 0.4 s per clip here, with the same accuracy), but not on Intel or Linux.
- **distil-whisper, Parakeet, Nemotron, Moonshine for English.** English or European languages only, so
  they can't be the default. Parakeet TDT 0.6B v3 covers [25 European languages](https://catalog.ngc.nvidia.com/orgs/nim/nvidia/containers/parakeet-0.6b-tdt/1.3.0), not Chinese.
- **Moonshine for Chinese.** One language per model, so no mixed speech, and non-English models are
  under a [community licence](https://www.mintlify.com/moonshine-ai/moonshine/resources/faq) with a revenue limit.
- **FireRedASR2, Paraformer.** Strong Chinese, weak English: FireRed's mixed English words are 60% wrong
  and its text is capitals with no punctuation; Paraformer spells English out letter by letter.
- **FunASR Nano.** 802 MB for an int8 build, in the same class as Qwen3-ASR. Not measured.
- **Qwen3-ASR 1.7B.** [Best published accuracy](https://huggingface.co/GilgameshWind/X-ASR-zh-en), but no
  CPU-sized build in sherpa-onnx, and the official route is Python and PyTorch.

X-ASR's own card reports the same order on other data: Qwen3-ASR 0.6B 5.70, X-ASR 6.04, SenseVoice 6.76
on average across English and Chinese test sets. Its authors made it and its report is still "coming
soon", so measuring it here mattered.

## Costs and risks of the choice

- **Two engines.** whisper.cpp stays for hand-installed models, so the route has two argument lists and
  two ways of reading the output: about 40 lines. Moving everyone to one engine isn't worth breaking a
  setup that works.
- **Qwen3-ASR's export is a community one**, and twice in 138 clips it returned nonsense in place of a
  sentence (`提纲`, a lone `�`). It is offered as an explicit choice, never suggested.
- **SenseVoice's licence** ([FunASR Model Open Source License](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE))
  allows using and sharing the model with attribution, which Settings carries, but also calls it "for
  reference and learning purposes". It should be read by someone who can decide; dropping Light would
  leave the other two, both Apache-2.0.
- **X-ASR is new**: released June 2026, from one author, with a small following. Its Apache-2.0 weights are
  pinned, so it can't change underneath us, and sherpa-onnx ships it in its own model release.
- **Traditional Chinese.** X-ASR and SenseVoice write Simplified. Someone who chose 中文（繁體）gets
  Simplified from them. Converting is a separate piece of work.
- **sherpa-onnx is active and maintained**: v2.0.1 was published on 26 October 2026, Apache-2.0, with
  builds for arm64 and x64 macOS and Linux, and no compiler or Homebrew needed.

## Not measured

- Any real person dictating into localDot: real speech here means ASCEND's recordings.
- sherpa-onnx natively on macOS, on either architecture, on Metal or Core ML.
- Any real 8 GB Mac, Intel Mac or x64 Linux machine. x64 Linux ran under emulation to prove the install
  works: it installed, passed its checks and transcribed short clips correctly, though emulation is so slow
  that a minute of audio ran out of time, which says nothing about real speed. The speed words Settings
  shows on those machines are estimates from the measured numbers and their core count.
- Downloads from mainland China: these files are on GitHub, which is unreliable there. A mirror is
  described in the [release guide](release-packaging.md#speech-downloads).
