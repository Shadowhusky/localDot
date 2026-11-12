import { RecordingStorage } from "@localdot/protocol";
import { useEffect, useState } from "react";
import { bytes, count } from "../copy/format.ts";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";

// What the task videos and screenshots take on this computer, and when they go.
export function RecordingStorageSettings({ api }: { api: ApiClient }) {
  const [storage, setStorage] = useState<RecordingStorage | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api
      .get("/api/recordings/storage", { signal: controller.signal })
      .then((value) => setStorage(RecordingStorage.parse(value)))
      .catch(() => {});
    return () => controller.abort();
  }, [api]);
  if (!storage) return null;
  return (
    <div>
      <GroupHead title={t`Recordings`} />
      <Group>
        <GroupRow
          leading={<IconTile icon="play" />}
          label={t`Task videos`}
          detail={
            storage.savedBytes > 0
              ? t`${count(storage.videos, "video", "videos")} · ${bytes(storage.savedBytes)} saved by re-encoding`
              : count(storage.videos, "video", "videos")
          }
          trailing={bytes(storage.bytes)}
        />
        <GroupRow
          leading={<IconTile icon="monitor" />}
          label={t`Screenshots`}
          detail={t`What dot saw at each step`}
          trailing={bytes(storage.framesBytes)}
        />
      </Group>
      <GroupNote>
        {[
          storage.maxAgeDays === 1
            ? t`Videos are kept for ${storage.maxAgeDays} day and up to ${bytes(storage.maxBytes)} in all, oldest removed first.`
            : t`Videos are kept for ${storage.maxAgeDays} days and up to ${bytes(storage.maxBytes)} in all, oldest removed first.`,
          storage.framesMaxAgeDays === 1
            ? t`Screenshots stay for ${storage.framesMaxAgeDays} day, then only each task's cover is kept.`
            : t`Screenshots stay for ${storage.framesMaxAgeDays} days, then only each task's cover is kept.`,
          t`Steps and messages always stay. Finished videos are re-encoded in the background to take less space.`,
        ].join(" ")}
      </GroupNote>
    </div>
  );
}
