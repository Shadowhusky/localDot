import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  compareReleaseVersions,
  MAX_RELEASE_NOTES,
  type ReleaseNote,
} from "../../../../packages/protocol/src/app-update.ts";
import { RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";
import {
  RELEASE_NOTES_MAX_BYTES,
  releaseNotesProblems,
} from "../../../../packages/protocol/src/release-notes.ts";

/** A note as the app shows it, or null for one that breaks the release-notes rules. */
export function releaseNote(version: string, markdown: unknown): ReleaseNote | null {
  if (
    version.length > 64 ||
    !RELEASE_VERSION.test(version) ||
    typeof markdown !== "string" ||
    Buffer.byteLength(markdown) > RELEASE_NOTES_MAX_BYTES ||
    releaseNotesProblems(markdown).length
  )
    return null;
  return { version, markdown: markdown.replace(/\r\n?/g, "\n").trim() };
}

/** Newest first and bounded: the valid notes among `notes` whose version `wanted` keeps. */
export function pickNotes(
  notes: Iterable<ReleaseNote | null>,
  wanted: (version: string) => boolean,
): ReleaseNote[] {
  return [...notes]
    .filter((note): note is ReleaseNote => !!note && wanted(note.version))
    .sort((a, b) => compareReleaseVersions(b.version, a.version))
    .slice(0, MAX_RELEASE_NOTES);
}

async function readNote(file: string): Promise<string | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > RELEASE_NOTES_MAX_BYTES) return null;
    const body = Buffer.alloc(RELEASE_NOTES_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(body, 0, body.length, 0);
    if (bytesRead > RELEASE_NOTES_MAX_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** Notes files named <version>.md in an installed or downloaded app. A missing folder, as in a
 * release from before notes, has none. */
export async function readReleaseNotes(
  directory: string,
  wanted: (version: string) => boolean,
): Promise<ReleaseNote[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const versions = names
    .map((name) => name.match(/^(.+)\.md$/)?.[1])
    .filter((version): version is string => !!version && RELEASE_VERSION.test(version))
    .filter(wanted)
    .sort((a, b) => compareReleaseVersions(b, a))
    .slice(0, MAX_RELEASE_NOTES);
  const notes = await Promise.all(
    versions.map(async (version) =>
      releaseNote(version, await readNote(join(directory, `${version}.md`)).catch(() => null)),
    ),
  );
  return pickNotes(notes, wanted);
}

// Versions after `after` (exclusive) up to `upTo` (inclusive); with no `after`, `upTo` alone.
export function versionsBetween(after: string | null, upTo: string) {
  return (version: string) =>
    compareReleaseVersions(version, upTo) <= 0 &&
    (after === null
      ? compareReleaseVersions(version, upTo) === 0
      : compareReleaseVersions(version, after) > 0);
}
