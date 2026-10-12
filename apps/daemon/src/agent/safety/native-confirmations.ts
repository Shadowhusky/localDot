import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { PrivateRecords } from "./private-records.ts";

const Confirmation = z.strictObject({
  cellId: z.string().regex(ULID_PATTERN),
  sessionId: z.string().regex(ULID_PATTERN),
  revision: z.number().int().positive(),
  confirmedAt: z.string().datetime(),
  source: z.literal("user-confirmed-native-exit"),
});
export class NativeConfirmations extends PrivateRecords<z.infer<typeof Confirmation>> {
  constructor(home: string) {
    super(home, "native-confirmations", (raw, id) => {
      const record = Confirmation.parse(raw);
      if (record.cellId !== id) throw new Error("confirmation owner mismatch");
      return record;
    });
  }
}
