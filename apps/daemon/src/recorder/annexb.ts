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
