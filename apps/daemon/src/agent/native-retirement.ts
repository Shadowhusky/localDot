// Cleanup deadlines stop admission promptly. Actual cleanup may finish later; only its
// successful completion, after the driver exits, is evidence for computer recovery.
export class NativeRetirement {
  readonly #records = new Map<
    string,
    { active: boolean; pending: number; failed: boolean; notified: boolean }
  >();
  constructor(private readonly retired: (id: string) => void = () => {}) {}
  begin(id: string): void {
    const before = this.#records.get(id);
    if (before?.active || before?.pending || before?.failed)
      throw new Error("native cleanup is pending");
    this.#records.set(id, { active: true, pending: 0, failed: false, notified: false });
  }
  track(id: string, work: Promise<void>): Promise<void> {
    const record = this.#records.get(id);
    if (!record) throw new Error("unknown native task");
    record.pending++;
    return work.then(
      () => {
        record.pending--;
        this.#publish(id, record);
      },
      (error) => {
        record.pending--;
        record.failed = true;
        throw error;
      },
    );
  }
  end(id: string): void {
    const record = this.#records.get(id);
    if (!record) return;
    record.active = false;
    this.#publish(id, record);
  }
  confirmed(id: string): boolean {
    const record = this.#records.get(id);
    return !!record && !record.active && record.pending === 0 && !record.failed;
  }
  #publish(id: string, record: { notified: boolean; failed: boolean }): void {
    if (record.notified || !this.confirmed(id)) return;
    try {
      this.retired(id);
      record.notified = true;
    } catch (error) {
      record.failed = true;
      throw error;
    }
  }
}
