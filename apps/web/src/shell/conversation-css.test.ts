import { expect, it } from "vitest";
import { readSource } from "../testing/read-source.ts";
import { cssBlocks } from "../testing/tokens.ts";

const blocks = cssBlocks(await readSource(new URL("./conversation.css", import.meta.url)));
const body = (selector: string) => blocks.find((block) => block.selector === selector)?.body ?? "";

it("floats a key taken out of a phone's message over the thread, not inside the one-line field", () => {
  expect(body('.composer-card[data-layout="pill"] > .composer-key')).toMatch(
    /position:\s*absolute;/,
  );
});

it("keeps a phone's field corners when it grows past one line", () => {
  expect(body('.composer-card[data-layout="pill"]')).not.toMatch(
    /border-radius:\s*var\(--radius-full\)/,
  );
});
