// Everything the film says, in each of its languages: a short title to each feature, clear at a glance.
// The Chinese is written for the film, not translated. dot speaks only in its hello.
export interface Title {
  chunks: readonly string[];
}

export interface Copy {
  hello: Title;
  chat: Title;
  auto: Title;
  watch: Title;
  preview: Title;
  open: Title;
  studio: Title;
  several: Title;
  endLine: string;
}

export const COPY: Readonly<Record<"en" | "zh", Copy>> = {
  en: {
    hello: { chunks: ["Hi again.", "localDot got an update."] },
    chat: { chunks: ["Every task", "is a chat."] },
    auto: { chunks: ["Auto picks", "the right dot."] },
    watch: { chunks: ["Tap to watch", "it work."] },
    // A preview runs in dot's computer and opens, through localDot, in a new browser tab on the
    // owner's own computer or phone, over Tailscale.
    preview: { chunks: ["It runs on", "dot's computer."] },
    open: { chunks: ["Open it on", "your phone or desk."] },
    studio: { chunks: ["Studio, for", "your desk."] },
    several: { chunks: ["Many dots,", "all at once."] },
    endLine: "Free and open source. dot's computer and every recording stay on your machine.",
  },
  zh: {
    hello: { chunks: ["又见面了，", "localDot 更新了。"] },
    chat: { chunks: ["每个任务，", "都是一段聊天。"] },
    auto: { chunks: ["自动选择", "合适的 dot。"] },
    watch: { chunks: ["点一下，", "看它实时干活。"] },
    preview: { chunks: ["它在 dot 的电脑上运行，"] },
    open: { chunks: ["你用手机、电脑都能打开。"] },
    studio: { chunks: ["在电脑上，", "用 Studio。"] },
    several: { chunks: ["多个 dot，", "同时开工。"] },
    endLine: "免费开源。dot 的电脑和所有录像，都留在你自己的机器上。",
  },
};
