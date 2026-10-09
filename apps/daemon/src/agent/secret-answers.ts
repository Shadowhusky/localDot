// The user's secret answers to one question, on their way to the fields they are typed into.
// Values live only in a private field, so serializing or inspecting the answer shows none of them.
export class SecretAnswers {
  readonly #values: Map<string, string>;

  constructor(values: Iterable<readonly [string, string]>) {
    this.#values = new Map(values);
  }

  get size(): number {
    return this.#values.size;
  }

  // Hands a value over once: it is gone from here afterwards.
  take(id: string): string | undefined {
    const value = this.#values.get(id);
    this.#values.delete(id);
    return value;
  }

  clear(): void {
    this.#values.clear();
  }

  toJSON(): Record<string, never> {
    return {};
  }
}
