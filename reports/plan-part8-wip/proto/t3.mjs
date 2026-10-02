import { launch, wait } from "./cdp.mjs";
const c = launch({ extra: ["--auto-open-devtools-for-tabs"] });
await wait(3000);
const { targetInfos } = await c.send("Target.getTargets");
for (const t of targetInfos) console.log(t.type, t.url.slice(0, 80), "|", t.title.slice(0, 60));
const dt = targetInfos.find((t) => t.url.startsWith("devtools://"));
if (dt) {
  const { sessionId } = await c.send("Target.attachToTarget", { targetId: dt.targetId, flatten: true });
  try {
    const ax = await c.send("Accessibility.getFullAXTree", {}, sessionId);
    console.log("devtools AX nodes", ax.nodes.length, ax.nodes.slice(0, 12).map((n) => `${n.role?.value}:${(n.name?.value ?? "").slice(0, 40)}`).join(" | "));
  } catch (e) { console.log("ax err", e.message); }
}
c.proc.kill("SIGKILL");
