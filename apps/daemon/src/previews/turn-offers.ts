import { type ResultPreview, ulidTime } from "@localdot/protocol";
import type { TaskScan } from "../deliverables/task-scan.ts";
import type { PreviewTurn } from "./previews.ts";

// A reply waits this long at most for what its turn left running.
const OFFER_MS = 3000;

// The previews a turn's reply comes with: what the task's own record says it did, since its last
// reply, against what is running now.
export async function turnOffers(
  deps: {
    scan(id: string): Promise<TaskScan | undefined>;
    offers(id: string, turn: PreviewTurn): Promise<ResultPreview[]>;
  },
  id: string,
  reply: string,
  ms = OFFER_MS,
): Promise<ResultPreview[]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ResultPreview[]>((resolve) => {
    timer = setTimeout(() => resolve([]), ms);
    timer.unref();
  });
  const work = async () => {
    const turn = (await deps.scan(id))?.open;
    return deps.offers(id, {
      startedAt: ulidTime(id) + (turn?.startMs ?? 0),
      reply,
      navigated: [...(turn?.navigated ?? [])],
      changed: [...(turn?.paths ?? [])],
    });
  };
  try {
    return await Promise.race([work(), late]);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
