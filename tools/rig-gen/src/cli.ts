import { readFileSync, writeFileSync } from "node:fs";
import { buildSkeleton } from "./build.ts";
import type { RigDescription } from "./types.ts";
import { RigError } from "./validate.ts";

export interface CliIo {
  read(path: string): string;
  write(path: string, text: string): void;
  error(message: string): void;
}

const nodeIo: CliIo = {
  read: (path) => readFileSync(path, "utf8"),
  write: (path, text) => writeFileSync(path, text),
  error: (message) => console.error(message),
};

export function run(args: string[], io: CliIo = nodeIo): number {
  if (args.length !== 2) {
    io.error("usage: rig-gen <rig-description.json> <out-skeleton.json>");
    return 2;
  }
  const [input, output] = args as [string, string];
  let desc: RigDescription;
  try {
    desc = JSON.parse(io.read(input)) as RigDescription;
  } catch (error) {
    io.error(`cannot read ${input}: ${(error as Error).message}`);
    return 1;
  }
  let skeleton: string;
  try {
    skeleton = `${JSON.stringify(buildSkeleton(desc))}\n`;
  } catch (error) {
    if (error instanceof RigError) {
      io.error(error.message);
      return 1;
    }
    throw error;
  }
  io.write(output, skeleton);
  return 0;
}
