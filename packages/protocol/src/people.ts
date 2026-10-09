import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import { keyLikePresent } from "./key-like.ts";

export const PEOPLE_MAX = 2000;
const plain = (s: string) => s.isWellFormed() && !/\p{Cc}/u.test(s);
const field = (max: number) =>
  z.string().trim().min(1).max(max).refine(plain, "use one line of plain text");
const notKey = <T extends z.ZodType<string>>(schema: T) =>
  schema.refine((s) => !keyLikePresent(s), "key-shaped text belongs in Keys");
export const PersonName = notKey(field(100));
export const PersonApp = field(40);
export const PersonHandle = notKey(field(200));
export const PersonNote = notKey(field(300));
export const PersonRevision = z.string().regex(/^[0-9a-f]{16}$/);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const PersonSource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("task"),
    sessionId: z.string().regex(ULID_PATTERN),
    title: z.string().max(200).nullable(),
  }),
  z.strictObject({ kind: z.literal("user") }),
]);
export type PersonSource = z.infer<typeof PersonSource>;
// Someone the user reaches through dot: who, which app, the handle there, and when last.
export const Person = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
  name: z.string().max(100),
  app: z.string().max(40),
  handle: z.string().max(200).nullable(),
  note: z.string().max(300).nullable(),
  lastAt: Day.nullable(),
  source: PersonSource,
  revision: PersonRevision,
});
export type Person = z.infer<typeof Person>;
export const PeopleReply = z.strictObject({ people: z.array(Person).max(PEOPLE_MAX) });
export type PeopleReply = z.infer<typeof PeopleReply>;
export const AddPersonRequest = z.strictObject({
  name: PersonName,
  app: PersonApp,
  handle: PersonHandle.optional(),
  note: PersonNote.optional(),
  // Undo of a delete puts back when dot last reached them and the task that taught it.
  lastAt: Day.optional(),
  sessionId: z.string().regex(ULID_PATTERN).optional(),
});
export type AddPersonRequest = z.infer<typeof AddPersonRequest>;
export const EditPersonRequest = z
  .strictObject({
    revision: PersonRevision,
    name: PersonName.optional(),
    app: PersonApp.optional(),
    handle: PersonHandle.nullable().optional(),
    note: PersonNote.nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined || v.app !== undefined || v.handle !== undefined || v.note !== undefined,
    "nothing to change",
  );
export type EditPersonRequest = z.infer<typeof EditPersonRequest>;
export const PersonChangeReply = z.strictObject({ person: Person.optional() });
export type PersonChangeReply = z.infer<typeof PersonChangeReply>;
