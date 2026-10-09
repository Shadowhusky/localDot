import {
  clipText,
  MAX_RESEARCH_SOURCES,
  MORE_RESEARCH,
  type ResearchBudget,
  type ResearchStop,
  webUrl,
} from "@localdot/protocol";
import { opensInWebBrowser } from "./tools/web-page.ts";

export interface ResearchSource {
  readonly n: number;
  readonly url: string;
  title: string;
  readonly passages: string[];
  cited: boolean;
}

type Emit = (type: "research.source" | "research.budget", data: Record<string, unknown>) => void;

const PASSAGES = 12;
const PASSAGE_CHARS = 1500;
const SEARCH_HOSTS =
  /(?:^|\.)(?:google|bing|duckduckgo|search\.brave|startpage|ecosia|yahoo|baidu|yandex|kagi|qwant|sogou|naver)\.[a-z.]+$/;
const SEARCH_PARAMS = ["q", "query", "p", "wd", "text", "search_query"];
// Query parameters that can carry a sign-in or a signature: a report never shows them.
const PRIVATE_PARAM =
  /(?:^|[_.-])(?:token|key|apikey|sig|signature|auth|authorization|pass|passwd|password|session|sessionid|sid|secret|code|credentials?)$|^x-amz-|^state$/i;

// A search engine's results page: where dot finds sources, never a source itself.
export function isSearchPage(url: string): boolean {
  const page = webUrl(url);
  if (!page) return false;
  return (
    SEARCH_HOSTS.test(page.hostname.toLowerCase()) &&
    SEARCH_PARAMS.some((name) => page.searchParams.has(name))
  );
}

// The address as a report may show it: no credentials, fragment or private parameters. Undefined
// for anything that is not a public http(s) page.
export function publicUrl(url: string): string | undefined {
  const page = webUrl(url);
  if (!page) return undefined;
  page.username = "";
  page.password = "";
  if (!opensInWebBrowser(page)) return undefined;
  page.hash = "";
  for (const name of [...page.searchParams.keys()])
    if (PRIVATE_PARAM.test(name)) page.searchParams.delete(name);
  if (page.pathname.length > 1 && page.pathname.endsWith("/"))
    page.pathname = page.pathname.slice(0, -1);
  return page.href.slice(0, 2048);
}

export function siteOf(url: string): string {
  return (webUrl(url)?.hostname ?? "").replace(/^www\./, "");
}

// A research task's numbered sources and its soft budget. dot reads until the sources or the
// minutes run out, or the user says to wrap up; then new sources are refused and every gathering
// step tells dot to write with what it has.
export class ResearchLog {
  #budget: ResearchBudget;
  #stopped: ResearchStop | undefined;
  readonly #startedAt: number;
  readonly #sources: ResearchSource[] = [];
  readonly #byUrl = new Map<string, ResearchSource>();

  constructor(
    budget: ResearchBudget,
    private readonly emit: Emit,
    private readonly now: () => number = Date.now,
  ) {
    this.#budget = { ...budget };
    this.#startedAt = now();
  }
  get budget(): ResearchBudget {
    return { ...this.#budget };
  }
  get sources(): readonly ResearchSource[] {
    return this.#sources;
  }
  get minutesUsed(): number {
    return Math.floor((this.now() - this.#startedAt) / 60_000);
  }
  // Why gathering has stopped, checked against the clock now.
  get stopped(): ResearchStop | undefined {
    if (!this.#stopped) {
      if (this.#sources.length >= this.#budget.sources) this.#stop("sources");
      else if (this.now() - this.#startedAt >= this.#budget.minutes * 60_000) this.#stop("time");
    }
    return this.#stopped;
  }
  find(url: string): ResearchSource | undefined {
    const key = publicUrl(url);
    return key ? this.#byUrl.get(key) : undefined;
  }
  source(n: number): ResearchSource | undefined {
    return this.#sources[n - 1];
  }
  // A page or file dot read: its number, new or known. Undefined when it would be a new source
  // after the budget is reached, or is no public page.
  add(url: string, title: string): { source: ResearchSource; added: boolean } | undefined {
    const key = publicUrl(url);
    if (!key) return undefined;
    const known = this.#byUrl.get(key);
    const named = clipText(title, 300).trim();
    if (known) {
      if (named && (!known.title || known.title === siteOf(key))) {
        known.title = named;
        this.#emitSource(known);
      }
      return { source: known, added: false };
    }
    if (this.stopped || this.#sources.length >= MAX_RESEARCH_SOURCES) return undefined;
    const source: ResearchSource = {
      n: this.#sources.length + 1,
      url: key,
      title: named || siteOf(key),
      passages: [],
      cited: false,
    };
    this.#sources.push(source);
    this.#byUrl.set(key, source);
    this.#emitSource(source);
    // The source that reaches the budget is kept; only the next one is refused.
    void this.stopped;
    return { source, added: true };
  }
  // The exact passages dot relies on, once each.
  quote(source: ResearchSource, passages: readonly string[]): number {
    let added = 0;
    for (const raw of passages) {
      const passage = raw.replace(/\s+/g, " ").trim().slice(0, PASSAGE_CHARS);
      if (!passage || source.passages.includes(passage) || source.passages.length >= PASSAGES)
        continue;
      source.passages.push(passage);
      added += 1;
    }
    if (added) this.#emitSource(source);
    return added;
  }
  cite(numbers: readonly number[]): void {
    for (const n of numbers) {
      const source = this.source(n);
      if (!source || source.cited) continue;
      source.cited = true;
      this.#emitSource(source);
    }
  }
  wrapUp(): void {
    if (this.stopped) return;
    this.#stop("user");
  }
  // Keep going: more sources and minutes on top of what is used, within the budget's bounds.
  more(): void {
    this.#budget = {
      sources: Math.min(
        100,
        Math.max(this.#budget.sources, this.#sources.length) + MORE_RESEARCH.sources,
      ),
      minutes: Math.min(
        120,
        Math.max(this.#budget.minutes, this.minutesUsed) + MORE_RESEARCH.minutes,
      ),
    };
    this.#stopped = undefined;
    this.emit("research.budget", { ...this.#budget });
    void this.stopped;
  }
  // For dot, with each source it reads: how far through the budget it is.
  status(): string {
    return `${this.#sources.length} of about ${this.#budget.sources} sources, ${this.minutesUsed} of ${this.#budget.minutes} minutes`;
  }
  stopNote(): string {
    const why =
      this.#stopped === "user"
        ? "The user asked you to wrap up."
        : this.#stopped === "time"
          ? `The research time (${this.#budget.minutes} minutes) is used up.`
          : `The research budget (${this.#budget.sources} sources) is reached.`;
    return `${why} Stop gathering: write the report now with the sources you have, and name what is still open.`;
  }
  moreNote(): string {
    return `The user gave the research more room: about ${this.#budget.sources} sources and ${this.#budget.minutes} minutes in all. Keep gathering where it helps, then write the report.`;
  }
  #stop(reason: ResearchStop): void {
    this.#stopped = reason;
    this.emit("research.budget", { ...this.#budget, stopped: reason });
  }
  #emitSource(source: ResearchSource): void {
    this.emit("research.source", {
      n: source.n,
      url: source.url,
      title: source.title,
      passages: source.passages.length,
      ...(source.cited ? { cited: true } : {}),
    });
  }
}
