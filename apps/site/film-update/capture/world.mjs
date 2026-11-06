// The sample world the film's app shows: believable tasks, nothing private. The fixture's own data
// is replaced where it reaches the page, so the app itself is untouched.
const SINCE = (now, ago) => new Date(Date.parse(now) - ago).toISOString();

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// An id whose time part reads `ms`, as the app takes a message's time from it.
function ulidAt(ms, n) {
  let time = "";
  for (let left = ms, i = 0; i < 10; i++) {
    time = CROCKFORD[left % 32] + time;
    left = Math.floor(left / 32);
  }
  return time + String(n).padStart(16, "0");
}

// What the fixture's past conversations become in the film; a task the take is about takes the place
// of one the world would otherwise show.
const SAMPLES = {
  lisbon: {
    title: "Flights to Lisbon in May",
    line: "The 9:40 on Friday is the cheapest with a bag.",
    look: ["cowboy-hat", "lei"],
  },
  photos: {
    title: "Holiday photos",
    look: ["sunglasses", "bow-tie"],
    live: { state: "working", onScreen: false, activity: "Renaming 214 photos by date" },
  },
  dinner: {
    title: "Mum's 60th dinner",
    line: "Friday or Saturday?",
    look: ["party-hat", "pearls"],
    live: { state: "needs-you", onScreen: false },
  },
  plumber: {
    title: "Find a plumber near me",
    line: "Three nearby, all with good reviews.",
    look: ["hard-hat", "overalls"],
  },
  downloads: {
    title: "Tidy my Downloads",
    line: "Moved 86 files. Nothing deleted.",
    look: ["wizard-hat"],
  },
  landlord: {
    title: "Reply to the landlord",
    line: "Writing back to Tom about Tuesday",
    look: ["beret", "scarf"],
    live: { state: "working", onScreen: false, activity: "Writing back to Tom about Tuesday" },
  },
  invoice: {
    title: "Find the boiler invoice",
    line: "Searching your inbox",
    look: ["mortarboard", "round-glasses"],
    live: { state: "working", onScreen: false, activity: "Searching your inbox" },
  },
  dotRun: {
    title: "Dot Run",
    line: "Playing a full run",
    look: ["hoodie"],
    live: { state: "working", onScreen: false, activity: "Playing a full run" },
  },
};
const PAST = [
  [/^Compare flights/, "lisbon"],
  [/^Rename the holiday/, "photos"],
  [/^Summarise the Q3/, "dinner"],
  [/^Find a plumber/, "plumber"],
  [/^Clean up my Downloads/, "downloads"],
  [/^Draft a reply/, "landlord"],
];

// `hero` is the task the take is about, or how to list the one it starts.
export function conversationList(body, { now, hero, swap = {} }) {
  const { conversations, archivedCount } = body;
  return {
    archivedCount,
    conversations: conversations.map((entry) => {
      const said = entry.said ?? entry.title ?? "";
      const past = PAST.find(([name]) => name.test(said))?.[1];
      if (!past && typeof hero === "function") return hero(entry);
      if (!past)
        return {
          ...entry,
          title: hero.title,
          said: hero.said,
          look: hero.look,
          line: hero.activity,
          live: {
            state: "working",
            onScreen: true,
            activity: hero.activity,
            since: SINCE(now, 90_000),
          },
        };
      const { live, ...rest } = SAMPLES[swap[past] ?? past];
      return {
        ...entry,
        ...rest,
        said: rest.title,
        ...(live ? { ended: null, live: { ...live, since: SINCE(now, 180_000) } } : {}),
      };
    }),
  };
}

// A thread as the daemon's history carries it, line by line, numbered from 0 up to the sequence number
// the live stream goes on from. Key uses, which a thread doesn't show, make up the count.
export function history(events, { lastSeq, startedAt, secondsPerEvent = 0.32 }) {
  const filler = Array.from({ length: Math.max(0, lastSeq + 1 - events.length) }, () => [
    "key.use",
    {
      secretId: "anthropic-main",
      host: "api.anthropic.com",
      method: "POST",
      path: "/v1/messages",
      decision: "allow",
    },
    undefined,
    0.01,
  ]);
  const [start, ...rest] = events;
  const steps = new Map();
  let t = 0;
  return [start, ...filler, ...rest]
    .map(([type, data, step, seconds], seq) => {
      t += (seconds ?? secondsPerEvent) * 1_000_000;
      const ms = startedAt + Math.round(t / 1000);
      if (step && !steps.has(step)) steps.set(step, ulidAt(ms, 2000 + seq));
      return JSON.stringify({
        v: 1,
        id: ulidAt(ms, seq),
        seq,
        t: Math.round(t),
        agent: "main",
        ...(step ? { step: steps.get(step) } : {}),
        type,
        data: data.messageId ? { ...data, messageId: ulidAt(ms, 1000 + seq) } : data,
      });
    })
    .join("\n");
}

const step = (id, kind, intent, seconds = 2.4) => [
  ["step.start", { kind, intent }, id],
  ["step.end", { status: "ok" }, id, seconds],
];

const say = (n, text) => [
  "message.assistant",
  { messageId: `01JF20000000000000000000${String(n).padStart(2, "0")}`, text },
];
const ask = (n, text, kind = "task") => [
  "message.user",
  { messageId: `01JF10000000000000000000${String(n).padStart(2, "0")}`, kind, text },
];
const start = (title) => [
  "session.start",
  { screen: { w: 2560, h: 1600, scale: 2 }, os: "linux", title },
];

// What the film's task says, and why Auto gives it the dot it does.
export const TASK = "Build me a little 3D game where the ball is you.";
export const CHOICE = { persona: "coder", by: "auto", reason: "A game is a coding job" };

// The film's task: a little 3D game, with dot as the ball.
export const DOT_RUN = {
  title: SAMPLES.dotRun.title,
  said: TASK,
  look: SAMPLES.dotRun.look,
  activity: SAMPLES.dotRun.line,
  ago: 7 * 60_000,
  events: [
    start(SAMPLES.dotRun.title),
    ask(1, "Morning dot!", "task"),
    say(1, "Morning! What are we up to today?"),
    ask(2, TASK, "followup"),
    ["persona.choice", CHOICE],
    ["agent.state", { state: "thinking" }],
    say(2, "Love it. I'll build it, then play a run to make sure it really works."),
    ...step("01JF3000000000000000000001", "shell", "Checking Node and existing projects", 3.1),
    ...step("01JF3000000000000000000002", "shell", "Setting up the project", 11.4),
    ...step(
      "01JF3000000000000000000003",
      "file",
      "Writing the game: the track, the stars and me",
      42.2,
    ),
    ...step(
      "01JF3000000000000000000004",
      "file",
      "Adding the clouds, the glow and the score",
      18.5,
    ),
    ...step("01JF3000000000000000000005", "shell", "Starting it up in the browser", 6.8),
    say(
      3,
      "It works! A glowing track over the clouds, stars to collect, and I'm the ball. Now a real run, to be sure.",
    ),
    ["agent.state", { state: "acting" }],
    [
      "step.start",
      {
        kind: "gui",
        intent: "Playing a full run in the browser",
        model: { route: "anthropic", model: "claude-sonnet-5-5" },
      },
      "01JF3000000000000000000006",
    ],
  ],
};

// The same task, finished, with the game still running in dot's computer.
const running = DOT_RUN.events.slice(0, -2);
export const DOT_RUN_DONE = {
  ...DOT_RUN,
  activity: "Dot Run is ready to play",
  events: [
    ...running,
    [
      "task.result",
      {
        summary: "Done. One full run, every star collected.",
        files: [],
        previews: [
          {
            port: 5173,
            url: "http://localhost:5173/",
            title: "Dot Run",
            project: "dot-run",
            name: "node",
          },
        ],
      },
    ],
    ["agent.state", { state: "done" }],
  ],
};

export const LANDLORD = {
  title: SAMPLES.landlord.title,
  said: "Reply to the landlord about the boiler. Say Tuesday works, and thank him.",
  look: SAMPLES.landlord.look,
  activity: SAMPLES.landlord.line,
  ago: 2 * 60_000,
  events: [
    start(SAMPLES.landlord.title),
    ask(1, "Reply to the landlord about the boiler. Say Tuesday works, and thank him."),
    ["agent.state", { state: "thinking" }],
    say(1, "On it. Postbox is already signed in, so I'll answer from there."),
    ...step("01JF3000000000000000000001", "browser", "Opening your inbox", 2.2),
    ...step("01JF3000000000000000000002", "browser", "Reading Tom's email about the boiler", 3.4),
    ["agent.state", { state: "acting" }],
    [
      "step.start",
      {
        kind: "browser",
        intent: "Writing back to Tom about Tuesday",
        model: { route: "anthropic", model: "claude-sonnet-5-5" },
      },
      "01JF3000000000000000000003",
    ],
  ],
};

export const INVOICE = {
  title: SAMPLES.invoice.title,
  said: "Find last March's boiler invoice and save it to my tax folder.",
  look: SAMPLES.invoice.look,
  activity: SAMPLES.invoice.line,
  ago: 60_000,
  events: [
    start(SAMPLES.invoice.title),
    ask(1, "Find last March's boiler invoice and save it to my tax folder."),
    ["agent.state", { state: "thinking" }],
    say(1, "Looking now. Same inbox, my own window, so I won't get in the way."),
    ["agent.state", { state: "acting" }],
    [
      "step.start",
      {
        kind: "browser",
        intent: "Searching your inbox for the invoice",
        model: { route: "anthropic", model: "claude-sonnet-5-5" },
      },
      "01JF3000000000000000000001",
    ],
  ],
};

// A task at work in a browser, for the windows of the several-at-once scene: one of its own each.
const worker = (title, said, look, intent) => ({
  title,
  said,
  look,
  activity: intent,
  ago: 3 * 60_000,
  events: [
    start(title),
    ask(1, said),
    ["agent.state", { state: "acting" }],
    [
      "step.start",
      { kind: "browser", intent, model: { route: "anthropic", model: "claude-sonnet-5-5" } },
      "01JF3000000000000000000009",
    ],
  ],
});

// Each window's task, the site it works in and the frames of that site, in the order they arrive.
export const WORKERS = [
  ["landlord", LANDLORD, "landlord"],
  ["invoice", INVOICE, "invoice"],
  [
    "flights",
    worker(
      "Flights to Lisbon in May",
      "Find me the cheapest direct flight to Lisbon on 14 May.",
      ["sunglasses", "cap"],
      "Comparing five flights",
    ),
    "flights",
  ],
  [
    "photos",
    worker(
      "Holiday photos",
      "Rename the holiday photos by date.",
      ["bow"],
      "Renaming 214 photos by date",
    ),
    "photos",
  ],
  [
    "sheet",
    worker(
      "October expenses",
      "Put my October receipts into the expenses sheet.",
      ["suit", "round-glasses"],
      "Filling in the expenses sheet",
    ),
    "sheet",
  ],
  [
    "dinner",
    worker(
      "Mum's 60th dinner",
      "Book a table for 8 on Saturday, around half seven.",
      ["headphones"],
      "Holding a table for 8",
    ),
    "dinner",
  ],
  [
    "plumber",
    worker(
      "Find a plumber",
      "Find a plumber for the boiler service, free next week.",
      ["star-pin", "scarf"],
      "Messaging Brightside Heating",
    ),
    "plumber",
  ],
  [
    "downloads",
    worker(
      "Tidy my Downloads",
      "Sort my Downloads into folders. Don't delete anything.",
      ["mustache"],
      "Sorting 86 files",
    ),
    "downloads",
  ],
];

// The daemon's previews routes, as the app's own previews spec answers them: the fixture has no
// computer to run a web app in, and no tailnet to open one on.
export async function routePreviews(page, now) {
  const origin = "https://mac.tail1234.ts.net:4901";
  await page.route("**/api/sessions/*/previews", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          state: "ready",
          addresses: ["172.20.0.11"],
          previews: [],
          servers: [
            {
              port: 5173,
              url: "http://localhost:5173/",
              name: "node",
              title: "Dot Run",
              state: "answering",
              seenAt: now,
              project: "dot-run",
              here: true,
            },
          ],
        },
      });
    return route.fulfill({
      json: {
        preview: { id: "p1", target: "http://localhost:5173/", origin, openedAt: now },
        open: `${origin}/__localdot/preview#film`,
      },
    });
  });
}

// A new task's stream, as the film tells it rather than as the fixture's own clock would: the task as
// sent, then Auto's choice, the task's name and its run in the browser each when `release` says, on the beat.
export async function routeNewTask(page, { now }) {
  const lines = history(
    [
      start(TASK),
      ask(1, TASK),
      ["agent.state", { state: "thinking" }],
      ["persona.choice", CHOICE],
      ["session.title", { title: SAMPLES.dotRun.title, by: "auto" }],
      say(2, "Love it. I'll build it, then play a run to make sure it really works."),
      [
        "step.start",
        { kind: "file", intent: "Writing the game: the track, the stars and me" },
        "01JF3000000000000000000003",
      ],
      ["step.end", { status: "ok" }, "01JF3000000000000000000003"],
      ...DOT_RUN.events.slice(-2),
    ],
    { lastSeq: 9, startedAt: Date.parse(now) + 150_000, secondsPerEvent: 0.2 },
  ).split("\n");
  const opening = 3;
  const sockets = [];
  // Until the task is sent, the fixture's own tasks are as they are.
  let sent = false;
  const fresh = new Set();
  const isNew = (url) => {
    const id = url.match(/\/api\/sessions\/([0-9A-Z]+)\//)?.[1];
    if (sent) fresh.add(id);
    return fresh.has(id);
  };
  await page.route(/\/api\/sessions\/[0-9A-Z]+\/history/, (route) =>
    isNew(route.request().url())
      ? route.fulfill({
          contentType: "application/x-ndjson",
          body: `${lines.slice(0, opening).join("\n")}\n`,
        })
      : route.fallback(),
  );
  await page.routeWebSocket(/\/api\/sessions\/[0-9A-Z]+\/stream/, (ws) => {
    if (!isNew(ws.url())) {
      const server = ws.connectToServer();
      server.onMessage((message) => ws.send(message));
      ws.onMessage((message) => server.send(message));
      return;
    }
    sockets.push(ws);
    const from = Number(new URL(ws.url()).searchParams.get("fromSeq") ?? 0);
    for (const line of lines.slice(0, opening)) if (JSON.parse(line).seq >= from) ws.send(line);
  });
  let told = opening;
  const release = (type) => {
    const at = lines.findIndex((line, i) => i >= told && JSON.parse(line).type === type);
    if (at < 0) return false;
    for (const line of lines.slice(told, at + 1)) for (const ws of sockets) ws.send(line);
    told = at + 1;
    return true;
  };
  // Called as the task goes: the sessions the page asks after from then on are the new task's.
  release.send = () => {
    sent = true;
  };
  return release;
}

export async function routeWorld(page, { now, hero, swap, finished = false, lastSeq = 42 }) {
  await page.route("**/api/conversations", async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    await route.fulfill({ json: conversationList(await reply.json(), { now, hero, swap }) });
  });
  const lines = history(hero.events, { lastSeq, startedAt: Date.parse(now) - hero.ago }).split(
    "\n",
  );
  // The fixture's seeded events give way to the sample thread; what the film asks the fixture to do
  // from then on comes through as it is.
  await page.routeWebSocket(/\/api\/sessions\/[0-9A-Z]+\/stream/, (ws) => {
    const server = ws.connectToServer();
    const from = Number(new URL(ws.url()).searchParams.get("fromSeq") ?? 0);
    let told = false;
    server.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.seq === undefined) return ws.send(message);
      if (!told) {
        told = true;
        for (const line of lines) if (JSON.parse(line).seq >= from) ws.send(line);
      }
      if (event.seq > lastSeq && !finished) ws.send(message);
    });
    ws.onMessage((message) => server.send(message));
  });
  await page.route(/\/api\/sessions\/[0-9A-Z]+\/history/, async (route) => {
    const reply = await route.fetch().catch(() => undefined);
    if (!reply) return route.abort().catch(() => {});
    await route.fulfill({
      contentType: reply.headers()["content-type"] ?? "application/x-ndjson",
      body: `${lines.join("\n")}\n`,
    });
  });
}
