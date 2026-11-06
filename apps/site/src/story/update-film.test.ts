import { describe, expect, it } from "vitest";
import { updateFilm } from "./content.ts";

const page = `<a data-film>The film</a>
<!-- update-film --><a data-film="update">What's new</a><!-- /update-film -->
<p>More</p>`;

describe("the update video's link", () => {
  it("goes when the build has no such file", () => {
    const html = updateFilm(page, false);
    expect(html).not.toContain("update");
    expect(html).toContain("The film");
    expect(html).toContain("More");
  });

  it("stays when it has", () => {
    expect(updateFilm(page, true)).toContain('data-film="update"');
  });
});
