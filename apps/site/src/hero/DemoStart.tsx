import { Dot } from "@app/dot/Dot.tsx";
import { dayPart } from "@app/dot/idle-line.ts";
import { VOICES } from "@app/dot/voices.ts";
import { outfit, personaOf } from "@localdot/protocol";
import { ZH_GREETINGS } from "../i18n/zh.ts";
import { LANG, t } from "../i18n.ts";
import { DEMOS, type DemoEntry } from "./catalog.ts";

const greeting = () => {
  const part = dayPart(new Date().getHours());
  const lines = LANG === "zh" ? ZH_GREETINGS[part] : VOICES.everyday.greetings[part];
  return lines[new Date().getDate() % lines.length] ?? "";
};

// The empty chat, as the app opens, offering the tasks dot really did: each one, done by the dot
// for that job, plays from its recording when chosen.
export function DemoStart({
  onPick,
  current,
}: {
  onPick(entry: DemoEntry): void;
  current?: string;
}) {
  return (
    <div className="thread-empty site-start">
      <h3>{greeting()}</h3>
      <p>{t("Pick something for me to do. Each one is a recording of a real task, sped up.")}</p>
      <ul className="site-demos">
        {DEMOS.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className="site-demo"
              aria-current={current === entry.id || undefined}
              onClick={() => onPick(entry)}
            >
              <Dot size={34} wearables={outfit(entry.persona)} />
              <span className="site-demo-ask">{t(entry.ask)}</span>
              <span className="site-demo-who">{t(personaOf(entry.persona).name)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
