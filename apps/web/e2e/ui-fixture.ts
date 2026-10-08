import { chromium, webkit } from "@playwright/test";
import { assertFreshBuild, startUiFixture as start } from "./fixtures/start-ui-fixture.ts";

export { TOKEN } from "./fixtures/start-ui-fixture.ts";
export const ENGINES = {
  chrome: () => chromium.launch({ channel: "chrome" }),
  // The config's channel "chrome" reaches every launch, and WebKit refuses any channel.
  webkit: () => webkit.launch({ channel: undefined }),
};

export interface UiFixture {
  origin: string;
  sessionId: string;
  seeded: string[];
  stop(): Promise<void>;
}

// The fixture daemon serves the built UI (dist) with a fake computer and two recorded sessions.
export async function startUiFixture(name: string): Promise<UiFixture> {
  assertFreshBuild("dist/index.html", "build");
  const fixture = await start({}, name);
  return {
    origin: fixture.origin,
    sessionId: fixture.sessionId ?? "",
    seeded: fixture.seeded,
    stop: fixture.close,
  };
}
