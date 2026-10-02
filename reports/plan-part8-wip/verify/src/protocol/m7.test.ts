import { describe, expect, it } from "vitest";
import { LeaseReply, LeaseRequest, DownloadEntry } from "./browserd.ts";
import { DownloadQuarantined, ScreenSwitch, ControlChange } from "./events-m7.ts";
import { safeFileName } from "./file-name.ts";
import { QuarantineItem } from "./quarantine.ts";
import { SwitchScreenInput } from "./screens.ts";
import { isSecretField } from "./secret-field.ts";
import { redactUrl, urlHost } from "./url-redact.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const base = { v: 1, id: ID, seq: 0, t: 0, agent: "main" } as const;

describe("safeFileName", () => {
  it("shows a bidi-override name as written, never as it would render", () => {
    expect(safeFileName("invoice\u{202e}fdp.exe")).toBe("invoicefdp.exe");
    expect(safeFileName("a\u{2066}b\u{2069}c\u{200b}d\u{feff}.txt")).toBe("abcd.txt");
  });

  it("keeps one path component and no hidden or dot names", () => {
    expect(safeFileName("../../.bashrc")).toBe("_.._.bashrc");
    expect(safeFileName("/etc/passwd")).toBe("_etc_passwd");
    expect(safeFileName("..")).toBe("download");
    expect(safeFileName(" .profile ")).toBe("profile");
    expect(safeFileName("a\\b:c*d?e\"f<g>h|i")).toBe("a_b_c_d_e_f_g_h_i");
    expect(safeFileName("nul\u0000byte\n.txt")).toBe("nulbyte.txt");
    expect(safeFileName("", "file")).toBe("file");
    expect(safeFileName("\u{202e}\u{200b}")).toBe("download");
  });

  it("cuts long names to 120 code points and keeps a short extension", () => {
    const long = `${"r".repeat(200)}.tar.gz`;
    const cut = safeFileName(long);
    expect([...cut].length).toBe(120);
    expect(cut.endsWith("….gz")).toBe(true);
    expect([...safeFileName("😀".repeat(150))].length).toBe(120);
    const oddExt = `${"x".repeat(130)}.${"y".repeat(30)}`;
    expect(safeFileName(oddExt).endsWith("…")).toBe(true);
  });
});

describe("redactUrl", () => {
  it("drops fragments and credentials, and hides token-shaped parameters", () => {
    expect(
      redactUrl("https://user:pw@app.example/cb?code=4/0AbCd&state=xyz&lang=en#access_token=SECRET"),
    ).toBe("https://app.example/cb?code=…&state=xyz&lang=en");
    expect(redactUrl("https://x.example/a?Session_Id=1&KEY=2&X-Amz-Signature=3")).toBe(
      "https://x.example/a?Session_Id=…&KEY=…&X-Amz-Signature=…",
    );
  });

  it("hides JWTs and long opaque values wherever they sit", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    expect(redactUrl(`https://x.example/magic/${jwt}?next=/home`)).toBe(
      "https://x.example/magic/…?next=%2Fhome",
    );
    expect(redactUrl(`https://x.example/r?v=${"A".repeat(48)}`)).toBe("https://x.example/r?v=…");
    expect(redactUrl("https://x.example/items/12345?page=2")).toBe(
      "https://x.example/items/12345?page=2",
    );
  });

  it("reports only the scheme of anything that is not a web URL", () => {
    expect(redactUrl("javascript:alert(document.cookie)")).toBe("javascript:");
    expect(redactUrl("chrome://settings/cookies")).toBe("chrome:");
    expect(redactUrl("not a url")).toBe("");
    expect(urlHost("https://dl.example.com/x.sh?sig=1")).toBe("dl.example.com");
    expect(urlHost("file:///etc/passwd")).toBe("");
  });
});

describe("isSecretField", () => {
  it("knows password inputs and credential autocomplete tokens", () => {
    expect(isSecretField(["id", "p", "type", "password"])).toBe(true);
    expect(isSecretField(["type", " PASSWORD "])).toBe(true);
    expect(isSecretField(["autocomplete", "section-a one-time-code"])).toBe(true);
    expect(isSecretField(["autocomplete", "cc-number"])).toBe(true);
    expect(isSecretField(["type", "text", "autocomplete", "username"])).toBe(false);
    expect(isSecretField(["type", "email"])).toBe(false);
    expect(isSecretField([])).toBe(false);
  });
});

describe("M7 wire and events", () => {
  it("switch_screen takes one of the two screens", () => {
    expect(SwitchScreenInput.parse({ screen: "browser" }).screen).toBe("browser");
    expect(SwitchScreenInput.safeParse({ screen: "terminal" }).success).toBe(false);
  });

  it("parses the screen, download and control events", () => {
    ScreenSwitch.parse({
      ...base,
      type: "screen.switch",
      data: { screen: "browser", cellId: ID, geometry: { w: 2560, h: 1600, scale: 2 }, by: "agent" },
    });
    DownloadQuarantined.parse({
      ...base,
      type: "download.quarantined",
      data: { downloadId: ID, name: "a.sh", bytes: 3, sha256: "a".repeat(64), kind: "program", source: "dl.example.com" },
    });
    expect(ControlChange.parse({ ...base, type: "control.change", data: { holder: "user", reason: "handoff_request", screen: "browser" } }).data.screen).toBe("browser");
    expect(
      ScreenSwitch.safeParse({
        ...base,
        type: "screen.switch",
        data: { screen: "browser", cellId: ID, geometry: { w: 2560, h: 1600, scale: 3 }, by: "agent" },
      }).success,
    ).toBe(false);
  });

  it("validates leases, downloads and quarantine items", () => {
    expect(LeaseRequest.safeParse({ holder: "agent", leaseId: ID }).success).toBe(true);
    expect(LeaseRequest.safeParse({ holder: "nobody", leaseId: ID }).success).toBe(false);
    LeaseReply.parse({ holder: "agent", leaseId: ID, reloaded: 1, selectionsCleared: true });
    DownloadEntry.parse({ guid: "4e4c5b8c-c46a-424a-9c71-cc0f63d2ed92", seq: 1, name: "x", url: "", bytes: 0, state: "done" });
    expect(
      QuarantineItem.safeParse({ id: ID, cellId: ID, name: "x", bytes: 1, sha256: "z".repeat(64), kind: "other", source: "", createdAt: "", state: "held" }).success,
    ).toBe(false);
  });
});
