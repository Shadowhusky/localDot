import { execFile as nodeExecFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { speechChunks } from "./speech-chunks.ts";

// A speech-to-text model the person installed themselves, run by whisper.cpp's command line.
export interface HandInstalledModel {
  readonly binary: string;
  readonly model: string;
  readonly englishOnly: boolean;
}

// A model localDot installed: the program, its flags, and the languages it hears.
export interface InstalledModel {
  readonly binary: string;
  readonly args: readonly string[];
  readonly languages: readonly string[] | null;
}

export type SpeechModel = HandInstalledModel | InstalledModel;
const isInstalled = (model: SpeechModel): model is InstalledModel => "args" in model;

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

export function findSpeechModel(lookup: SpeechLookup): HandInstalledModel | null {
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
  // The languages it hears; absent or null when any language will do.
  readonly languages?: readonly string[] | null;
  // A 16 kHz mono WAV in, its words out. The audio lives in a private temporary folder only while
  // the model reads it.
  transcribe(wav: Uint8Array, language: string | null, signal?: AbortSignal): Promise<string>;
}

const TIMEOUT_MS = 30_000;
const PIECES_PER_RUN = 3;
const WAV_BYTES_PER_SECOND = 32_000;
// A long recording takes longer on a slow computer, so it isn't lost at the very moment it's sent.
export const speechTimeoutMs = (bytes: number) =>
  Math.max(TIMEOUT_MS, Math.ceil(bytes / WAV_BYTES_PER_SECOND) * 1000 + TIMEOUT_MS / 2);
const NOISE = /^[[(].*[\])]$/;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

// Where recordings wait while they're read: a private folder under localDot's home, emptied at
// start-up, so audio never outlives a daemon that stopped mid-way.
export async function sweepVoiceAudio(dir: string) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export function speechTranscriber(
  model: SpeechModel,
  opts: { execFile?: ExecFile; tmp: string },
): Transcriber {
  const run = opts.execFile ?? (nodeExecFile as unknown as ExecFile);
  let busy = false;
  const installed = isInstalled(model) ? model : null;
  const hand = isInstalled(model) ? null : model;
  return {
    englishOnly: hand?.englishOnly ?? installed?.languages?.join() === "en",
    languages: installed?.languages ?? null,
    async transcribe(wav, language, signal) {
      signal?.throwIfAborted();
      if (busy) throw new SpeechBusyError();
      busy = true;
      let dir: string | undefined;
      try {
        await mkdir(opts.tmp, { recursive: true, mode: 0o700 });
        dir = await mkdtemp(join(opts.tmp, "localdot-voice-"));
        signal?.throwIfAborted();
        const pieces = installed ? speechChunks(wav) : [wav];
        const files = pieces.map((_, index) => join(dir as string, `speech-${index}.wav`));
        await Promise.all(
          pieces.map((piece, index) => writeFile(files[index] as string, piece, { mode: 0o600 })),
        );
        const once = (args: readonly string[]) =>
          new Promise<string>((resolve, reject) =>
            run(
              model.binary,
              args,
              {
                timeout: speechTimeoutMs(wav.length),
                maxBuffer: installed ? 8 * 1024 * 1024 : 256 * 1024,
                signal,
                env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
              },
              (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
            ),
          );
        if (!installed) {
          const [file = ""] = files;
          return spokenText(
            await once([
              "-m",
              hand?.model ?? "",
              "-f",
              file,
              "-l",
              language ?? "auto",
              "-nt",
              "-np",
            ]),
          );
        }
        // The program holds every piece of one run in memory at once, so long audio takes a few runs.
        const said: string[] = [];
        for (let at = 0; at < files.length; at += PIECES_PER_RUN) {
          signal?.throwIfAborted();
          const group = files.slice(at, at + PIECES_PER_RUN);
          said.push(...installedWords(await once([...installed.args, ...group]), group.length));
        }
        return spokenText(said.join("\n"));
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

// The program prints one line of JSON per piece of audio, in order. Fewer lines than pieces means
// it failed part way, which is not the same as silence.
function installedWords(out: string, pieces: number): string[] {
  const lines = out.split("\n").filter((line) => line.trimStart().startsWith("{"));
  if (lines.length !== pieces) throw new Error("the speech program printed no words line");
  return lines.map((line) => {
    let text: unknown;
    try {
      text = (JSON.parse(line) as { text?: unknown }).text;
    } catch {
      text = undefined;
    }
    if (typeof text !== "string") throw new Error("the speech program printed no words line");
    return text.replace(/([，。！？、；：])\s+/gu, "$1").trim();
  });
}

// The model as the computer has it now, so one installed while localDot runs is found. The same
// model keeps its transcriber, and with it the one-at-a-time rule. A model named in
// LOCALDOT_SPEECH_MODEL comes first, then what localDot installed, then any Whisper found here.
export function installedSpeech(
  lookup: () => SpeechLookup,
  ours: () => InstalledModel | null,
  opts: { audio: string; execFile?: ExecFile },
): () => Transcriber | null {
  let kept: { key: string; transcriber: Transcriber } | null = null;
  return () => {
    const found = lookup();
    const named = found.env.LOCALDOT_SPEECH_MODEL ? findSpeechModel(found) : null;
    const model = named ?? ours() ?? findSpeechModel(found);
    if (!model) {
      kept = null;
      return null;
    }
    const key = isInstalled(model)
      ? `${model.binary}\n${model.args.join("\n")}`
      : `${model.binary}\n${model.model}`;
    if (kept?.key !== key)
      kept = {
        key,
        transcriber: speechTranscriber(model, { tmp: opts.audio, execFile: opts.execFile }),
      };
    return kept.transcriber;
  };
}
