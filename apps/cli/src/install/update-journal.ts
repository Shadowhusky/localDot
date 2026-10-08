import { UpdateJournal } from "../../../../packages/protocol/src/install-update.ts";
import { privateRecordStore } from "./private-record.ts";

export function updateJournalStore(directory: string) {
  return privateRecordStore(directory, "update.json", UpdateJournal);
}
