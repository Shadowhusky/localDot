import { Dot } from "@app/dot/Dot.tsx";
import { Chip } from "@app/ui/Chip.tsx";
import { outfit } from "@localdot/protocol";
import { t } from "../i18n.ts";
import { DEMOS, type DemoEntry } from "./catalog.ts";

// After a task, what else dot did: the other demos, as the app offers what to try next.
export function TryNext({ current, onPick }: { current: string; onPick(entry: DemoEntry): void }) {
  return (
    <fieldset className="site-next">
      <legend className="sr-only">{t("Watch another task")}</legend>
      {DEMOS.filter((entry) => entry.id !== current).map((entry) => (
        <Chip
          key={entry.id}
          variant="outline"
          className="site-next-chip"
          onClick={() => onPick(entry)}
        >
          <Dot size={20} wearables={outfit(entry.persona)} />
          {t(entry.ask)}
        </Chip>
      ))}
    </fieldset>
  );
}
