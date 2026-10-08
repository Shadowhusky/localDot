import { useSyncExternalStore } from "react";
import { GALLERY_PAGES } from "./pages.tsx";

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const currentPage = () => decodeURIComponent(location.hash.slice(1));

// Each page renders components from fixture props, one URL per page (#<id>), for the UI harness.
export function Gallery() {
  const id = useSyncExternalStore(subscribe, currentPage);
  const page = GALLERY_PAGES.find((entry) => entry.id === id);
  if (!page)
    return (
      <main className="gallery" data-gallery-page="index">
        <h1>Gallery</h1>
        <ul className="gallery-index">
          {GALLERY_PAGES.map((entry) => (
            <li key={entry.id}>
              <a href={`#${entry.id}`}>{entry.title}</a>
              <span>{entry.about}</span>
            </li>
          ))}
        </ul>
      </main>
    );
  return (
    <main className="gallery" data-gallery-page={page.id}>
      <h1>{page.title}</h1>
      <page.Page />
    </main>
  );
}
