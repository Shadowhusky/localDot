import { readFile } from "node:fs/promises";
import { speechTranscriber } from "../../../daemon/src/voice/speech.ts";
import { composer, expect, runAt, test } from "./harness.ts";

// Opt-in real ASR check. Feed synthesized speech into a real Web Audio microphone graph;
// never capture the developer's microphone. Require actual local transcription responses.
// LOCALDOT_TEST_SPEECH_{AUDIO,MODEL,BINARY} select a WAV fixture and local whisper.cpp install.
runAt("c14", "w39");
test.use({ fixedClock: false });

test("local capture hears successive Stop, Cancel, Send and reload turns", async ({ page, ui }) => {
  test.setTimeout(150_000);
  const model = process.env.LOCALDOT_TEST_SPEECH_MODEL;
  const audio = process.env.LOCALDOT_TEST_SPEECH_AUDIO;
  const binary = process.env.LOCALDOT_TEST_SPEECH_BINARY;
  test.skip(!model || !audio || !binary, "Requires the opt-in local speech fixture");
  if (!model || !audio || !binary) return;
  const encoded = (await readFile(audio)).toString("base64");
  const speech = speechTranscriber({ model, binary, englishOnly: false });
  let requests = 0;
  await page.addInitScript(
    ({ encoded }) => {
      const bytes = Uint8Array.from(atob(encoded), (letter) => letter.charCodeAt(0));
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async function syntheticMicrophone() {
            const context = new AudioContext();
            await context.resume().catch((error) => {
              console.error("synthetic resume", error.name, error.message);
              throw error;
            });
            const source = context.createBufferSource();
            source.buffer = await context.decodeAudioData(bytes.slice().buffer).catch((error) => {
              console.error("synthetic decode", error.name, error.message);
              throw error;
            });
            source.loop = true;
            const destination = context.createMediaStreamDestination();
            source.connect(destination);
            source.start();
            for (const track of destination.stream.getTracks()) {
              const stop = track.stop.bind(track);
              track.stop = () => {
                stop();
                source.stop();
                void context.close();
              };
            }
            return destination.stream;
          },
        },
      });
    },
    { encoded },
  );
  // The app fixture keeps account/task actions isolated. Its voice route uses the real local
  // transcriber, including actual WAV parsing, model execution and private-file cleanup.
  await page.route("**/api/voice", (route) =>
    route.fulfill({ json: { onMac: { available: true, englishOnly: false } } }),
  );
  await page.route("**/api/voice/transcribe?*", async (route) => {
    const wav = route.request().postDataBuffer();
    expect(wav?.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav?.readUInt32LE(24)).toBe(16_000);
    requests++;
    if (!wav) throw new Error("Missing audio request");
    const text = await speech.transcribe(new Uint8Array(wav), "en");
    await route.fulfill({ json: { text } }).catch(() => {});
  });
  await ui.open("running");
  let card = await composer(page);

  const start = async () => {
    expect(await page.evaluate(() => navigator.mediaDevices.getUserMedia.name)).toBe(
      "syntheticMicrophone",
    );
    await card.getByRole("button", { name: "Start voice input" }).click();
    await expect(card.getByRole("button", { name: "Stop recording" })).toBeVisible();
  };
  const heard = async () => {
    await expect(card.getByRole("textbox")).toHaveValue(/voice recording/i, { timeout: 30_000 });
  };
  await start();
  await heard();
  await page.screenshot({ path: test.info().outputPath("local-live-transcript.png") });
  await card.getByRole("button", { name: "Stop recording" }).click();
  await expect(card.getByRole("button", { name: "Start voice input" })).toBeVisible({
    timeout: 30_000,
  });
  const first = await card.getByRole("textbox").inputValue();
  expect(first).toMatch(/voice recording/i);

  await start();
  await expect(card.getByRole("textbox")).not.toHaveValue(first, { timeout: 30_000 });
  await card.getByRole("button", { name: "Cancel recording" }).click();
  await expect(card.getByRole("textbox")).toHaveValue(first);

  await start();
  await expect(card.getByRole("textbox")).not.toHaveValue(first, { timeout: 30_000 });
  await card.getByRole("button", { name: "Send voice message" }).click();
  await expect(card.getByRole("textbox")).toHaveValue("", { timeout: 30_000 });

  await start();
  await heard();
  await page.reload();
  card = await composer(page);
  await card.getByRole("textbox").fill("");
  await start();
  await heard();
  await card.getByRole("button", { name: "Stop recording" }).click();
  await expect(card.getByRole("button", { name: "Start voice input" })).toBeVisible({
    timeout: 30_000,
  });
  expect(requests).toBeGreaterThanOrEqual(5);
});
