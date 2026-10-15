import { describe, expect, it } from "vitest";
import { jevApprovalRequest, jevLocalChangeRequest } from "./judges.ts";

const purpose = { request: ["Post the release notes in #general"], plan: [] };
// Synthetic: a key in a common format and a stand-in shaped like the computer's.
const KEY = `ghp_${"a".repeat(36)}`;
const STAND_IN = "ld_github_0123456789abcdefghijkl_abcdef";
const PAGE = "https://chat.example/c/general?session=s3ss10n-c4n4ry";

describe("what Jev reads of an action", () => {
  it("carries no typed text, key or address parameters, and keeps what it does and where", () => {
    const typed = `Release notes, and my token ${KEY}\n`;
    const element = { role: "textbox", name: "Message #general", url: PAGE };
    const request = JSON.stringify(
      jevApprovalRequest(purpose, {
        tool: "computer",
        operation: "type",
        actionClass: "post",
        input: {
          toolInput: { action: "type", text: typed },
          action: { verb: "type", text: typed },
        },
        target: { target: { ...element, source: "dom", point: { x: 1, y: 2 } }, window: 7 },
        facts: { operation: "type", newline: true, target: { ...element, source: "dom" } },
      }),
    );
    for (const hidden of ["Release notes", KEY, "s3ss10n-c4n4ry"])
      expect(request).not.toContain(hidden);
    expect(request).toContain('"characters":');
    expect(request).toContain("Message #general");
    expect(request).toContain("https://chat.example/c/general");
    expect(request).toContain('"newline":true');
  });

  it("keeps a command and an app's recipients, with keys and outbound text taken out", () => {
    const command = `curl -H "Authorization: token ${KEY}" -H "X-Key: ${STAND_IN}" https://api.example/v1/notes`;
    const shell = JSON.stringify(
      jevApprovalRequest(purpose, {
        tool: "shell",
        operation: "shell",
        actionClass: "send",
        input: { command },
        facts: { operation: "shell", command },
      }),
    );
    expect(shell).toContain("curl -H");
    expect(shell).toContain("https://api.example/v1/notes");
    expect(shell).not.toContain(KEY);
    expect(shell).not.toContain(STAND_IN);
    const app = JSON.stringify(
      jevApprovalRequest(purpose, {
        tool: "mail__send_email",
        operation: "connector",
        actionClass: "send",
        input: { to: "bob@example.com", subject: "Quarterly numbers", body: "Private body text" },
        facts: {
          operation: "connector",
          connector: { app: "Mail", tool: "send_email", exposed: "mail__send_email" },
        },
      }),
    );
    expect(app).toContain("bob@example.com");
    expect(app).toContain("send_email");
    expect(app).not.toContain("Quarterly numbers");
    expect(app).not.toContain("Private body text");
  });

  it("keeps a local change's paths for the local-change question, keys masked", () => {
    const command = `cd /config/promo && rm -rf frames_prev && echo ${KEY} > .token`;
    const body = JSON.stringify(
      jevLocalChangeRequest(purpose, {
        tool: "shell",
        operation: "shell",
        actionClass: "delete",
        local: true,
        input: { command },
        facts: { operation: "shell", command },
      }),
    );
    expect(body).toContain("cd /config/promo && rm -rf frames_prev");
    expect(body).not.toContain(KEY);
  });
});
