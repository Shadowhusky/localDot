const DEFAULT_PORT = 4750;

export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new RangeError(`expected an integer from 1 to 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}
