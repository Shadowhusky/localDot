import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LocalDotEvent } from "./events.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "events.schema.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify(z.toJSONSchema(LocalDotEvent, { unrepresentable: "any" }), null, 2)}\n`,
);
console.log(`wrote ${out}`);
