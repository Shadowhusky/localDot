import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CdpPipe } from "./cdp.ts";

function pipe() {
  const out = new PassThrough();
  const input = new PassThrough();
  const sent: string[] = [];
  out.on("data", (data: Buffer) => sent.push(data.toString()));
  return { cdp: new CdpPipe(out, input), input, sent };
}

describe("CdpPipe", () => {
  it("sends NUL-terminated calls and matches replies split across reads", async () => {
    const { cdp, input, sent } = pipe();
    const reply = cdp.send("Runtime.evaluate", { expression: "1" }, "S");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([
      '{"id":1,"method":"Runtime.evaluate","params":{"expression":"1"},"sessionId":"S"}\0',
    ]);
    const record = Buffer.from('{"id":1,"result":{"value":"é"}}\0');
    input.write(record.subarray(0, 25));
    input.write(record.subarray(25));
    expect(await reply).toEqual({ value: "é" });
  });

  it("delivers events, several to a read, to their listeners", async () => {
    const { cdp, input } = pipe();
    const seen = vi.fn();
    cdp.on("Runtime.bindingCalled", seen);
    input.write(
      '{"method":"Runtime.bindingCalled","params":{"payload":"a"},"sessionId":"S"}\0{"method":"Runtime.bindingCalled","params":{"payload":"b"},"sessionId":"S"}\0',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen.mock.calls).toEqual([
      [{ payload: "a" }, "S"],
      [{ payload: "b" }, "S"],
    ]);
  });

  it("rejects a call the browser refuses, and every call once the pipe closes", async () => {
    const { cdp, input } = pipe();
    const refused = cdp.send("Page.navigate");
    input.write('{"id":1,"error":{"message":"no"}}\0');
    await expect(refused).rejects.toThrow("no");
    const waiting = cdp.send("Page.enable");
    const closed = vi.fn();
    cdp.onClose(closed);
    input.end();
    await expect(waiting).rejects.toThrow("closed its pipe");
    expect(closed).toHaveBeenCalled();
    await expect(cdp.send("Page.enable")).rejects.toThrow("closed its pipe");
  });

  it("closes on an unreadable or endless record", async () => {
    const garbled = pipe();
    const first = garbled.cdp.send("Page.enable");
    garbled.input.write("{not json\0");
    await expect(first).rejects.toThrow("unreadable");
    const endless = pipe();
    const second = endless.cdp.send("Page.enable");
    const block = Buffer.alloc(8 * 1024 * 1024, 0x61);
    for (let n = 0; n < 9; n++) endless.input.write(block);
    await expect(second).rejects.toThrow("too much");
  });
});
