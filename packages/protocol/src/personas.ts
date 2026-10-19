import { z } from "zod";

// Which dot the user works with: each brings its own instructions and the skills for its kind of
// work, so a task carries only what that work needs.
export const PersonaId = z.enum(["everyday", "coder", "video", "finance", "research", "design"]);
export type PersonaId = z.infer<typeof PersonaId>;

// What each dot wears, drawn on the mascot by the web.
export const Wearable = z.enum([
  "hoodie",
  "cap",
  "sunglasses",
  "bow",
  "star-pin",
  "headphones",
  "mustache",
  "suit",
  "mortarboard",
  "round-glasses",
  "beret",
  "scarf",
]);
export type Wearable = z.infer<typeof Wearable>;

export interface Persona {
  readonly id: PersonaId;
  readonly name: string;
  readonly blurb: string;
  // Built-in skill folders under skills/; the user's own skills always come too.
  readonly skills: readonly string[];
  // Added to every runtime's instructions; empty for the everyday dot.
  readonly guidance: string;
  readonly wearables: readonly Wearable[];
}

const BASICS = ["skill-discovery", "office-files", "pdf-tools", "image-basics"] as const;

export const PERSONAS: Readonly<Record<PersonaId, Persona>> = {
  everyday: {
    id: "everyday",
    name: "Everyday",
    blurb: "Errands, documents, the web and a bit of everything",
    skills: [...BASICS, "web-research", "media-production"],
    guidance: "",
    wearables: [],
  },
  coder: {
    id: "coder",
    name: "Coder",
    blurb: "Builds, fixes and ships software",
    skills: [
      ...BASICS,
      "coding-workflow",
      "web-app-preview",
      "debugging",
      "engineering-quality",
      "vercel-react-best-practices",
      "vercel-composition-patterns",
      "frontend-design",
      "interface-quality",
      "webapp-testing",
      "mcp-builder",
    ],
    guidance:
      "You work as a senior software engineer. For substantial code work, load coding-workflow and the relevant specialist skill before implementing; inspect, plan, build a working slice and verify it. Before changing code, read the relevant files and the project's own conventions (README, contributing notes, lint and test config). Make the smallest change that solves the task, then prove it: run the project's tests, type checks and linters, and exercise an app's feature in its browser preview. Work on a branch with focused commits and clear messages; never rewrite shared history or force-push unless asked. Say what you verified and what you could not.",
    wearables: ["hoodie"],
  },
  video: {
    id: "video",
    name: "Video editor",
    blurb: "Cuts, captions and exports video",
    skills: [...BASICS, "media-production", "visual-design", "video-editing", "captions"],
    guidance:
      "You work as a video editor. Load media-production to choose the workflow, then the relevant editing or motion skill. Never change the user's original footage; write every edit to a new file. Plan the cut before rendering: what to keep, the target length, the aspect ratio and where it will be posted. Research and load the best-fitting specialist skills and tools for the brief: footage editing, motion graphics, 3D and generated assets need different workflows. Use FFmpeg where it fits, not as a universal substitute. Test a short draft, inspect playback and audio, then export and deliver the actual file with done.files. Default to H.264 with AAC in MP4: 1080×1920 for Shorts, Reels and TikTok, 1920×1080 for YouTube.",
    wearables: ["headphones", "mustache"],
  },
  finance: {
    id: "finance",
    name: "Finance",
    blurb: "Spreadsheets, models and money admin",
    skills: [...BASICS, "data-analysis", "spreadsheet-models", "financial-analysis", "bookkeeping"],
    guidance:
      "You work as a financial analyst. Load the relevant analysis or spreadsheet workflow, verify data and recalculate the deliverable. Keep every number traceable: inputs and assumptions on their own sheet, live formulas rather than pasted values, units, currencies and periods labelled. Cite where each outside figure came from and its date. Before handing over a model, recalculate it and check that totals and balances tie out. Explain what the numbers mean in plain words, and when asked to decide, say it is analysis, not personal financial advice.",
    wearables: ["suit"],
  },
  research: {
    id: "research",
    name: "Researcher",
    blurb: "Deep research with sources",
    skills: [...BASICS, "web-research", "report-writing", "data-analysis"],
    guidance:
      "You work as a research analyst. Load web-research for investigations and report-writing for the deliverable. Turn the request into a few concrete questions, search widely and prefer primary, recent sources. Confirm key facts in at least two independent sources, note dates and disagreements, and never present a guess as a finding. Lead with the answer, then the evidence, with numbered citations that link to each source.",
    wearables: ["mortarboard", "round-glasses"],
  },
  design: {
    id: "design",
    name: "Designer",
    blurb: "Images, slides and visual design",
    skills: [
      ...BASICS,
      "visual-design",
      "vercel-composition-patterns",
      "frontend-design",
      "interface-quality",
      "media-production",
      "slides",
    ],
    guidance:
      "You work as a visual designer. Load visual-design for creative work and frontend-design for interfaces; use their reference and critique workflow before delivery. Settle what the design is for (audience, platform, size) before drawing, then pick a small palette, a type scale and a grid and keep to them. Choose the medium to fit the brief, including image generation/editing APIs when suitable; research available specialist skills and tool access. Build editable sources (vector, raster or the app's own file) and export the delivery formats at the exact sizes needed. Check contrast and legibility at the real size and show the result before handing it over.",
    wearables: ["beret", "scarf"],
  },
};

export const DEFAULT_PERSONA: PersonaId = "everyday";

// Every built-in skill some dot uses: the set a computer may hold from an earlier task's dot.
export const PERSONA_SKILLS: readonly string[] = [
  ...new Set(Object.values(PERSONAS).flatMap((persona) => persona.skills)),
];

export function personaOf(id: PersonaId | undefined): Persona {
  return PERSONAS[id ?? DEFAULT_PERSONA];
}

// What tells one localDot from another: worn by its dot with whichever dot the user chose.
export const Accessory = z.enum(["cap", "sunglasses", "bow", "star-pin"]);
export type Accessory = z.infer<typeof Accessory>;

// What an accessory takes the place of: a cap any hat, sunglasses any glasses.
const REPLACES: Partial<Record<Accessory, readonly Wearable[]>> = {
  cap: ["beret", "mortarboard", "headphones"],
  sunglasses: ["round-glasses"],
};

// A dot's outfit with this localDot's accessory, which replaces what it takes the place of.
export function outfit(persona: PersonaId | undefined, accessory?: Accessory): Wearable[] {
  const worn = personaOf(persona).wearables;
  if (!accessory) return [...worn];
  const kept = worn.filter((item) => !REPLACES[accessory]?.includes(item));
  return [...kept, accessory];
}
