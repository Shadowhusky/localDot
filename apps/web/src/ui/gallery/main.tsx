import "@localdot/protocol/csp";
import "../stack.css";
import "../../theme.css";
import "../../app.css";
import "./shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AtomsPage } from "./AtomsPage.tsx";
import { OverlaysPage } from "./OverlaysPage.tsx";

const PAGES = {
  atoms: {
    nav: "Atoms",
    title: "Actions and atoms",
    about: "Every state of the kit's buttons, tooltips, keys, badges and glyphs.",
    Page: AtomsPage,
  },
  overlays: {
    nav: "Overlays",
    title: "Overlays",
    about:
      "Sheets, menus, popovers and dialogs, and how each one opens, closes and keeps your work.",
    Page: OverlaysPage,
  },
};

// A stand-in for the T01 gallery until it lands here, loading the same legacy styles it does.
const params = new URLSearchParams(location.search);
const midnight = params.get("appearance") === "midnight";
const id = params.get("page") === "overlays" ? "overlays" : "atoms";
const { title, about, Page } = PAGES[id];
if (midnight) document.documentElement.dataset.appearance = "midnight";

function link(page: keyof typeof PAGES, appearance: boolean): string {
  const query = new URLSearchParams();
  if (page !== "atoms") query.set("page", page);
  if (appearance) query.set("appearance", "midnight");
  return `?${query}`;
}

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <main className="atoms-shell">
      <header className="atoms-head">
        <div>
          <h1>{title}</h1>
          <p>{about}</p>
        </div>
        <div className="atoms-switches">
          <nav className="atoms-appearance" aria-label="Page">
            {(Object.keys(PAGES) as (keyof typeof PAGES)[]).map((page) => (
              <a
                key={page}
                href={link(page, midnight)}
                aria-current={page === id ? "page" : undefined}
              >
                {PAGES[page].nav}
              </a>
            ))}
          </nav>
          <nav className="atoms-appearance" aria-label="Appearance">
            <a href={link(id, false)} aria-current={midnight ? undefined : "page"}>
              Graphite
            </a>
            <a href={link(id, true)} aria-current={midnight ? "page" : undefined}>
              Midnight
            </a>
          </nav>
        </div>
      </header>
      <Page />
    </main>
  </StrictMode>,
);
