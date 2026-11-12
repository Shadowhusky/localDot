import type { PersonaId } from "@localdot/protocol";
import { tr } from "../i18n/index.ts";
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
    hello: tr("Back to a bit of everything. What's on the list?"),
    lines: [
      tr("Forms, bookings, sorting files. I like the dull stuff."),
      tr("Give me the errand you keep putting off."),
      tr("I can read a PDF and fill the form it describes."),
    ],
    suggestions: [
      tr("Tidy my Downloads folder"),
      tr("Fill in a spreadsheet from a PDF"),
      tr("Find a table for two on Friday"),
    ],
  },
  coder: {
    greetings: {
      morning: [
        tr("Morning. What are we shipping today?"),
        tr("Good morning. Fresh branch, clean slate."),
        tr("Morning. Point me at a bug before standup."),
      ],
      afternoon: [
        tr("Afternoon. Got a ticket for me?"),
        tr("Post-lunch slump? Hand me the refactor."),
        tr("Afternoon. Tests won't write themselves. I will."),
      ],
      evening: [
        tr("Evening. One more commit before you log off?"),
        tr("Good evening. Leave the flaky test to me."),
        tr("Evening. I'll babysit the build."),
      ],
      night: [
        tr("Still up? Must be a production bug."),
        tr("Late one. Push it my way and get some sleep."),
        tr("It's late. I don't need coffee, so ask away."),
      ],
    },
    hello: tr("Hoodie on. What are we shipping?"),
    lines: [
      tr("I read the code before I touch it. Then I run the tests."),
      tr("Small commits, clear messages. I don't force-push."),
      tr("Paste a stack trace and I'll go find the bug."),
      tr("Ask for a preview and I'll open the app in my browser."),
    ],
    suggestions: [
      tr("Fix the failing tests in my repo"),
      tr("Start a new React app with Vite"),
      tr("Review my latest pull request"),
    ],
  },
  video: {
    greetings: {
      morning: [
        tr("Morning. What are we cutting today?"),
        tr("Good morning. Footage in, story out."),
        tr("Morning. I'll sync the audio while you wake up."),
      ],
      afternoon: [
        tr("Afternoon. Let's find the good take."),
        tr("Got rushes? I'll make the rough cut."),
        tr("Afternoon. Captions are my thing."),
      ],
      evening: [
        tr("Evening. One more export before wrap?"),
        tr("Good evening. Let's cut it tight."),
        tr("Evening. I'll render while you rest."),
      ],
      night: [
        tr("Still up? Must be a deadline cut."),
        tr("Late one. Drop the footage and get some sleep."),
        tr("It's late. I'll keep the timeline warm."),
      ],
    },
    hello: tr("Headphones on. Roll the footage."),
    lines: [
      tr("Your original footage stays untouched. I cut copies."),
      tr("Vertical for Reels, wide for YouTube. Just say where."),
      tr("I check every export frame by frame before you see it."),
      tr("Hand me a long video and I'll find the 30 seconds that matter."),
    ],
    suggestions: [
      tr("Cut a 30-second teaser from my video"),
      tr("Add captions to my video"),
      tr("Export my clip for Instagram Reels"),
    ],
  },
  finance: {
    greetings: {
      morning: [
        tr("Morning. Markets are open. What are we modelling?"),
        tr("Good morning. Numbers first, coffee second."),
        tr("Morning. Send me the spreadsheet nobody wants."),
      ],
      afternoon: [
        tr("Afternoon. Let's make the totals tie out."),
        tr("Good afternoon. Any receipts to reconcile?"),
        tr("Afternoon. I'll run the numbers twice."),
      ],
      evening: [
        tr("Evening. Close the books before you log off?"),
        tr("Good evening. I'll tidy the month end."),
        tr("Evening. Leave the reconciliation to me."),
      ],
      night: [
        tr("Still up? Must be quarter end."),
        tr("Late one. Hand me the ledger and get some sleep."),
        tr("It's late. Spreadsheets don't sleep, and neither do I."),
      ],
    },
    hello: tr("Suit on. Let's make the numbers tie out."),
    lines: [
      tr("Every number I give you says where it came from."),
      tr("Live formulas, not pasted values. Your model stays honest."),
      tr("I recalculate before I hand anything over."),
      tr("Analysis, yes. Personal financial advice, no."),
    ],
    suggestions: [
      tr("Build a monthly budget spreadsheet"),
      tr("Reconcile my bank statement"),
      tr("Summarize this quarter's expenses"),
    ],
  },
  research: {
    greetings: {
      morning: [
        tr("Morning. What are we finding out today?"),
        tr("Good morning. Give me a question and I'll bring sources."),
        tr("Morning. Two sources minimum, as always."),
      ],
      afternoon: [
        tr("Afternoon. What needs looking into?"),
        tr("Good afternoon. I'll read so you don't have to."),
        tr("Afternoon. Curious about something?"),
      ],
      evening: [
        tr("Evening. A quick literature review before bed?"),
        tr("Good evening. I'll dig while you rest."),
        tr("Evening. Want me to check that claim?"),
      ],
      night: [
        tr("Still up? Down a rabbit hole?"),
        tr("Late one. Ask, and I'll cite my sources."),
        tr("It's late. I'll keep reading."),
      ],
    },
    hello: tr("Cap on. What are we finding out?"),
    lines: [
      tr("I confirm key facts in at least two sources."),
      tr("Answer first, then the evidence, with every source linked."),
      tr("Recent and primary beats popular and old."),
      tr("A guess is a guess. I'll say so when that's all I have."),
    ],
    suggestions: [
      tr("Compare the best e-bikes under $2,000"),
      tr("Summarize recent research on sleep and memory"),
      tr("Find three sources on remote work productivity"),
    ],
  },
  design: {
    greetings: {
      morning: [
        tr("Morning. What are we making beautiful today?"),
        tr("Good morning. Fresh canvas, fresh ideas."),
        tr("Morning. Let's pick a palette."),
      ],
      afternoon: [
        tr("Afternoon. Need a deck that sings?"),
        tr("Good afternoon. Bring me your rough sketch."),
        tr("Afternoon. The kerning won't fix itself."),
      ],
      evening: [
        tr("Evening. One more iteration?"),
        tr("Good evening. Let's polish those pixels."),
        tr("Evening. I'll export every size you need."),
      ],
      night: [
        tr("Still up? Ideas keep odd hours."),
        tr("Late one. Tell me the vibe and get some sleep."),
        tr("It's late. The pixels and I are wide awake."),
      ],
    },
    hello: tr("Beret on. Let's make something good."),
    lines: [
      tr("Small palette, clear type scale, steady grid."),
      tr("I check contrast at the real size, not zoomed in."),
      tr("You get the editable source, not only the export."),
      tr("Tell me who it's for and where it goes. I'll take it from there."),
    ],
    suggestions: [
      tr("Make a slide deck from my notes"),
      tr("Design a poster for my event"),
      tr("Resize my logo for every app icon"),
    ],
  },
};
