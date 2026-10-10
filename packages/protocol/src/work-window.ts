import { z } from "zod";

// A passive rendering of already-redacted Activity events. No paths to read, commands,
// HTML, links, or agent tools are accepted by the computer's display process.
export const WorkWindowUpdate = z.strictObject({
  phase: z.string().min(1).max(100),
  visible: z.boolean(),
  title: z.string().max(240),
  text: z.string().max(12000),
});
export type WorkWindowUpdate = z.infer<typeof WorkWindowUpdate>;
