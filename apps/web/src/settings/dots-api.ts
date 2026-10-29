import {
  type AddDotRequest,
  DotJob,
  DotSignIn,
  DotsReply,
  RemoveDotReply,
  type Sealed,
} from "@localdot/protocol";
import type { z } from "zod";
import { type ApiClient, ApiError } from "../lib/api.ts";

const POLL_MS = 1000;

async function parsed<T extends z.ZodType>(
  schema: T,
  answer: Promise<unknown>,
): Promise<z.infer<T>> {
  const value = schema.safeParse(await answer);
  if (!value.success) throw new Error("localDot answered with something this page doesn't know.");
  return value.data;
}

const at = (id: string) => `/api/dots/${encodeURIComponent(id)}`;

export const listDots = (api: ApiClient) => parsed(DotsReply, api.get("/api/dots"));
export const addDot = (api: ApiClient, request: AddDotRequest) =>
  parsed(DotJob, api.post("/api/dots", request));
export const dotJob = (api: ApiClient, id: string, signal?: AbortSignal) =>
  parsed(DotJob, api.get(`/api/dots/jobs/${encodeURIComponent(id)}`, { signal }));
export const sendPassphrase = (api: ApiClient, job: string, sealed: Sealed) =>
  parsed(DotJob, api.post(`/api/dots/jobs/${encodeURIComponent(job)}/passphrase`, { sealed }));
export const cancelDotJob = (api: ApiClient, job: string) =>
  parsed(DotJob, api.post(`/api/dots/jobs/${encodeURIComponent(job)}/cancel`));
export const startDot = (api: ApiClient, id: string) => parsed(DotJob, api.post(`${at(id)}/start`));
export const stopDot = (api: ApiClient, id: string) => parsed(DotJob, api.post(`${at(id)}/stop`));
export const removeDot = (api: ApiClient, id: string, deleteData: boolean) =>
  parsed(RemoveDotReply, api.post(`${at(id)}/remove`, { deleteData }));
export const dotSignIn = (api: ApiClient, id: string) =>
  parsed(DotSignIn, api.post(`${at(id)}/sign-in`));

export interface WaitOptions {
  signal?: AbortSignal;
  onUpdate?(job: DotJob): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// Until the job finishes, fails or needs the user: only `running` is worth asking about again.
export async function waitForJob(
  api: ApiClient,
  job: DotJob,
  { signal, onUpdate, sleep = pause }: WaitOptions = {},
): Promise<DotJob> {
  let now = job;
  while (now.state === "running") {
    await sleep(POLL_MS, signal);
    now = await dotJob(api, now.id, signal);
    onUpdate?.(now);
  }
  return now;
}

const TOLD = new Set([400, 404, 409, 503]);

// What went wrong, in localDot's own words where it gave some.
export function dotProblem(error: unknown, fallback: string): string {
  return error instanceof ApiError && TOLD.has(error.status) && error.message.length < 300
    ? error.message
    : fallback;
}
