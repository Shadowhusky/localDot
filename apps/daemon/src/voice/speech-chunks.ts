const RATE = 16_000;
const HEADER = 44;
const FRAME = Math.round(RATE * 0.03);
// A pause is looked for in the last part of each piece, so pieces don't come out needlessly short.
const LOOK_BACK_SECONDS = 5;

function wavOf(samples: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + samples.length);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples.length, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples.length, true);
  out.set(samples, HEADER);
  return out;
}

// The quietest stretch in [from, to), in samples, so a cut falls between words.
function quietestFrame(view: DataView, from: number, to: number): number {
  let best = to;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let frame = to - FRAME; frame >= from; frame -= FRAME) {
    let energy = 0;
    for (let i = frame; i < frame + FRAME; i += 4) energy += Math.abs(view.getInt16(i * 2, true));
    if (energy < bestEnergy) {
      bestEnergy = energy;
      best = frame + Math.floor(FRAME / 2);
    }
  }
  return best;
}

// These models fail or wander on long audio (X-ASR stops at about a minute; SenseVoice loses words
// well before that), so a long recording goes in pieces of at most `maxSeconds`, cut at pauses.
export function speechChunks(wav: Uint8Array, maxSeconds = 15): Uint8Array[] {
  const samples = wav.subarray(HEADER);
  const total = Math.floor(samples.length / 2);
  const limit = maxSeconds * RATE;
  if (total <= limit) return [wav];
  const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength);
  const chunks: Uint8Array[] = [];
  let start = 0;
  while (total - start > limit) {
    const end = start + limit;
    const cut = quietestFrame(view, end - LOOK_BACK_SECONDS * RATE, end);
    chunks.push(wavOf(samples.subarray(start * 2, cut * 2)));
    start = cut;
  }
  chunks.push(wavOf(samples.subarray(start * 2, total * 2)));
  return chunks;
}
