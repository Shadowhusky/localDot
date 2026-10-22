# Release notes

Each release has one file here, named by its version: `0.1.0-rc.32.md`. The app shows it in
Settings → Your computer → localDot updates as "What's new in 0.1.0-rc.32", before the update is
installed and once after it. Write it for the people who use localDot: what they will notice, in
plain words.

```markdown
## What's new

- One sentence per change people will notice.

## Fixes

- One sentence per problem that no longer happens.

## Before you update

- Anything to know first, such as "Your computer restarts once; your files and sign-ins stay."
```

- Use only these three headings, in this order. Leave out a section with nothing to say.
- At most five bullets in a section, one sentence each, and 1,500 characters in all.
- No links, images, HTML or code, and no internal names or engineering words (keyd, brain,
  gate, cell, digest, PR, refactor, commit and the like): the check lists the ones it refuses.

`releaseNotesProblems` in `packages/protocol/src/release-notes.ts` holds the rules. Building a
release package (`apps/cli/scripts/build-runtime.mjs`, which both release builds use) fails
without a valid file for its version, and ships it with the notes of the nine releases before
it, so an update that skips versions can show them too. Assembling the download site puts the
same notes into the signed release catalog, so an update that is not downloaded yet shows them.
Releases before 0.1.0-rc.32 have no notes; the app then shows only the version.
