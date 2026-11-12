import type { PersonaId } from "@localdot/protocol";
import { tr } from "../i18n/index.ts";

// A dot's name and what it is for, in the language on show. The protocol's own words are English,
// read by dot and the daemon; these are what the reader sees.
export function personaName(id: PersonaId): string {
  switch (id) {
    case "everyday":
      return tr("Everyday");
    case "coder":
      return tr("Coder");
    case "video":
      return tr("Video editor");
    case "finance":
      return tr("Finance");
    case "research":
      return tr("Researcher");
    case "design":
      return tr("Designer");
  }
}

export function personaBlurb(id: PersonaId): string {
  switch (id) {
    case "everyday":
      return tr("Errands, documents, the web and a bit of everything");
    case "coder":
      return tr("Builds, fixes and ships software");
    case "video":
      return tr("Cuts, captions and exports video");
    case "finance":
      return tr("Spreadsheets, models and money admin");
    case "research":
      return tr("Deep research with sources");
    case "design":
      return tr("Images, slides and visual design");
  }
}
