import { z } from "zod";

// find takes query; save takes name and app, with the handle and a short note when known.
export const PeopleInput = z.object({
  op: z.enum(["find", "save"]),
  query: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(100).optional(),
  app: z.string().min(1).max(40).optional(),
  handle: z.string().min(1).max(200).optional(),
  note: z.string().min(1).max(300).optional(),
});
export type PeopleInput = z.infer<typeof PeopleInput>;
