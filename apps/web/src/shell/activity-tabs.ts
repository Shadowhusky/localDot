export type Tab = "steps" | "files" | "sources" | "agents" | "previews";
const KEY = "localdot.activity-tabs.v1";
const KEEP = 100;

function read(): Map<string, Tab> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(value)) return new Map();
    return new Map(
      value
        .slice(-KEEP)
        .filter(
          (entry): entry is [string, Tab] =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            ["steps", "files", "sources", "agents", "previews"].includes(entry[1]),
        ),
    );
  } catch {
    return new Map();
  }
}

export const activityTabs = {
  get: (owner: string) => read().get(owner),
  has: (owner: string) => read().has(owner),
  set(owner: string, tab: Tab) {
    const tabs = read();
    tabs.delete(owner);
    tabs.set(owner, tab);
    try {
      localStorage.setItem(KEY, JSON.stringify([...tabs].slice(-KEEP)));
    } catch {}
  },
};

type TabListener = (tab: Tab) => void;
const tabListeners = new Set<TabListener>();
let asked: Tab | null = null;

// Another part of the page asks Activity for a tab: at once while it is on the page, else as it
// comes.
export function showActivityTab(tab: Tab): void {
  asked = tabListeners.size ? null : tab;
  for (const listener of tabListeners) listener(tab);
}
export function onActivityTab(listener: TabListener): () => void {
  tabListeners.add(listener);
  if (asked) listener(asked);
  asked = null;
  return () => {
    tabListeners.delete(listener);
  };
}
