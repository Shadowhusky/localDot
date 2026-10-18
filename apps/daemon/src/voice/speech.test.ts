import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ExecFile,
  findSpeechModel,
  SpeechBusyError,
  type SpeechLookup,
  speechTranscriber,
  spokenText,
} from "./speech.ts";

function lookup(files: readonly string[], env: NodeJS.ProcessEnv = {}): SpeechLookup {
  const all = new Set(files);
  return {
    env: { PATH: "/usr/bin:/bin", ...env },
    home: "/Users/me",
    isFile: (path) => all.has(path),
    list: (dir) =>
      [...all]
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1)),
  };
}

describe("finding a speech model", () => {
  it("needs both the program and a model", () => {
    expect(findSpeechModel(lookup(["/opt/homebrew/bin/whisper-cli"]))).toBeNull();
    expect(findSpeechModel(lookup(["/Users/me/.cache/whisper.cpp/ggml-base.bin"]))).toBeNull();
  });

  it("prefers the fastest useful model and multilingual over English-only", () => {
    const found = findSpeechModel(
      lookup([
        "/opt/homebrew/bin/whisper-cli",
        "/Users/me/.cache/whisper.cpp/ggml-tiny.bin",
        "/Users/me/.cache/whisper.cpp/ggml-base.en.bin",
        "/Users/me/.cache/whisper.cpp/ggml-base.bin",
        "/Users/me/.cache/whisper.cpp/ggml-large-v3.bin",
      ]),
    );
    expect(found).toEqual({
      binary: "/opt/homebrew/bin/whisper-cli",
      model: "/Users/me/.cache/whisper.cpp/ggml-base.bin",
      englishOnly: false,
    });
  });

  it("never picks a full large model or a test model", () => {
    expect(
      findSpeechModel(
        lookup([
          "/usr/local/bin/whisper-cpp",
          "/opt/homebrew/share/whisper-cpp/ggml-large-v3.bin",
          "/opt/homebrew/share/whisper-cpp/for-tests-ggml-tiny.bin",
        ]),
      ),
    ).toBeNull();
    expect(
      findSpeechModel(
        lookup([
          "/usr/local/bin/whisper-cpp",
          "/opt/homebrew/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin",
        ]),
      )?.model,
    ).toBe("/opt/homebrew/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin");
  });

  it("knows an English-only model and takes the one the user named", () => {
    const named = lookup(["/usr/bin/whisper-cli", "/models/ggml-small.en-q5_1.bin"], {
      LOCALDOT_SPEECH_MODEL: "/models/ggml-small.en-q5_1.bin",
    });
    expect(findSpeechModel(named)).toEqual({
      binary: "/usr/bin/whisper-cli",
      model: "/models/ggml-small.en-q5_1.bin",
      englishOnly: true,
    });
    expect(
      findSpeechModel(
        lookup(["/usr/bin/whisper-cli"], { LOCALDOT_SPEECH_MODEL: "/models/missing.bin" }),
      ),
    ).toBeNull();
  });
});

describe("turning speech into text", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ld-voice-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const model = { binary: "/bin/whisper-cli", model: "/m/ggml-base.bin", englishOnly: false };

  it("runs the model on a private file and removes it after", async () => {
    const calls: { file: string; args: readonly string[]; wav: boolean }[] = [];
    const execFile: ExecFile = (file, args, _options, callback) => {
      const wav = args[args.indexOf("-f") + 1] ?? "";
      calls.push({ file, args, wav: existsSync(wav) });
      callback(null, " Book a table for two.\n[BLANK_AUDIO]\n at seven\n");
    };
    const speech = speechTranscriber(model, { execFile, tmp });
    await expect(speech.transcribe(new Uint8Array([1, 2]), "en")).resolves.toBe(
      "Book a table for two. at seven",
    );
    expect(calls[0]?.file).toBe("/bin/whisper-cli");
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["-m", "/m/ggml-base.bin", "-l", "en"]));
    expect(calls[0]?.wav).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("removes the audio when the model fails, and takes one recording at a time", async () => {
    let finish: (error: Error | null, out: string) => void = () => {};
    const execFile: ExecFile = (_file, _args, _options, callback) => {
      finish = callback;
    };
    const speech = speechTranscriber(model, { execFile, tmp });
    const first = speech.transcribe(new Uint8Array([1]), null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(speech.transcribe(new Uint8Array([1]), null)).rejects.toBeInstanceOf(
      SpeechBusyError,
    );
    finish(new Error("crashed"), "");
    await expect(first).rejects.toThrow("crashed");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("joins Chinese and Japanese lines without spaces", () => {
    expect(spokenText("帮我订\n两个人的位子\n")).toBe("帮我订两个人的位子");
    expect(spokenText("(music)\n")).toBe("");
  });
});

it("does not stay busy if the temporary folder cannot be created", async () => {
  const speech = speechTranscriber(
    { binary: "/bin/whisper-cli", model: "/model", englishOnly: false },
    { tmp: "/nonexistent/localdot/voice" },
  );
  await expect(speech.transcribe(new Uint8Array([1]), "en")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(speech.transcribe(new Uint8Array([1]), "en")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("does not start a model for an already cancelled request", async () => {
  const speech = speechTranscriber({
    binary: "/bin/whisper-cli",
    model: "/model",
    englishOnly: false,
  });
  await expect(
    speech.transcribe(new Uint8Array([1]), "en", AbortSignal.abort()),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("passes cancellation to the process and accepts the next recording after it exits", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ld-voice-cancel-"));
  let reached = false;
  const execFile: ExecFile = (_file, _args, options, callback) => {
    reached = true;
    options.signal?.addEventListener("abort", () => callback(new Error("cancelled"), ""), {
      once: true,
    });
    if (!options.signal) callback(null, "next recording");
  };
  const speech = speechTranscriber(
    { binary: "/bin/whisper-cli", model: "/model", englishOnly: false },
    { tmp, execFile },
  );
  const controller = new AbortController();
  try {
    const pending = speech.transcribe(new Uint8Array([1]), "en", controller.signal);
    await vi.waitFor(() => expect(reached).toBe(true));
    const cancelled = expect(pending).rejects.toThrow("cancelled");
    controller.abort();
    await cancelled;
    await expect(speech.transcribe(new Uint8Array([1]), "en")).resolves.toBe("next recording");
    expect(readdirSync(tmp)).toEqual([]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
