import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";

// The receiving browser's half of RFC 8291, for tests and the fake push service only.
export function decryptPush(message: Buffer, receiverPrivate: Buffer, authSecret: Buffer): Buffer {
  const salt = message.subarray(0, 16);
  const idlen = message.readUInt8(20);
  const senderPublic = message.subarray(21, 21 + idlen);
  const receiver = createECDH("prime256v1");
  receiver.setPrivateKey(receiverPrivate);
  const shared = receiver.computeSecret(senderPublic);
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    receiver.getPublicKey(),
    senderPublic,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, info, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const data = message.subarray(21 + idlen);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const record = Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (record[end] !== 2) throw new Error("not a final aes128gcm record");
  return record.subarray(0, end);
}

// A browser's subscription keys, as PushSubscription.toJSON() gives them.
export function browserKeys(): {
  p256dh: string;
  auth: string;
  privateKey: Buffer;
  authSecret: Buffer;
} {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const authSecret = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 7 + 3));
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: authSecret.toString("base64url"),
    privateKey: ecdh.getPrivateKey(),
    authSecret,
  };
}
