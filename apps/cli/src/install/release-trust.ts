// Public Apple Developer Team ID supplied by Richard on 2026-10-07. Compiled with the installer;
// never read from candidate metadata, environment variables, or downloaded configuration.
export const KEYD_RELEASE_TEAM_ID = "87FD3FSZBG";

// Release workflow identity from the localDot handoff/release plan. These are build-owned pins,
// never derived from the downloaded npm statement, registry metadata or process environment.
export const RELEASE_PROVENANCE_PINS = Object.freeze({
  repository: "https://github.com/Shadowhusky/localdot",
  workflow: ".github/workflows/release.yml",
  issuer: "https://token.actions.githubusercontent.com",
});
