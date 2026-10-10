const messages = {
  "storage-read-only":
    "Docker storage is read-only. Check its host disk and restart Docker, then retry. Do not reset Docker or delete its data.",
  "storage-full":
    "Docker ran out of storage. Check both the host disk and Docker's disk allocation, free space, then retry.",
  "permission-denied":
    "Docker could not access required storage. Check your Docker permissions before retrying.",
  "network-unavailable":
    "An image download was interrupted. Check your connection, DNS and proxy settings, then retry; completed layers are kept.",
} as const;
export class SetupFailure extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "SetupFailure";
  }
  get retryable() {
    return this.code === "network-unavailable";
  }
}

// Classify a bounded Docker response; never forward server-controlled text or credentials.
export function classifySetupFailure(value: unknown): SetupFailure | undefined {
  if (typeof value !== "string" || value.length > 64 * 1024) return;
  if (/read-only file system/i.test(value)) return new SetupFailure("storage-read-only");
  if (/no space left on device|disk quota exceeded|not enough space/i.test(value))
    return new SetupFailure("storage-full");
  if (/permission denied|access is denied/i.test(value))
    return new SetupFailure("permission-denied");
  if (
    /temporary failure resolving|could not resolve|connection (?:timed out|reset)|TLS handshake timeout|i\/o timeout/i.test(
      value,
    )
  )
    return new SetupFailure("network-unavailable");
}
