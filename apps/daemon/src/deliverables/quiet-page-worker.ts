import { quietPage } from "./quiet-page.ts";

// One page on stdin; what it came to on stdout as JSON: the quieted page, or null when not shown.
const parts: Buffer[] = [];
for await (const part of process.stdin) parts.push(part as Buffer);
process.stdout.write(JSON.stringify(quietPage(Buffer.concat(parts).toString("utf8")) ?? null));
