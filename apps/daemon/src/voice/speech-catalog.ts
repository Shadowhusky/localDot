import type { SpeechTierId } from "../../../../packages/protocol/src/speech-install.ts";
import type { SpeechHost } from "./speech-fit.ts";

export interface SpeechFilePin {
  sha256: string;
  bytes: number;
}

// A place the files can come from, itself pinned: any source is as good as another.
export interface SpeechSource {
  url: string;
  sha256: string;
  bytes: number;
  // The folder the files sit under in a tar archive. Without one, the source is the single file.
  root?: string;
}

export interface SpeechBundle {
  // What ends up on disk, by path. These hashes decide what may run.
  files: Record<string, SpeechFilePin>;
  sources: readonly SpeechSource[];
}

export interface SpeechTierSpec extends SpeechBundle {
  id: SpeechTierId;
  name: string;
  summary: string;
  credit: string;
  // Languages it hears, by the code the browser's language turns into; null for all of them.
  languages: readonly string[] | null;
  // Peak resident memory measured while it turned speech into text.
  memoryBytes: number;
  // Below this much memory in the computer, it would crowd out other apps.
  minimumMemoryBytes: number;
  // Measured on 4 threads: seconds to start, and seconds of work per second of speech.
  startSeconds: number;
  relativeCost: number;
  // Program flags that name a file in this bundle.
  flags: Record<string, string>;
  args: readonly string[];
}

export interface SpeechEngineTarget extends SpeechBundle {
  // Where the program and its library look for libraries before the system's own folders, relative
  // to the program's folder (its LC_RPATH or DT_RPATH). Nothing may be in one outside the bundle.
  libraryPaths: readonly string[];
}

export interface SpeechEngineSpec {
  version: string;
  // The program's path within its bundle.
  binary: string;
  targets: Partial<Record<string, SpeechEngineTarget>>;
}

export interface SpeechCatalog {
  engine: SpeechEngineSpec;
  tiers: readonly SpeechTierSpec[];
}

export const catalogTarget = (
  catalog: SpeechCatalog,
  host: Pick<SpeechHost, "platform" | "arch">,
): SpeechEngineTarget | undefined => catalog.engine.targets[`${host.platform}-${host.arch}`];

const GB = 1024 ** 3;
const MB = 1024 ** 2;

// Left beside the installed files, as these projects ask.
export const SPEECH_NOTICES = [
  "sherpa-onnx: Apache-2.0, https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
  "ONNX Runtime: MIT, https://github.com/microsoft/onnxruntime/blob/main/LICENSE",
  "X-ASR zh-en: Apache-2.0, https://huggingface.co/GilgameshWind/X-ASR-zh-en",
  "SenseVoice Small: FunASR Model Open Source License, https://github.com/FunAudioLLM/SenseVoice, https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE",
  "Qwen3-ASR 0.6B: Apache-2.0, https://github.com/QwenLM/Qwen3-ASR, ONNX export https://github.com/Wasser1462/Qwen3-ASR-onnx",
].join("\n");

// Every byte localDot downloads for speech. These pins ship inside the daemon, so a release's signed
// catalog covers them through its file inventory, and a source checkout through its commit. Each
// file is hosted by its upstream project; docs/release-packaging.md says how to add our own mirror.
export const SPEECH_CATALOG: SpeechCatalog = {
  engine: {
    version: "2.0.1",
    binary: "bin/sherpa-onnx-offline",
    targets: {
      "darwin-arm64": {
        // All four builds, read with otool -l and the ELF dynamic section on 9 November 2026.
        libraryPaths: [".", "../lib", "../../../sherpa_onnx/lib"],
        files: {
          "bin/sherpa-onnx-offline": {
            sha256: "2bda8e350cce4d77e1ffda40c71289e3db14bfeaa026ab6ba286c7b829673dfe",
            bytes: 2068816,
          },
          "lib/libonnxruntime.dylib": {
            sha256: "3567d114f7299d559993e536d605a6f46d7bc9d2542004accc80ee9bf5457f0b",
            bytes: 28775120,
          },
        },
        sources: [
          {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-osx-arm64-shared.tar.bz2",
            sha256: "5e874d3c9b3d6b8c71f7c09e3a9fb9ae846c3009129d302b398d1f7aedb69f84",
            bytes: 20348241,
            root: "sherpa-onnx-v2.0.1-osx-arm64-shared",
          },
        ],
      },
      "darwin-x64": {
        libraryPaths: [".", "../lib", "../../../sherpa_onnx/lib"],
        files: {
          "bin/sherpa-onnx-offline": {
            sha256: "220367793f1021fe2e7f54537fcf9869564725ad9bc0dfc1396027e7356b018b",
            bytes: 2207552,
          },
          "lib/libonnxruntime.dylib": {
            sha256: "2bf27180c09e6fd3f407c9ab25205ebf1ff95f2d53bfa35e35409b5849e0ac70",
            bytes: 32315856,
          },
        },
        sources: [
          {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-osx-x64-shared.tar.bz2",
            sha256: "100315fbb174de2d7fec92b67d28c4128499daf3a6f47b4da6350252680d178f",
            bytes: 22897549,
            root: "sherpa-onnx-v2.0.1-osx-x64-shared",
          },
        ],
      },
      "linux-x64": {
        libraryPaths: [".", "../lib", "../../../sherpa_onnx/lib"],
        files: {
          "bin/sherpa-onnx-offline": {
            sha256: "1dc6b2842f521538a2d73d0bb1002f7c6b1acd1bc0fbf10fbb6a823c8c1a1c60",
            bytes: 2518672,
          },
          "lib/libonnxruntime.so": {
            sha256: "4b3607aebd1784b26b6f9b20e4bd974c7ab8287043e4d095cb7d2cb40b5e566e",
            bytes: 27026609,
          },
        },
        sources: [
          {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-linux-x64-shared.tar.bz2",
            sha256: "2e823376987c3b6960d50726b6560155e2ad92da0b8b3886325773225ec6bdec",
            bytes: 28003506,
            root: "sherpa-onnx-v2.0.1-linux-x64-shared",
          },
        ],
      },
      "linux-arm64": {
        libraryPaths: [".", "../lib", "../../../sherpa_onnx/lib"],
        files: {
          "bin/sherpa-onnx-offline": {
            sha256: "d193811d7bb7f92deb45fbb6643d4df32a3116a5b8ab53f3fe87c3200d172364",
            bytes: 1775160,
          },
          "lib/libonnxruntime.so": {
            sha256: "cfc800d4438f15e8d9017521326776ca7117d8783cb847ccccc2fc61ac4d540f",
            bytes: 34606912,
          },
        },
        sources: [
          {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-linux-aarch64-shared-cpu.tar.bz2",
            sha256: "a8fc9fb3940d1aa3f83136767742b05068f00253f560d53c4f5aeb75ab4cb350",
            bytes: 27889232,
            root: "sherpa-onnx-v2.0.1-linux-aarch64-shared-cpu",
          },
        ],
      },
    },
  },
  tiers: [
    {
      id: "light",
      name: "Light",
      summary:
        "The quickest, even on an older computer. Hears Chinese, English, Cantonese, Japanese and Korean.",
      credit: "SenseVoice Small (FunASR model licence), run by sherpa-onnx (Apache-2.0).",
      languages: ["zh", "en", "yue", "ja", "ko"],
      memoryBytes: 520 * MB,
      minimumMemoryBytes: 4 * GB,
      startSeconds: 0.5,
      relativeCost: 0.03,
      flags: { "sense-voice-model": "model.int8.onnx", tokens: "tokens.txt" },
      args: ["--sense-voice-language=auto", "--sense-voice-use-itn=1"],
      files: {
        "model.int8.onnx": {
          sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
          bytes: 239233841,
        },
        "tokens.txt": {
          sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
          bytes: 315894,
        },
      },
      sources: [
        {
          url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
          sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
          bytes: 163002883,
          root: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
        },
      ],
    },
    {
      id: "balanced",
      name: "Balanced",
      summary:
        "The most accurate for Chinese, and for Chinese mixed with English, with punctuation. Good English too.",
      credit: "X-ASR zh-en (Apache-2.0), run by sherpa-onnx (Apache-2.0).",
      languages: ["zh", "en"],
      memoryBytes: 900 * MB,
      minimumMemoryBytes: 6 * GB,
      startSeconds: 1.9,
      relativeCost: 0.06,
      flags: {
        encoder: "encoder-epoch-99-avg-1.int8.onnx",
        decoder: "decoder-epoch-99-avg-1.onnx",
        joiner: "joiner-epoch-99-avg-1.int8.onnx",
        tokens: "tokens.txt",
      },
      args: ["--model-type=transducer", "--decoding-method=greedy_search"],
      files: {
        "encoder-epoch-99-avg-1.int8.onnx": {
          sha256: "7f6aa62056efd8af9da13e0faa81cd3f284d2fb2e3b63de56fd2dfd3450910dc",
          bytes: 161015713,
        },
        "decoder-epoch-99-avg-1.onnx": {
          sha256: "72f47405d3c1033bebccbef82f90071e7b4ba3e71b9c986f2b74244b25723aed",
          bytes: 11309084,
        },
        "joiner-epoch-99-avg-1.int8.onnx": {
          sha256: "aedb7fa697b2ab43f20499826fff7c997eea7d67db77be97769aeeeb726e63b3",
          bytes: 2581422,
        },
        "tokens.txt": {
          sha256: "b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c",
          bytes: 58806,
        },
      },
      sources: [
        {
          url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03.tar.bz2",
          sha256: "5d02c36d7b44e886b7c8f0d8e051f8713acab96c264bb6ef9e718be39a6a2224",
          bytes: 136396739,
          root: "sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03",
        },
      ],
    },
    {
      id: "languages",
      name: "Most languages",
      summary:
        "The strongest English, and about 30 languages. Slower, and it needs a capable computer.",
      credit: "Qwen3-ASR 0.6B (Apache-2.0), run by sherpa-onnx (Apache-2.0).",
      languages: null,
      memoryBytes: 2000 * MB,
      minimumMemoryBytes: 16 * GB,
      startSeconds: 4.3,
      relativeCost: 0.13,
      flags: {
        "qwen3-asr-conv-frontend": "conv_frontend.onnx",
        "qwen3-asr-encoder": "encoder.int8.onnx",
        "qwen3-asr-decoder": "decoder.int8.onnx",
        "qwen3-asr-tokenizer": "tokenizer",
      },
      args: ["--qwen3-asr-max-new-tokens=512", "--qwen3-asr-max-total-len=1024"],
      files: {
        "conv_frontend.onnx": {
          sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
          bytes: 44148281,
        },
        "encoder.int8.onnx": {
          sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
          bytes: 182491662,
        },
        "decoder.int8.onnx": {
          sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
          bytes: 755914231,
        },
        "tokenizer/merges.txt": {
          sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
          bytes: 1671853,
        },
        "tokenizer/tokenizer_config.json": {
          sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
          bytes: 12487,
        },
        "tokenizer/vocab.json": {
          sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
          bytes: 2776833,
        },
      },
      sources: [
        {
          url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2",
          sha256: "393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96",
          bytes: 878702423,
          root: "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
        },
      ],
    },
  ],
};
