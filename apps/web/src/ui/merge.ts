type Handler = (event: never) => void;

// Event handlers from each set run after the caller's own; every other prop keeps the caller's value.
export function mergeHandlers<T extends object>(props: T, ...sets: Record<string, Handler>[]): T {
  const merged = { ...props } as Record<string, unknown>;
  for (const set of sets) {
    for (const [name, handler] of Object.entries(set)) {
      const prior = merged[name];
      merged[name] =
        typeof prior === "function"
          ? (event: never) => {
              prior(event);
              handler(event);
            }
          : handler;
    }
  }
  return merged as T;
}

export function joinIds(...ids: (string | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}
