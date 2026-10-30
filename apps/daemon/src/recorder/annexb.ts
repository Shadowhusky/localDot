// NAL unit types of an Annex B access unit (start codes 00 00 01 or 00 00 00 01).
export function nalTypes(au: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      out.push((au[i + 3] ?? 0) & 0x1f);
      i += 2;
    }
  }
  return out;
}

export const NAL_IDR = 5;
export const NAL_SPS = 7;
export const NAL_PPS = 8;

// A recording may start only on a frame a decoder can start from: an IDR with its parameter sets.
export function isRandomAccess(au: Uint8Array): boolean {
  const t = nalTypes(au);
  return t.includes(NAL_IDR) && t.includes(NAL_SPS) && t.includes(NAL_PPS);
}

// RFC 6381 avc1.PPCCLL from the first SPS: profile_idc, constraint flags, level_idc.
export function avcCodecString(au: Uint8Array): string | null {
  for (let i = 0; i + 6 < au.length; i++) {
    if (
      au[i] === 0 &&
      au[i + 1] === 0 &&
      au[i + 2] === 1 &&
      ((au[i + 3] ?? 0) & 0x1f) === NAL_SPS
    ) {
      const hex = (b: number | undefined) => (b ?? 0).toString(16).padStart(2, "0");
      return `avc1.${hex(au[i + 4])}${hex(au[i + 5])}${hex(au[i + 6])}`;
    }
  }
  return null;
}

// The same stream at another level: a viewer's lower frame rate makes the encoder pick a lower level
// for the same picture, which decodes alike.
export function sameAvcStream(codec: string | null, recorded: string | null): boolean {
  return !!codec && !!recorded && codec.slice(0, -2) === recorded.slice(0, -2);
}

// An MP4 track's AVCDecoderConfigurationRecord (avcC): its NAL length size and parameter sets.
export interface AvcConfig {
  lengthSize: number;
  parameterSets: Uint8Array[];
}

export function parseAvcC(avcC: Uint8Array): AvcConfig {
  const fail = () => new RangeError("invalid avcC record");
  if (avcC[0] !== 1 || avcC.length < 7) throw fail();
  const lengthSize = ((avcC[4] ?? 0) & 0b11) + 1;
  if (lengthSize === 3) throw fail();
  const parameterSets: Uint8Array[] = [];
  let at = 5;
  for (const mask of [0x1f, 0xff]) {
    const count = (avcC[at++] ?? 0) & mask;
    for (let i = 0; i < count; i++) {
      const size = ((avcC[at] ?? 0) << 8) | (avcC[at + 1] ?? 0);
      if (size === 0 || at + 2 + size > avcC.length) throw fail();
      parameterSets.push(avcC.subarray(at + 2, at + 2 + size));
      at += 2 + size;
    }
  }
  if (!parameterSets.length) throw fail();
  return { lengthSize, parameterSets };
}

// An MP4 sample's length-prefixed NAL units as an Annex B access unit. A key frame leads with the
// parameter sets, as the live stream's do, so it starts a recording or a fragment on its own.
export function avccToAnnexB(sample: Uint8Array, config: AvcConfig, key: boolean): Uint8Array {
  const units: Uint8Array[] = [];
  for (let at = 0; at < sample.length; ) {
    let size = 0;
    for (let i = 0; i < config.lengthSize; i++) size = size * 256 + (sample[at + i] ?? 0);
    at += config.lengthSize;
    if (size === 0 || at + size > sample.length) throw new RangeError("invalid AVC sample");
    units.push(sample.subarray(at, at + size));
    at += size;
  }
  if (key && !units.some((unit) => ((unit[0] ?? 0) & 0x1f) === NAL_SPS))
    units.unshift(...config.parameterSets);
  const out = new Uint8Array(units.reduce((n, unit) => n + 4 + unit.length, 0));
  let at = 0;
  for (const unit of units) {
    out.set([0, 0, 0, 1], at);
    out.set(unit, at + 4);
    at += 4 + unit.length;
  }
  return out;
}
