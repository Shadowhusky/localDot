import { execFile as nodeExecFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// A speech-to-text model already installed on this computer, run by whisper.cpp's command line.
export interface SpeechModel {
  readonly binary: string;
  readonly model: string;
  readonly englishOnly: boolean;
}

export interface SpeechLookup {
  env: NodeJS.ProcessEnv;
  home: string;
  isFile(path: string): boolean;
  list(dir: string): readonly string[];
}

const BINARIES = ["whisper-cli", "whisper-cpp"];
const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const MODEL_DIRS = (home: string) => [
  "/opt/homebrew/share/whisper.cpp",
  "/usr/local/share/whisper.cpp",
  "/opt/homebrew/share/whisper-cpp",
  "/usr/local/share/whisper-cpp",
  join(home, ".cache", "whisper.cpp"),
  join(home, "whisper.cpp", "models"),
  join(home, "Library", "Application Support", "whisper.cpp"),
];
// Fastest useful first. The full large models are too slow for a message someone waits to send.
const RANK = [/^large-v3-turbo\b/, /^small\b/, /^base\b/, /^medium\b/, /^tiny\b/];
const MODEL_FILE = /^ggml-(.+)\.bin$/;
const ENGLISH_ONLY = /\.en(?![a-z])/;

export const hostSpeechLookup = (): SpeechLookup => ({
  env: process.env,
  home: homedir(),
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
});

export function findSpeechModel(lookup: SpeechLookup): SpeechModel | null {
  const dirs = [...(lookup.env.PATH ?? "").split(delimiter).filter(Boolean), ...BIN_DIRS];
  const binary = BINARIES.flatMap((name) => dirs.map((dir) => join(dir, name))).find(lookup.isFile);
  if (!binary) return null;
  const model = modelFile(lookup);
  if (!model) return null;
  const stem = MODEL_FILE.exec(model.split("/").at(-1) ?? "")?.[1] ?? "";
  return { binary, model, englishOnly: ENGLISH_ONLY.test(stem) };
}

function modelFile(lookup: SpeechLookup): string | null {
  const chosen = lookup.env.LOCALDOT_SPEECH_MODEL;
  if (chosen) return lookup.isFile(chosen) ? chosen : null;
  const found = MODEL_DIRS(lookup.home).flatMap((dir) =>
    lookup.list(dir).flatMap((name) => {
      const stem = MODEL_FILE.exec(name)?.[1];
      const rank = stem ? RANK.findIndex((pattern) => pattern.test(stem)) : -1;
      return stem && rank >= 0 && !stem.includes("for-tests") && lookup.isFile(join(dir, name))
        ? [{ path: join(dir, name), rank: rank * 2 + (ENGLISH_ONLY.test(stem) ? 1 : 0) }]
        : [];
    }),
  );
  return found.sort((a, b) => a.rank - b.rank)[0]?.path ?? null;
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number; signal?: AbortSignal },
  callback: (error: Error | null, stdout: string) => void,
) => void;

export class SpeechBusyError extends Error {
  constructor() {
    super("speech is already being turned into text");
    this.name = "SpeechBusyError";
  }
}

export interface Transcriber {
  readonly englishOnly: boolean;
  // A 16 kHz mono WAV in, its words out. The audio lives in a private temporary folder only while
  // the model reads it.
  transcribe(wav: Uint8Array, language: string | null, signal?: AbortSignal): Promise<string>;
}

const TIMEOUT_MS = 30_000;
const NOISE = /^[[(].*[\])]$/;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

export function speechTranscriber(
  model: SpeechModel,
  opts: { execFile?: ExecFile; tmp?: string } = {},
): Transcriber {
  const run = opts.execFile ?? (nodeExecFile as unknown as ExecFile);
  let busy = false;
  return {
    englishOnly: model.englishOnly,
    async transcribe(wav, language, signal) {
      signal?.throwIfAborted();
      if (busy) throw new SpeechBusyError();
      busy = true;
      let dir: string | undefined;
      try {
        dir = await mkdtemp(join(opts.tmp ?? tmpdir(), "localdot-voice-"));
        signal?.throwIfAborted();
        const file = join(dir, "speech.wav");
        await writeFile(file, wav, { mode: 0o600 });
        const args = ["-m", model.model, "-f", file, "-l", language ?? "auto", "-nt", "-np"];
        const out = await new Promise<string>((resolve, reject) =>
          run(
            model.binary,
            args,
            {
              timeout: TIMEOUT_MS,
              maxBuffer: 256 * 1024,
              signal,
              env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
            },
            (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
          ),
        );
        return spokenText(out);
      } finally {
        busy = false;
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

// The model's lines as one text: markers such as [BLANK_AUDIO] dropped, and no space between two
// lines of Chinese or Japanese.
export function spokenText(out: string): string {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.test(line))
    .reduce((text, line) => {
      if (!text) return line;
      const joined = WIDE.test(text.at(-1) ?? "") && WIDE.test(line[0] ?? "");
      return joined ? text + line : `${text} ${line}`;
    }, "");
}

// The model as the computer has it now, so one installed while localDot runs is found. The same
// model keeps its transcriber, and with it the one-at-a-time rule.
export function installedSpeech(lookup = hostSpeechLookup): () => Transcriber | null {
  let kept: { key: string; transcriber: Transcriber } | null = null;
  return () => {
    const model = findSpeechModel(lookup());
    if (!model) {
      kept = null;
      return null;
    }
    const key = `${model.binary}\n${model.model}`;
    if (kept?.key !== key) kept = { key, transcriber: speechTranscriber(model) };
    return kept.transcriber;
  };
}
