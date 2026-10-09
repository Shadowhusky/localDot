import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

// RFC 8291 message encryption (aes128gcm, RFC 8188) for one Web Push subscription. Only the
// subscription's public keys are needed; the result is opaque to keyd and the push service.
export const RECORD_SIZE = 4096;
// One record: the 86-byte header, the 16-byte tag and the padding delimiter fit beside the text.
export const MAX_PLAINTEXT = RECORD_SIZE - 86 - 16 - 1;

export interface EceFixed {
  senderPrivate: Buffer;
  salt: Buffer;
}

export function encryptPush(
  plaintext: Uint8Array,
  receiverPublic: Uint8Array,
  authSecret: Uint8Array,
  fixed?: EceFixed,
): Buffer {
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 4)
    throw new RangeError("the subscription key must be an uncompressed P-256 point");
  if (authSecret.length !== 16)
    throw new RangeError("the subscription auth secret must be 16 bytes");
  if (plaintext.length > MAX_PLAINTEXT) throw new RangeError("the push message is too long");
  const sender = createECDH("prime256v1");
  if (fixed) sender.setPrivateKey(fixed.senderPrivate);
  else sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const salt = fixed?.salt ?? randomBytes(16);
  const shared = sender.computeSecret(receiverPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, info, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, sealed]);
}
