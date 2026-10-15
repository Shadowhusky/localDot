import type { PersonaId } from "@localdot/protocol";
import { type DayPart, GREETINGS } from "./tips.ts";

// How each dot talks while nothing is going on: its greetings, what it says when you switch to it,
// lines about its own kind of work that it slips between the tips, and the tasks it offers in an
// empty chat. Same rules as tips.ts: dot's own words, plain, short, no exclamation marks.
export interface Voice {
  greetings: Readonly<Record<DayPart, readonly string[]>>;
  hello: string;
  lines: readonly string[];
  suggestions: readonly string[];
}

export const VOICES: Readonly<Record<PersonaId, Voice>> = {
  everyday: {
    greetings: GREETINGS,
    hello: "Back to a bit of everything. What's on the list?",
    lines: [
      "Forms, bookings, sorting files. I like the dull stuff.",
      "Give me the errand you keep putting off.",
      "I can read a PDF and fill the form it describes.",
    ],
    suggestions: [
      "Tidy my Downloads folder",
      "Fill in a spreadsheet from a PDF",
      "Find a table for two on Friday",
    ],
  },
  coder: {
    greetings: {
      morning: [
        "Morning. What are we shipping today?",
        "Good morning. Fresh branch, clean slate.",
        "Morning. Point me at a bug before standup.",
      ],
      afternoon: [
        "Afternoon. Got a ticket for me?",
        "Post-lunch slump? Hand me the refactor.",
        "Afternoon. Tests won't write themselves. I will.",
      ],
      evening: [
        "Evening. One more commit before you log off?",
        "Good evening. Leave the flaky test to me.",
        "Evening. I'll babysit the build.",
      ],
      night: [
        "Still up? Must be a production bug.",
        "Late one. Push it my way and get some sleep.",
        "It's late. I don't need coffee, so ask away.",
      ],
    },
    hello: "Hoodie on. What are we shipping?",
    lines: [
      "I read the code before I touch it. Then I run the tests.",
      "Small commits, clear messages. I don't force-push.",
      "Paste a stack trace and I'll go find the bug.",
      "Ask for a preview and I'll open the app in my browser.",
    ],
    suggestions: [
      "Fix the failing tests in my repo",
      "Start a new React app with Vite",
      "Review my latest pull request",
    ],
  },
  video: {
    greetings: {
      morning: [
        "Morning. What are we cutting today?",
        "Good morning. Footage in, story out.",
        "Morning. I'll sync the audio while you wake up.",
      ],
      afternoon: [
        "Afternoon. Let's find the good take.",
        "Got rushes? I'll make the rough cut.",
        "Afternoon. Captions are my thing.",
      ],
      evening: [
        "Evening. One more export before wrap?",
        "Good evening. Let's cut it tight.",
        "Evening. I'll render while you rest.",
      ],
      night: [
        "Still up? Must be a deadline cut.",
        "Late one. Drop the footage and get some sleep.",
        "It's late. I'll keep the timeline warm.",
      ],
    },
    hello: "Headphones on. Roll the footage.",
    lines: [
      "Your original footage stays untouched. I cut copies.",
      "Vertical for Reels, wide for YouTube. Just say where.",
      "I check every export frame by frame before you see it.",
      "Hand me a long video and I'll find the 30 seconds that matter.",
    ],
    suggestions: [
      "Cut a 30-second teaser from my video",
      "Add captions to my video",
      "Export my clip for Instagram Reels",
    ],
  },
  finance: {
    greetings: {
      morning: [
        "Morning. Markets are open. What are we modelling?",
        "Good morning. Numbers first, coffee second.",
        "Morning. Send me the spreadsheet nobody wants.",
      ],
      afternoon: [
        "Afternoon. Let's make the totals tie out.",
        "Good afternoon. Any receipts to reconcile?",
        "Afternoon. I'll run the numbers twice.",
      ],
      evening: [
        "Evening. Close the books before you log off?",
        "Good evening. I'll tidy the month end.",
        "Evening. Leave the reconciliation to me.",
      ],
      night: [
        "Still up? Must be quarter end.",
        "Late one. Hand me the ledger and get some sleep.",
        "It's late. Spreadsheets don't sleep, and neither do I.",
      ],
    },
    hello: "Suit on. Let's make the numbers tie out.",
    lines: [
      "Every number I give you says where it came from.",
      "Live formulas, not pasted values. Your model stays honest.",
      "I recalculate before I hand anything over.",
      "Analysis, yes. Personal financial advice, no.",
    ],
    suggestions: [
      "Build a monthly budget spreadsheet",
      "Reconcile my bank statement",
      "Summarize this quarter's expenses",
    ],
  },
  research: {
    greetings: {
      morning: [
        "Morning. What are we finding out today?",
        "Good morning. Give me a question and I'll bring sources.",
        "Morning. Two sources minimum, as always.",
      ],
      afternoon: [
        "Afternoon. What needs looking into?",
        "Good afternoon. I'll read so you don't have to.",
        "Afternoon. Curious about something?",
      ],
      evening: [
        "Evening. A quick literature review before bed?",
        "Good evening. I'll dig while you rest.",
        "Evening. Want me to check that claim?",
      ],
      night: [
        "Still up? Down a rabbit hole?",
        "Late one. Ask, and I'll cite my sources.",
        "It's late. I'll keep reading.",
      ],
    },
    hello: "Cap on. What are we finding out?",
    lines: [
      "I confirm key facts in at least two sources.",
      "Answer first, then the evidence, with every source linked.",
      "Recent and primary beats popular and old.",
      "A guess is a guess. I'll say so when that's all I have.",
    ],
    suggestions: [
      "Compare the best e-bikes under $2,000",
      "Summarize recent research on sleep and memory",
      "Find three sources on remote work productivity",
    ],
  },
  design: {
    greetings: {
      morning: [
        "Morning. What are we making beautiful today?",
        "Good morning. Fresh canvas, fresh ideas.",
        "Morning. Let's pick a palette.",
      ],
      afternoon: [
        "Afternoon. Need a deck that sings?",
        "Good afternoon. Bring me your rough sketch.",
        "Afternoon. The kerning won't fix itself.",
      ],
      evening: [
        "Evening. One more iteration?",
        "Good evening. Let's polish those pixels.",
        "Evening. I'll export every size you need.",
      ],
      night: [
        "Still up? Ideas keep odd hours.",
        "Late one. Tell me the vibe and get some sleep.",
        "It's late. The pixels and I are wide awake.",
      ],
    },
    hello: "Beret on. Let's make something good.",
    lines: [
      "Small palette, clear type scale, steady grid.",
      "I check contrast at the real size, not zoomed in.",
      "You get the editable source, not only the export.",
      "Tell me who it's for and where it goes. I'll take it from there.",
    ],
    suggestions: [
      "Make a slide deck from my notes",
      "Design a poster for my event",
      "Resize my logo for every app icon",
    ],
  },
};
