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
export async function startUiFixture(
  name: string,
  env: Record<string, string> = {},
): Promise<UiFixture> {
  assertFreshBuild("app");
  const fixture = await start(env, name);
  return {
    origin: fixture.origin,
    sessionId: fixture.sessionId ?? "",
    seeded: fixture.seeded,
    stop: fixture.close,
  };
}
