import "@localdot/protocol/csp";
import "../stack.css";
import "../../theme.css";
import "../../app.css";
import "./shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AtomsPage } from "./AtomsPage.tsx";
import { FeedbackPage } from "./FeedbackPage.tsx";
import { FieldsPage } from "./FieldsPage.tsx";
import { OverlaysPage } from "./OverlaysPage.tsx";

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
  overlays: {
    name: "Overlays",
    title: "Overlays",
    note: "Sheets, menus, popovers and dialogs, and how each one opens, closes and keeps your work.",
    Page: OverlaysPage,
  },
  feedback: {
    name: "Feedback",
    title: "Feedback",
    note: "Toasts, banners, progress, meters, skeletons and empty states, and how each arrives and leaves.",
    Page: FeedbackPage,
  },
};

// A stand-in for the T01 gallery until it lands here, loading the same legacy styles it does.
const query = new URLSearchParams(location.search);
const APPEARANCES = { graphite: "Graphite", midnight: "Midnight", daylight: "Daylight" } as const;
type Appearance = keyof typeof APPEARANCES;
const appearance: Appearance =
  (Object.keys(APPEARANCES) as Appearance[]).find((name) => name === query.get("appearance")) ??
  "graphite";
const requested = query.get("page");
const pageName: keyof typeof PAGES =
  requested === "fields" || requested === "overlays" || requested === "feedback"
    ? requested
    : "atoms";
const { title, note, Page } = PAGES[pageName];
document.documentElement.dataset.appearance = appearance;

function link(page: keyof typeof PAGES, shown: Appearance): string {
  const params = new URLSearchParams();
  if (page !== "atoms") params.set("page", page);
  if (shown !== "graphite") params.set("appearance", shown);
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
                href={link(page, appearance)}
                aria-current={page === pageName ? "page" : undefined}
              >
                {PAGES[page].name}
              </a>
            ))}
          </nav>
          <nav className="atoms-appearance" aria-label="Appearance">
            {(Object.keys(APPEARANCES) as Appearance[]).map((name) => (
              <a
                key={name}
                href={link(pageName, name)}
                aria-current={name === appearance ? "page" : undefined}
              >
                {APPEARANCES[name]}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <Page />
    </main>
  </StrictMode>,
);
