import { describe, expect, it } from "vitest";
import { addTaskSecret, REDACTED, type Redactor, redactor } from "./redact.ts";

// Synthetic credentials in the formats a user's files or command output can hold; none is real.
const KEYS = [
  `ghp_${"a".repeat(36)}`,
  `gho_${"B".repeat(36)}`,
  `github_pat_${"C".repeat(22)}_${"d".repeat(59)}`,
  `AKIA${"E".repeat(16)}`,
  `xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"f".repeat(24)}`,
  `sk_live_${"g".repeat(24)}`,
  `rk_live_${"h".repeat(99)}`,
  `glpat-${"i".repeat(20)}`,
  `sk-proj-${"j".repeat(156)}`,
  `AQ.${"k".repeat(64)}`,
];
const PEM = [
  ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" "),
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "k".repeat(64),
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

// Longer than what a stream holds back, so its earlier parts go out before the rest arrives.
const PAD = "x".repeat(200);

function streamed(r: Redactor, text: string, size: number): string {
  const s = r.stream?.();
  if (!s) throw new Error("missing redaction stream");
  const out = [];
  for (let at = 0; at < text.length; at += size)
    out.push(...s.push({ stream: "stdout", chunk: text.slice(at, at + size) }));
  out.push(...s.finish());
  return out.map((c) => c.chunk).join("");
}

describe("stream redaction", () => {
  it("retains ordinary stdout/stderr attribution while joining secret fragments safely", () => {
    const secret = "abcdefghijklmno";
    const r = redactor([secret]);
    const stream = r.stream?.();
    if (!stream) throw new Error("missing redaction stream");
    const out = [
      ...stream.push({ stream: "stdout", chunk: "before abcde" }),
      ...stream.push({ stream: "stderr", chunk: "fghijklmno after" }),
      ...stream.finish(),
    ];
    expect(out).toEqual([
      { stream: "stdout", chunk: "before [redacted]" },
      { stream: "stderr", chunk: " after" },
    ]);
  });
  it("handles overlapping secrets at the retained boundary without exposing either prefix", () => {
    const first = "abcdefghijkl",
      second = "ijklmnop";
    const r = redactor([first, second]);
    const stream = r.stream?.();
    if (!stream) throw new Error("missing redaction stream");
    const out = [
      ...stream.push({ stream: "stdout", chunk: `abcdefghijklmnop${"x".repeat(46)}` }),
      ...stream.finish(),
    ];
    expect(out.map((c) => c.chunk).join("")).toBe(`[redacted]${"x".repeat(46)}`);
  });
  it("streams a run too long to become a key without waiting for its end", () => {
    const s = redactor([]).stream?.();
    if (!s) throw new Error("missing redaction stream");
    const out = s.push({ stream: "stdout", chunk: "A".repeat(100) });
    expect(out.map((c) => c.chunk).join("")).toBe("A".repeat(54));
  });
  it("defers incomplete prefixes and redacts unknown surrogate tokens", () => {
    const r = redactor([]),
      s = r.stream?.();
    if (!s) throw new Error("missing redaction stream");
    expect(s.push({ stream: "stdout", chunk: "ld_llm_0123456789abcdefghijkl_" })).toEqual([]);
    expect(
      [...s.push({ stream: "stdout", chunk: "abcdef" }), ...s.finish()]
        .map((c) => c.chunk)
        .join(""),
    ).toBe("[redacted]");
  });
});

describe("credential formats", () => {
  it.each(KEYS)("masks %s wherever it sits", (key) => {
    const r = redactor([]);
    expect(r(`export TOKEN=${key}\n`)).toBe(`export TOKEN=${REDACTED}\n`);
    expect(r(`Authorization: token ${key}, ok`)).toBe(`Authorization: token ${REDACTED}, ok`);
    expect(streamed(r, `${PAD} ${key} ${PAD}`, 3)).toBe(`${PAD} ${REDACTED} ${PAD}`);
  });
  it("masks a private key block whole, and one cut short up to the end", () => {
    const r = redactor([]);
    expect(r(`key:\n${PEM}\nnext line`)).toBe(`key:\n${REDACTED}\nnext line`);
    expect(r(`"private_key": "${PEM.replaceAll("\n", "\\n")}\\n",`)).toBe(
      `"private_key": "${REDACTED}\\n",`,
    );
    expect(r(`$ head -c 90 id_ed25519\n${PEM.slice(0, 90)}`)).toBe(
      `$ head -c 90 id_ed25519\n${REDACTED}`,
    );
    expect(streamed(r, `${PAD}\n${PEM}\n${PAD}`, 7)).toBe(`${PAD}\n${REDACTED}\n${PAD}`);
  });
  it("ends a private key cut short where its lines end, and holds no more than a key back", () => {
    const r = redactor([]);
    expect(r(`${PEM.slice(0, 90)}\n$ ls\nnotes.txt "done".`)).toBe(
      `${REDACTED}$ ls\nnotes.txt "done".`,
    );
    const marker = ["-----BEGIN", "PRIVATE KEY----- marks one; see the guide."].join(" ");
    expect(r(marker)).toBe(`${REDACTED}; see the guide.`);
    const s = r.stream?.();
    if (!s) throw new Error("missing redaction stream");
    let out = s.push({ stream: "stdout", chunk: `${PEM.slice(0, 40)}\n` }).length;
    for (let i = 0; i < 1000; i++)
      out += s.push({ stream: "stdout", chunk: `${"A".repeat(63)}\n` }).length;
    expect(out).toBeGreaterThan(0);
  });
  it("leaves ordinary text alone", () => {
    const r = redactor([]);
    for (const text of [
      "ghp_ and github_pat_ are GitHub token prefixes; AKIA starts an AWS key ID.",
      "xoxo-hugs, sk_test_ keys and glpat-short",
      `commit ${"0123456789abcdef".repeat(2)}01234567`,
      "550e8400-e29b-41d4-a716-446655440000",
      "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----",
      "Keep your private key safe; never paste a PRIVATE KEY into chat.",
    ])
      expect(r(text)).toBe(text);
  });
});

describe("a task's delivered secrets", () => {
  it("masks a password or code from its delivery on, in that task's redactors only", () => {
    const task = {},
      r = redactor([], task);
    expect(r("pw hunter2hunter2")).toBe("pw hunter2hunter2");
    addTaskSecret(task, "hunter2hunter2");
    addTaskSecret(task, "482913");
    expect(r("pw hunter2hunter2, code 482913.")).toBe(`pw ${REDACTED}, code ${REDACTED}.`);
    expect(streamed(r, `${PAD} 482913 hunter2hunter2! ${PAD}`, 2)).toBe(
      `${PAD} ${REDACTED} ${REDACTED}! ${PAD}`,
    );
    expect(redactor([])("hunter2hunter2 482913")).toBe("hunter2hunter2 482913");
    expect(redactor([], {})("hunter2hunter2 482913")).toBe("hunter2hunter2 482913");
  });
  it("masks a short code only where it stands on its own", () => {
    const task = {};
    addTaskSecret(task, "482913");
    const r = redactor([], task);
    expect(r("order 14829130, id 482913x, 验证码482913")).toBe(
      `order 14829130, id 482913x, 验证码${REDACTED}`,
    );
    expect(streamed(r, `${PAD} 4829131 then (482913) ${PAD}`, 1)).toBe(
      `${PAD} 4829131 then (${REDACTED}) ${PAD}`,
    );
  });
  it("ignores values too short to mask, and ones the mask itself contains", () => {
    const task = {};
    for (const value of ["", "123", "acted", "redacted"]) addTaskSecret(task, value);
    const r = redactor([], task);
    expect(r("123 acted redacted")).toBe("123 acted redacted");
    expect(r(r(`x ${REDACTED}`))).toBe(`x ${REDACTED}`);
  });
});
