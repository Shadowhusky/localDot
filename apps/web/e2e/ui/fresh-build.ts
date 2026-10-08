import { assertFreshBuild } from "../fixtures/start-ui-fixture.ts";

// The harness tests what the fixture serves, so both builds must include the current sources.
// biome-ignore lint/style/noDefaultExport: Playwright runs a global setup's default export.
export default function freshBuild() {
  assertFreshBuild("app");
  assertFreshBuild("gallery");
}
