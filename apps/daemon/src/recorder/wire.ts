// Selkies 2.0's WebSocket video message, as its client (apps/web/vendor/selkies, selkies-core)
// parses it: byte 0 is the message type (4 = encoded video); byte 1 holds the codec in its high
// nibble (1 = H.264) and 1 in its low nibble for a key frame; then u16 BE frame id, u16 BE region
// index, u16 BE width, u16 BE height, u16 BE reserved, and the Annex B access unit.

export const VIDEO_MESSAGE = 4;
export const VIDEO_HEADER = 12;
export const CODEC_H264 = 1;

export type SelkiesMessage =
  | {
      kind: "video";
      key: boolean;
      codec: number;
      frameId: number;
      region: number;
      width: number;
      height: number;
      data: Uint8Array;
    }
  | { kind: "ignored"; type: number };

export function parseSelkiesMessage(buf: Uint8Array): SelkiesMessage {
  const type = buf[0] ?? -1;
  if (type !== VIDEO_MESSAGE || buf.length <= VIDEO_HEADER) return { kind: "ignored", type };
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = v.getUint8(1);
  return {
    kind: "video",
    key: (flags & 0x0f) === 1,
    codec: flags >> 4,
    frameId: v.getUint16(2),
    region: v.getUint16(4),
    width: v.getUint16(6),
    height: v.getUint16(8),
    data: buf.subarray(VIDEO_HEADER),
  };
}
