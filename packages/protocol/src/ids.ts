const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const secureRandom = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export function ulid(
  now: number = Date.now(),
  random: (n: number) => Uint8Array = secureRandom,
): string {
  let time = "";
  let rest = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = random(16);
  let entropy = "";
  for (const byte of bytes) entropy += CROCKFORD.charAt(byte % 32);
  return time + entropy;
}

export function ulidTime(id: string): number {
  if (!ULID_PATTERN.test(id)) throw new RangeError(`not a ULID: ${id}`);
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
}
