import { PERSONAS, type PersonaId } from "@localdot/protocol";
import { PROVIDERS } from "@localdot/providers";

// The story's words that come from the app itself, so the site says what the app does.

export const ROLE_ORDER: readonly PersonaId[] = [
  "coder",
  "research",
  "finance",
  "video",
  "design",
  "everyday",
];
// The Dots chapter: its introduction, then one stretch per dot between these, then the line-up.
export const ROLES_FROM = 0.15;
export const ROLES_TO = 0.8;

const SKILL_LABELS: Record<string, string> = {
  "office-files": "Office files",
  "pdf-tools": "PDFs",
  "image-basics": "Images",
  "web-research": "Web research",
  "coding-workflow": "Coding workflow",
  "web-app-preview": "App previews",
  debugging: "Debugging",
  "video-editing": "Video editing",
  captions: "Captions",
  "spreadsheet-models": "Spreadsheet models",
  "financial-analysis": "Financial analysis",
  bookkeeping: "Bookkeeping",
  "report-writing": "Report writing",
  "visual-design": "Visual design",
  slides: "Slides",
};
const BASICS = new Set(PERSONAS.everyday.skills.filter((s) => s !== "web-research"));

// The studio's wash of each dot's colour.
export const WASH: Partial<Record<PersonaId, string>> = {
  coder: "rgb(110 140 170 / 0.14)",
  research: "rgb(214 170 96 / 0.12)",
  finance: "rgb(70 102 178 / 0.16)",
  video: "rgb(150 96 186 / 0.14)",
  design: "rgb(222 86 104 / 0.14)",
};

// Each dot sums itself up in its trade's oldest line, in the tongue that suits it.
const MOTTO: Record<PersonaId, string> = {
  coder: "It works on my machine.",
  research: "Citation needed.",
  finance: "Time is money.",
  video: "We'll fix it in post.",
  design: "Voilà. C'est magnifique.",
  everyday: "Happy to help.",
};

export interface Role {
  id: PersonaId;
  name: string;
  blurb: string;
  motto: string;
  skills: string[];
}

export function roles(): Role[] {
  return ROLE_ORDER.map((id) => {
    const persona = PERSONAS[id];
    const own = persona.skills.filter((skill) => id === "everyday" || !BASICS.has(skill));
    return {
      id,
      name: persona.name,
      blurb: persona.blurb,
      motto: MOTTO[id],
      skills: own.map((skill) => SKILL_LABELS[skill] ?? skill),
    };
  });
}

// The providers a key can be added for today.
const usable = PROVIDERS.filter((p) => !p.notOffered && !p.availableIn && !p.custom && !p.plan);
export const PROVIDER_COUNT = usable.filter((p) => !p.local).length;

// The names on the ring: the well-known ones first, then plans and a local runtime. More would crowd
// its near side.
export const RING: readonly string[] = [
  "Anthropic",
  "OpenAI",
  "Google Gemini",
  "DeepSeek",
  "ChatGPT plan",
  "Claude plan",
  "Ollama",
  "xAI",
  "Mistral",
  "Qwen",
  "Kimi",
  "OpenRouter",
];

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function rolesHtml(): string {
  return roles()
    .map(
      (role) => `<li class="role" data-persona="${role.id}">
          <h3 data-i18n>${esc(role.name)}</h3>
          <p class="role-motto">“<span data-i18n>${esc(role.motto)}</span>”</p>
          <p class="role-skills" data-i18n-list="${esc(role.skills.join("|"))}">${role.skills.map(esc).join(", ")}</p>
        </li>`,
    )
    .join("\n        ");
}

export function ringHtml(): string {
  return RING.map((name) => `<li data-i18n>${esc(name)}</li>`).join("");
}
