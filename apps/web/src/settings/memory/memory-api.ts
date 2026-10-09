import {
  type AddPersonRequest,
  type EditPersonRequest,
  type MemoryBook,
  MemoryEntriesReply,
  type MemoryEntry,
  MemoryEntryChangeReply,
  PeopleReply,
  type Person,
  PersonChangeReply,
  RecentActivityReply,
} from "@localdot/protocol";
import type { ApiClient } from "../../lib/api.ts";

export type MemoryFailure =
  | "stale"
  | "missing"
  | "busy"
  | "invalid"
  | "full"
  | "unreadable"
  | "offline";
export class MemoryRequestError extends Error {
  constructor(readonly reason: MemoryFailure) {
    super(reason);
    this.name = "MemoryRequestError";
  }
}
const REASON: Record<number, MemoryFailure> = {
  400: "invalid",
  404: "missing",
  409: "stale",
  413: "full",
  500: "unreadable",
  503: "busy",
};

async function call<T>(
  api: ApiClient,
  method: string,
  path: string,
  parse: (value: unknown) => T,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await api.fetch(api.socketUrl(path).replace(/^ws/, "http"), {
      method,
      headers: {
        authorization: api.authorization(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new MemoryRequestError("offline");
  }
  if (res.status === 401) api.rejectUnauthorized?.();
  if (!res.ok) throw new MemoryRequestError(REASON[res.status] ?? "offline");
  const text = await res.text();
  try {
    return parse(text ? JSON.parse(text) : undefined);
  } catch {
    throw new MemoryRequestError("offline");
  }
}

export const loadEntries = (api: ApiClient, signal: AbortSignal) =>
  call(
    api,
    "GET",
    "/api/agent/memory/entries",
    (v) => MemoryEntriesReply.parse(v),
    undefined,
    signal,
  );
export const addEntry = (api: ApiClient, file: MemoryBook, text: string, pinned = false) =>
  call(api, "POST", "/api/agent/memory/entries", (v) => MemoryEntryChangeReply.parse(v), {
    file,
    text,
    ...(pinned ? { pinned } : {}),
  });
export const editEntry = (
  api: ApiClient,
  entry: MemoryEntry,
  patch: { text?: string; pinned?: boolean },
) =>
  call(
    api,
    "PUT",
    `/api/agent/memory/entries/${entry.id}`,
    (v) => MemoryEntryChangeReply.parse(v),
    {
      file: entry.file,
      revision: entry.revision,
      ...patch,
    },
  );
export const deleteEntry = (api: ApiClient, entry: MemoryEntry) =>
  call(
    api,
    "DELETE",
    `/api/agent/memory/entries/${entry.id}?file=${encodeURIComponent(entry.file)}&revision=${entry.revision}`,
    (v) => MemoryEntryChangeReply.parse(v),
  );
export const undoChange = async (api: ApiClient, changeId: string) => {
  await call(api, "POST", `/api/agent/memory/${changeId}/undo`, () => undefined);
};

export const loadPeople = (api: ApiClient, signal: AbortSignal) =>
  call(api, "GET", "/api/agent/people", (v) => PeopleReply.parse(v).people, undefined, signal);
export const addPerson = (api: ApiClient, person: AddPersonRequest) =>
  call(api, "POST", "/api/agent/people", (v) => PersonChangeReply.parse(v).person, person);
export const editPerson = (
  api: ApiClient,
  person: Person,
  patch: Omit<EditPersonRequest, "revision">,
) =>
  call(api, "PUT", `/api/agent/people/${person.id}`, (v) => PersonChangeReply.parse(v).person, {
    revision: person.revision,
    ...patch,
  });
export const deletePerson = async (api: ApiClient, person: Person) => {
  await call(api, "DELETE", `/api/agent/people/${person.id}?revision=${person.revision}`, (v) =>
    PersonChangeReply.parse(v),
  );
};

export const loadRecent = (api: ApiClient, signal: AbortSignal) =>
  call(
    api,
    "GET",
    "/api/agent/recent-activity",
    (v) => RecentActivityReply.parse(v),
    undefined,
    signal,
  );
