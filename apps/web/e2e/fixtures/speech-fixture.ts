import type {
  SpeechInstallJob,
  SpeechInstallStatus,
} from "../../../../packages/protocol/src/speech-install.ts";
import type { Transcriber } from "../../../daemon/src/voice/speech.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

// The computer's speech install, in memory and moved on by /__qa/speech: the real install has its
// own tests against real files. Nothing here reaches the network.
export function speechFixture() {
  const status: SpeechInstallStatus = {
    supported: true,
    host: { computer: "Mac", memoryBytes: 8 * GB, cpus: 8, arch: "arm64" },
    tiers: [
      {
        id: "light",
        name: "Light",
        summary: "Quickest on an older computer. Chinese, English, Cantonese, Japanese and Korean.",
        credit: "SenseVoice Small (FunASR model licence), run by sherpa-onnx (Apache-2.0).",
        languages: ["zh", "en", "ja", "ko", "yue"],
        downloadBytes: 182 * MB,
        diskBytes: 263 * MB,
        memoryBytes: 520 * MB,
        speed: "About a second for a short message",
      },
      {
        id: "balanced",
        name: "Balanced",
        summary: "Most accurate for Chinese, English and both in one sentence, with punctuation.",
        credit: "X-ASR zh-en (Apache-2.0), run by sherpa-onnx (Apache-2.0).",
        languages: ["zh", "en"],
        downloadBytes: 150 * MB,
        diskBytes: 202 * MB,
        memoryBytes: 900 * MB,
        speed: "A couple of seconds for a short message",
      },
      {
        id: "languages",
        name: "Most languages",
        summary:
          "The strongest English, and about 30 languages. Slower, and it needs a capable computer.",
        credit: "Qwen3-ASR 0.6B (Apache-2.0), run by sherpa-onnx (Apache-2.0).",
        languages: null,
        downloadBytes: 865 * MB,
        diskBytes: 976 * MB,
        memoryBytes: 2000 * MB,
        speed: "Tens of seconds for a short message",
        warning:
          "Tight on this computer's 8 GB of memory. Other apps may slow down while it listens.",
      },
    ],
    recommended: "balanced",
    installed: null,
    handInstalled: null,
    using: null,
    job: null,
    freeBytes: 40 * GB,
  };
  const ours: Transcriber = {
    englishOnly: false,
    languages: ["zh", "en"],
    transcribe: async () => "帮我打开 GitHub，看一下 pull request。",
  };
  return {
    status,
    // Moves the install on as the real one would, or stands in for what's already on the computer.
    set(patch: Partial<SpeechInstallStatus> & { job?: Partial<SpeechInstallJob> | null }) {
      Object.assign(status, patch, {
        job:
          patch.job === undefined
            ? status.job
            : patch.job && status.job
              ? { ...status.job, ...patch.job }
              : patch.job,
      });
    },
    speech: () => (status.using ? ours : null),
    install: {
      status: () => structuredClone(status),
      start(tier: string) {
        const chosen = status.tiers.find((one) => one.id === tier);
        if (!chosen) throw new Error("unknown tier");
        if (status.job?.state === "running") return;
        status.job = {
          tier: chosen.id,
          state: "running",
          stage: "checking",
          doneBytes: 0,
          totalBytes: chosen.downloadBytes,
        };
      },
      async cancel() {
        status.job = null;
      },
      async remove() {
        status.installed = null;
        status.using = status.handInstalled ? "hand-installed" : null;
      },
    },
  };
}
