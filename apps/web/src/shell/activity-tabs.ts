type Tab = "steps" | "files" | "sources" | "agents";
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
            ["steps", "files", "sources", "agents"].includes(entry[1]),
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
