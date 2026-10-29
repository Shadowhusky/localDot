import { readdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { redactor } from "../agent/redact.ts";
import { displayLogLine } from "../daemon-log.ts";
import { readHead } from "./files.ts";

function jsonAt(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readHead(file) ?? "");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// Secrets this installation keeps on disk, masked wherever they appear: its install token, its
// remote access keys and its computers' tokens.
export function homeSecrets(home: string): string[] {
  const remote = jsonAt(join(home, "remote-access.json"));
  const found: unknown[] = [
    readHead(join(home, "daemon-token"))?.trim(),
    remote?.owner,
    remote?.access,
  ];
  try {
    for (const id of readdirSync(join(home, "cells"))) {
      const tokens = jsonAt(join(home, "cells", id, "cell.json"))?.tokens;
      if (tokens && typeof tokens === "object") found.push(...Object.values(tokens));
    }
  } catch {}
  return found.filter((value): value is string => typeof value === "string" && value.length >= 16);
}

const PRIVATE_V4 =
  /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const RULES: readonly (readonly [RegExp, string | ((match: string) => string)])[] = [
  // Sign-in, remote access and share links keep their address, never their keys.
  [/([#?&](?:remote|key|access|secret|passphrase|password)=)[^\s"'<>&]*/gi, "$1[redacted]"],
  [
    /(["']?(?:passphrase|secret|credential|cookie|session[_-]?token|private[_-]?key)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
    "$1[redacted]",
  ],
  // A relay address names this computer's remote access, and a tailnet name its owner.
  [/\b[0-9a-f]{32}--dot\.[a-z0-9.-]+/gi, "[relay]"],
  [/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/gi, "[tailnet]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  [/\/(Users|home)\/[^/\s"'<>:]+/g, "/$1/[user]"],
  [/\b([A-Za-z]:\\Users\\)[^\\\s"'<>]+/g, "$1[user]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (PRIVATE_V4.test(ip) ? ip : "[ip]")],
];

function words(names: readonly (string | undefined)[]): RegExp | undefined {
  const kept = [...new Set(names.filter((name): name is string => !!name && name.length >= 5))];
  return kept.length
    ? new RegExp(
        `\\b(?:${kept.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
        "gi",
      )
    : undefined;
}

export type ReportRedactor = (text: string) => string;

// What every text in a report goes through: the task redactor with this installation's secrets,
// the log sanitizer, then links' keys, addresses, emails and the user's and computer's names.
export function reportRedactor(home: string): ReportRedactor {
  const known = redactor(homeSecrets(home));
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {}
  const host = hostname().replace(/\.local$/i, "");
  const people = words([user]);
  const machines = words([host, host.split(".")[0]]);
  const line = (raw: string) => {
    let out = displayLogLine(known(raw));
    for (const [pattern, replacement] of RULES)
      out =
        typeof replacement === "string"
          ? out.replace(pattern, replacement)
          : out.replace(pattern, replacement);
    if (machines) out = out.replace(machines, "[host]");
    return people ? out.replace(people, "[user]") : out;
  };
  return (text) => text.replace(/\r\n?/g, "\n").split("\n").map(line).join("\n");
}
