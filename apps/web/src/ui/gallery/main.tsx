import "../stack.css";
import "../../theme.css";
import "../../app.css";
import "./shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AtomsPage } from "./AtomsPage.tsx";
import { FieldsPage } from "./FieldsPage.tsx";

const PAGES = {
  atoms: {
    name: "Atoms",
    title: "Actions and atoms",
    note: "Every state of the kit's buttons, tooltips, keys, badges and glyphs.",
    Page: AtomsPage,
  },
  fields: {
    name: "Fields",
    title: "Fields and choices",
    note: "Text fields, choices, segmented controls, selects and searchable lists, in every state.",
    Page: FieldsPage,
  },
};

// A stand-in for the T01 gallery until it lands here, loading the same legacy styles it does.
const query = new URLSearchParams(location.search);
const midnight = query.get("appearance") === "midnight";
const pageName = query.get("page") === "fields" ? "fields" : "atoms";
const { title, note, Page } = PAGES[pageName];
if (midnight) document.documentElement.dataset.appearance = "midnight";

function link(page: keyof typeof PAGES, dark: boolean): string {
  const params = new URLSearchParams();
  if (page !== "atoms") params.set("page", page);
  if (dark) params.set("appearance", "midnight");
  return `?${params}`;
}

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <main className="atoms-shell">
      <header className="atoms-head">
        <div>
          <h1>{title}</h1>
          <p>{note}</p>
        </div>
        <div className="atoms-navs">
          <nav className="atoms-appearance" aria-label="Pages">
            {(Object.keys(PAGES) as (keyof typeof PAGES)[]).map((page) => (
              <a
                key={page}
                href={link(page, midnight)}
                aria-current={page === pageName ? "page" : undefined}
              >
                {PAGES[page].name}
              </a>
            ))}
          </nav>
          <nav className="atoms-appearance" aria-label="Appearance">
            <a href={link(pageName, false)} aria-current={midnight ? undefined : "page"}>
              Graphite
            </a>
            <a href={link(pageName, true)} aria-current={midnight ? "page" : undefined}>
              Midnight
            </a>
          </nav>
        </div>
      </header>
      <Page />
    </main>
  </StrictMode>,
);
