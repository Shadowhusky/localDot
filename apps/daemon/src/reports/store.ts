import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  INSTALL_ID,
  REPORT_ID,
  REPORT_TOKEN,
  type ReportsOverview,
} from "../../../../packages/protocol/src/reports.ts";

const SentRecord = z.strictObject({
  id: z.string().regex(REPORT_ID),
  token: z.string().regex(REPORT_TOKEN),
  sentAt: z.iso.datetime(),
  summary: z.string().max(200),
});
export type SentRecord = z.infer<typeof SentRecord>;
const Saved = z.strictObject({
  installId: z.string().regex(INSTALL_ID),
  enabled: z.boolean(),
  sent: z.array(SentRecord).max(50),
});
type Saved = z.infer<typeof Saved>;

// <home>/reports.json: whether this localDot may send problem reports, its anonymous installation
// id, and the reports it sent with the tokens that delete them. Read at every use: the daemon and
// the CLI both write it.
export class ReportStore {
  readonly #file: string;
  constructor(home: string) {
    this.#file = join(home, "reports.json");
  }
  read(): Saved {
    const fresh = { installId: randomBytes(16).toString("hex"), sent: [] };
    if (!existsSync(this.#file)) return { ...fresh, enabled: true };
    try {
      return Saved.parse(JSON.parse(readFileSync(this.#file, "utf8")));
    } catch {
      // A choice that can't be read counts as off until the user chooses again.
      return { ...fresh, enabled: false };
    }
  }
  overview(): ReportsOverview {
    const { enabled, sent } = this.read();
    return { enabled, sent: sent.map(({ token: _token, ...shown }) => shown) };
  }
  // Kept from the first report on, so reports from one installation can be told apart.
  installId(): string {
    const saved = this.read();
    if (!existsSync(this.#file)) this.#write(saved);
    return saved.installId;
  }
  setEnabled(enabled: boolean): ReportsOverview {
    this.#write({ ...this.read(), enabled });
    return this.overview();
  }
  find(id: string): SentRecord | undefined {
    return this.read().sent.find((sent) => sent.id === id);
  }
  record(sent: SentRecord): void {
    const saved = this.read();
    this.#write({ ...saved, sent: [sent, ...saved.sent].slice(0, 50) });
  }
  forget(id: string): void {
    const saved = this.read();
    this.#write({ ...saved, sent: saved.sent.filter((sent) => sent.id !== id) });
  }
  #write(saved: Saved): void {
    const temp = `${this.#file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(Saved.parse(saved))}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, this.#file);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
