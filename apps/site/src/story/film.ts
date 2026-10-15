import { LANG } from "../i18n.ts";
import { setSite } from "../state.ts";

// The film opens in a sheet over the page. Its video is made only when asked for, so the page never
// loads it, and goes when the sheet closes; the page rests and stays put behind it.
// The film in the page's language.
const CUT = LANG === "zh" ? "-zh" : "";
const SOURCES = [
  { src: `/film/localdot-film${CUT}-720.mp4`, media: "(max-width: 900px)" },
  { src: `/film/localdot-film${CUT}.mp4`, media: "" },
];

export function wireFilm(sheet: HTMLDialogElement): void {
  const frame = sheet.querySelector<HTMLElement>(".film-frame");
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-film]")) {
    link.href = `/film/localdot-film${CUT}.mp4`;
    link.addEventListener("click", (event) => {
      // A click meant for a new tab or a download opens the file itself.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      const video = document.createElement("video");
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.poster = `/film/poster${CUT}.webp`;
      for (const { src, media } of SOURCES) {
        const source = document.createElement("source");
        source.src = src;
        source.type = "video/mp4";
        if (media) source.media = media;
        video.append(source);
      }
      frame?.replaceChildren(video);
      document.documentElement.style.overflow = "hidden";
      setSite({ film: true });
      sheet.showModal();
    });
  }
  sheet.querySelector(".film-close")?.addEventListener("click", () => sheet.close());
  // A press on the dimmed page around the film closes it.
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) sheet.close();
  });
  sheet.addEventListener("close", () => {
    frame?.replaceChildren();
    document.documentElement.style.overflow = "";
    setSite({ film: false });
  });
}
