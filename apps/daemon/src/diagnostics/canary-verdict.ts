import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pid = z.number().int().positive().max(0x7fffffff);
const text = z.string().max(8192);
export const CANARY_FORMS = [
  "raw",
  "base64",
  "base64+1",
  "base64+2",
  "base64url",
  "base64url+1",
  "base64url+2",
  "hex",
  "HEX",
  "utf16le",
] as const;
const form = z.enum(CANARY_FORMS);
const reportSchema = z
  .object({
    processes: count,
    bytes: count,
    files: count,
    fileBytes: count,
    unreadableMemory: count,
    fileErrors: z.array(text).max(4096),
    hits: z.array(text).max(65536),
    memoryHits: z.array(z.object({ pid, comm: text, needle: text, form }).strict()).max(65536),
    memoryReads: z.array(z.object({ pid, comm: text, bytes: count }).strict()).max(4096),
    processErrors: z
      .array(
        z
          .object({
            pid,
            comm: text,
            surface: z.enum(["comm", "environ", "cmdline", "maps", "memory"]),
            errno: z.number().int().positive(),
            vanished: z.boolean(),
            mapping: text.optional(),
          })
          .strict(),
      )
      .max(16384),
  })
  .strict();
const needle = z.string().regex(/^[A-Za-z0-9_?+-]{12,128}$/);
const controlsSchema = z
  .object({
    canary: needle,
    marker: needle,
    clipboard: needle,
    surrogate: z.string().regex(/^ld_key_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/),
    files: z
      .array(z.object({ form, path: z.string().min(1).max(4096).startsWith("/") }).strict())
      .min(10)
      .max(32),
  })
  .strict();
export type CanaryControls = z.infer<typeof controlsSchema>;
export type CanaryVerdict = {
  ok: boolean;
  reason: "passed" | "leak" | "invalid-evidence" | "incomplete-scan" | "missing-controls";
  coverage?: { processes: number; memoryBytes: number; files: number; fileBytes: number };
};

/** Evaluates one completed scan, with controls present in that same scan. Raw scanner output
 * contains private paths/process names and the synthetic needles: never return it to the UI.
 * This proves only the supplied scan's verdict. The caller must separately own the scanner,
 * verify upstream substitution/reflection and drain/scan logs before declaring a canary pass. */
export function canaryScanVerdict(raw: unknown, expected: CanaryControls): CanaryVerdict {
  const parsed = reportSchema.safeParse(raw),
    controls = controlsSchema.safeParse(expected);
  if (!parsed.success || !controls.success) return { ok: false, reason: "invalid-evidence" };
  const r = parsed.data,
    c = controls.data;
  const needles = [c.canary, c.marker, c.clipboard, c.surrogate];
  if (
    new Set(needles).size !== 4 ||
    new Set(r.hits).size !== r.hits.length ||
    new Set(r.memoryReads.map((read) => read.pid)).size !== r.memoryReads.length
  )
    return { ok: false, reason: "invalid-evidence" };
  const reads = new Map(r.memoryReads.map((read) => [read.pid, read]));
  let bytes = 0;
  for (const read of r.memoryReads) {
    bytes += read.bytes;
    if (!Number.isSafeInteger(bytes)) return { ok: false, reason: "invalid-evidence" };
  }
  if (bytes !== r.bytes || r.processes !== r.memoryReads.filter((read) => read.bytes > 0).length)
    return { ok: false, reason: "invalid-evidence" };
  const hits = new Set(r.hits);
  for (const hit of r.hits) {
    const [value, encoding, ...parts] = hit.split("|");
    const where = parts.join("|");
    if (
      !needles.includes(value ?? "") ||
      !CANARY_FORMS.some((known) => known === encoding) ||
      !(["environ", "cmdline", "memory"].includes(where) || where.startsWith("file /"))
    )
      return { ok: false, reason: "invalid-evidence" };
  }
  for (const hit of r.memoryHits) {
    const read = reads.get(hit.pid);
    if (
      !needles.includes(hit.needle) ||
      !read ||
      read.bytes === 0 ||
      read.comm !== hit.comm ||
      !hits.has(`${hit.needle}|${hit.form}|memory`)
    )
      return { ok: false, reason: "invalid-evidence" };
  }
  // Check for a leak before coverage: even an incomplete scan can establish exposure.
  if (
    r.hits.some((hit) => hit.startsWith(`${c.canary}|`)) ||
    r.memoryHits.some((hit) => hit.needle === c.canary)
  )
    return { ok: false, reason: "leak" };
  if (
    r.fileErrors.length ||
    r.processErrors.some((error) => !error.vanished) ||
    r.unreadableMemory !==
      r.processErrors.filter((error) => error.surface === "maps" || error.surface === "memory")
        .length ||
    r.processes <= 20 ||
    r.bytes <= 100 * 1024 * 1024 ||
    r.files <= 100 ||
    r.fileBytes === 0
  )
    return { ok: false, reason: "incomplete-scan" };
  const memoryControl = (value: string, comm?: string) =>
    r.memoryHits.some(
      (hit) =>
        hit.needle === value && hit.form === "raw" && (comm === undefined || hit.comm === comm),
    );
  if (
    CANARY_FORMS.some((encoding) => !c.files.some((file) => file.form === encoding)) ||
    c.files.some((file) => !hits.has(`${c.marker}|${file.form}|file ${file.path}`)) ||
    !hits.has(`${c.marker}|raw|environ`) ||
    !hits.has(`${c.marker}|raw|cmdline`) ||
    !hits.has(`${c.surrogate}|raw|environ`) ||
    !memoryControl(c.marker) ||
    !memoryControl(c.surrogate) ||
    !memoryControl(c.clipboard, "xclip")
  )
    return { ok: false, reason: "missing-controls" };
  return {
    ok: true,
    reason: "passed",
    coverage: {
      processes: r.processes,
      memoryBytes: r.bytes,
      files: r.files,
      fileBytes: r.fileBytes,
    },
  };
}
