import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ExecFile,
  findSpeechModel,
  installedSpeech,
  SpeechBusyError,
  type SpeechLookup,
  speechTranscriber,
  spokenText,
  sweepVoiceAudio,
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
    let finish: ((error: Error | null, out: string) => void) | undefined;
    const execFile: ExecFile = (_file, _args, _options, callback) => {
      finish = callback;
    };
    const speech = speechTranscriber(model, { execFile, tmp });
    const first = speech.transcribe(new Uint8Array([1]), null);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(speech.transcribe(new Uint8Array([1]), null)).rejects.toBeInstanceOf(
      SpeechBusyError,
    );
    finish?.(new Error("crashed"), "");
    await expect(first).rejects.toThrow("crashed");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("joins Chinese and Japanese lines without spaces", () => {
    expect(spokenText("帮我订\n两个人的位子\n")).toBe("帮我订两个人的位子");
    expect(spokenText("(music)\n")).toBe("");
  });
});

it("does not stay busy if the temporary folder cannot be created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-voice-blocked-"));
  writeFileSync(join(dir, "a-file"), "");
  const speech = speechTranscriber(
    { binary: "/bin/whisper-cli", model: "/model", englishOnly: false },
    { tmp: join(dir, "a-file", "voice") },
  );
  try {
    await expect(speech.transcribe(new Uint8Array([1]), "en")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(speech.transcribe(new Uint8Array([1]), "en")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("does not start a model for an already cancelled request", async () => {
  const speech = speechTranscriber(
    { binary: "/bin/whisper-cli", model: "/model", englishOnly: false },
    { tmp: join(tmpdir(), "ld-voice-never-made") },
  );
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

const AUDIO = join(tmpdir(), "ld-voice-route-audio");

describe("which speech model the voice route uses", () => {
  const hand = lookup([
    "/opt/homebrew/bin/whisper-cli",
    "/Users/me/.cache/whisper.cpp/ggml-base.bin",
  ]);
  const ours = {
    binary: "/home/.localdot/speech/engine/2.0.1/bin/sherpa-onnx-offline",
    args: ["--encoder=/home/.localdot/speech/models/light/encoder.onnx"],
    languages: ["zh", "en"],
  };

  it("uses what localDot installed once it has passed its checks", () => {
    const route = installedSpeech(
      () => hand,
      () => ours,
      { audio: AUDIO },
    )();
    expect(route?.languages).toEqual(["zh", "en"]);
    expect(route?.englishOnly).toBe(false);
  });

  it("keeps a hand-installed Whisper working when nothing is installed here", () => {
    const route = installedSpeech(
      () => hand,
      () => null,
      { audio: AUDIO },
    )();
    expect(route).not.toBeNull();
    expect(route?.languages).toBeNull();
  });

  it("falls back to a hand-installed Whisper when the installed files fail their checks", () => {
    let usable: typeof ours | null = ours;
    const route = installedSpeech(
      () => hand,
      () => usable,
      { audio: AUDIO },
    );
    expect(route()?.languages).toEqual(["zh", "en"]);
    usable = null;
    expect(route()?.languages).toBeNull();
  });

  it("lets a model named in LOCALDOT_SPEECH_MODEL outrank an install", () => {
    const named = lookup(["/usr/bin/whisper-cli", "/models/ggml-small.bin"], {
      LOCALDOT_SPEECH_MODEL: "/models/ggml-small.bin",
    });
    expect(
      installedSpeech(
        () => named,
        () => ours,
        { audio: AUDIO },
      )()?.languages,
    ).toBeNull();
  });

  it("has none with neither", () => {
    expect(
      installedSpeech(
        () => lookup([]),
        () => null,
        { audio: AUDIO },
      )(),
    ).toBeNull();
  });

  it("keeps the one-at-a-time rule while the same model stays in use", () => {
    const route = installedSpeech(
      () => hand,
      () => ours,
      { audio: AUDIO },
    );
    expect(route()).toBe(route());
  });
});

describe("running the installed model", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ld-voice-installed-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const installed = {
    binary: "/speech/bin/sherpa-onnx-offline",
    args: ["--encoder=/speech/models/light/encoder.onnx", "--num-threads=4"],
    languages: ["zh", "en"],
  };

  it("passes the audio last and reads the words from its one line of JSON", async () => {
    let seen: readonly string[] = [];
    const execFile: ExecFile = (_file, args, _options, callback) => {
      seen = args;
      callback(
        null,
        '{"lang": "", "emotion": "", "event": "", "text": "Please 把这个 file 上传到 Google Drive， 然后 share 给我。", "timestamps": [0.32]}\n',
      );
    };
    const speech = speechTranscriber(installed, { execFile, tmp });
    await expect(speech.transcribe(new Uint8Array([1, 2]), "zh")).resolves.toBe(
      "Please 把这个 file 上传到 Google Drive，然后 share 给我。",
    );
    expect(seen.slice(0, 2)).toEqual(installed.args);
    expect(seen.at(-1)).toMatch(/speech-0\.wav$/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("sends a long recording in pieces, a few to a run, in order, and joins the words", async () => {
    const runs: string[][] = [];
    const execFile: ExecFile = (_file, args, _options, callback) => {
      const pieces = args.filter((arg) => arg.endsWith(".wav"));
      runs.push(pieces.map((piece) => piece.split("/").at(-1) ?? ""));
      callback(
        null,
        pieces.map((piece) => `{"text": "第${/(\d+)\.wav$/.exec(piece)?.[1]}段"}`).join("\n"),
      );
    };
    const speech = speechTranscriber(installed, { execFile, tmp });
    const long = new Uint8Array(44 + 2 * 16_000 * 50);
    await expect(speech.transcribe(long, "zh")).resolves.toBe("第0段第1段第2段第3段");
    expect(runs).toEqual([["speech-0.wav", "speech-1.wav", "speech-2.wav"], ["speech-3.wav"]]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("doesn't pass off a partial answer as the whole recording", async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) =>
      callback(null, '{"text": "only the first piece"}\n');
    const speech = speechTranscriber(installed, { execFile, tmp });
    await expect(speech.transcribe(new Uint8Array(44 + 2 * 16_000 * 40), "en")).rejects.toThrow(
      /no words line/,
    );
  });

  it("treats a run with no words line as a failure, not as silence", async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) => callback(null, "nothing\n");
    const speech = speechTranscriber(installed, { execFile, tmp });
    await expect(speech.transcribe(new Uint8Array([1]), "en")).rejects.toThrow(/no words line/);
  });

  it("returns silence as no words", async () => {
    const execFile: ExecFile = (_file, _args, _options, callback) =>
      callback(null, '{"text": "", "timestamps": []}\n');
    const speech = speechTranscriber(installed, { execFile, tmp });
    await expect(speech.transcribe(new Uint8Array([1]), "en")).resolves.toBe("");
  });

  it("gives a long recording longer to finish", async () => {
    let timeout = 0;
    const execFile: ExecFile = (_file, args, options, callback) => {
      timeout = options.timeout;
      const pieces = args.filter((arg) => arg.endsWith(".wav"));
      callback(null, pieces.map(() => '{"text": "ok"}').join("\n"));
    };
    const speech = speechTranscriber(installed, { execFile, tmp });
    await speech.transcribe(new Uint8Array(44 + 2 * 16_000 * 120), "en");
    expect(timeout).toBeGreaterThanOrEqual(120_000);
    await speech.transcribe(new Uint8Array(44 + 2 * 16_000), "en");
    expect(timeout).toBe(30_000);
  });
});

describe("where audio waits while it's read", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ld-voice-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("is a private folder under localDot's home, never the system's temporary folder", async () => {
    const audio = join(home, "voice-audio");
    let wav = "";
    const execFile: ExecFile = (_file, args, _options, callback) => {
      wav = args[args.indexOf("-f") + 1] ?? "";
      callback(null, "words\n");
    };
    const hand = lookup([
      "/opt/homebrew/bin/whisper-cli",
      "/Users/me/.cache/whisper.cpp/ggml-base.bin",
    ]);
    const route = installedSpeech(
      () => hand,
      () => null,
      { audio, execFile },
    )();
    await route?.transcribe(new Uint8Array([1]), "en");
    expect(wav.startsWith(`${audio}/`)).toBe(true);
    expect(statSync(audio).mode & 0o777).toBe(0o700);
    expect(readdirSync(audio)).toEqual([]);
  });

  it("never stops the daemon starting when something in it can't be removed", async () => {
    const audio = join(home, "voice-audio");
    mkdirSync(join(audio, "locked"), { recursive: true });
    writeFileSync(join(audio, "locked", "speech-0.wav"), "someone talking");
    chmodSync(join(audio, "locked"), 0o500);
    try {
      const use = await sweepVoiceAudio(audio);
      expect(statSync(use).isDirectory()).toBe(true);
      expect(lstatSync(use).isSymbolicLink()).toBe(false);
      expect(statSync(use).mode & 0o777).toBe(0o700);
      expect(readdirSync(use)).toEqual([]);
    } finally {
      for (const name of readdirSync(home))
        for (const inner of [join(home, name, "locked")])
          if (existsSync(inner)) chmodSync(inner, 0o700);
    }
  });

  it("removes a link in its place, never what it points to", async () => {
    const target = join(home, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "mine");
    const audio = join(home, "voice-audio");
    symlinkSync(target, audio);
    const use = await sweepVoiceAudio(audio);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("mine");
    expect(lstatSync(use).isDirectory()).toBe(true);
  });

  it("is emptied at start-up of anything a stopped localDot left behind", async () => {
    const audio = join(home, "voice-audio");
    mkdirSync(join(audio, "localdot-voice-abc"), { recursive: true });
    writeFileSync(join(audio, "localdot-voice-abc", "speech-0.wav"), "someone talking");
    await sweepVoiceAudio(audio);
    expect(readdirSync(audio)).toEqual([]);
    expect(statSync(audio).mode & 0o777).toBe(0o700);
  });
});
