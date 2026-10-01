const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

// Docker picks each cell network's subnet; the daemon places the gate and the desktop at fixed
// offsets inside it, so the gate knows every address before any container starts.
export function hostAddress(cidr: string, offset: number): string {
  const m = CIDR.exec(cidr);
  if (!m) throw new RangeError(`not an IPv4 CIDR: ${cidr}`);
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 30) throw new RangeError(`not an IPv4 CIDR: ${cidr}`);
  const size = 2 ** (32 - prefix);
  if (!Number.isInteger(offset) || offset < 1 || offset >= size - 1) {
    throw new RangeError(`offset ${offset} is outside the hosts of ${cidr}`);
  }
  const base = octets.reduce((acc, octet) => acc * 256 + octet, 0);
  const network = base - (base % size);
  const address = network + offset;
  return [24, 16, 8, 0].map((shift) => (address >>> shift) & 255).join(".");
}
