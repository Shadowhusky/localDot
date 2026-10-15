import type { PersonaId } from "@localdot/protocol";

// Everything the film says, in each of its languages. A title comes in a chunk at a time on the beat:
// English a word to a chunk, Chinese a phrase, so each chunk still reads as it lands. The Chinese is
// written for the film, not translated: short, active, and said the way a person would say it.
export interface Copy {
  hello: Title;
  watch: Title;
  step: Title;
  models: Title;
  jobs: Title;
  rewind: Title;
  share: Title;
  yours: Title;
  take: string;
  save: string;
  saved: string;
  cards: readonly [string, string, string];
  endLine: string;
  credit: string;
  // dot's line under the Theatre, and each demo's name there through the montage.
  line: string | null;
  montage: readonly string[] | null;
  roles: Partial<Record<PersonaId, { name: string; motto: string }>>;
  // The ring's names that are words rather than names.
  ring: Readonly<Record<string, string>>;
}

interface Title {
  chunks: readonly string[];
  line?: string;
}

export const COPY: Readonly<Record<"en" | "zh", Copy>> = {
  en: {
    hello: { chunks: ["Hi,", "I'm", "dot."], line: "I do real work on a computer of my own." },
    watch: { chunks: ["Watch", "me", "work."], line: "Live, from your laptop or your phone." },
    step: {
      chunks: ["Step", "in", "any", "time."],
      line: "Take control, then hand it back. I pick up where you left off.",
    },
    models: {
      chunks: ["Use", "any", "model."],
      line: "25 providers, your ChatGPT or Claude plan, or your own machine.",
    },
    jobs: { chunks: ["A", "dot", "for", "every", "job."] },
    rewind: { chunks: ["Rewind", "anything."], line: "Every task is recorded." },
    share: {
      chunks: ["Share", "the", "good", "part."],
      line: "Trim it, speed it up, add captions.",
    },
    yours: {
      chunks: ["Open", "source,", "and", "yours."],
      line: "MIT licensed. Runs on your machine.",
    },
    take: "Take control",
    save: "Save video",
    saved: "✓ Saved",
    cards: ["With captions", "Me under the picture", "Me in the corner"],
    endLine: "Free and open source. For macOS, Windows and Linux.",
    credit: "Teaser footage: Big Buck Bunny, Blender Foundation, CC BY 3.0",
    line: null,
    montage: null,
    roles: {},
    ring: {},
  },
  zh: {
    hello: { chunks: ["嗨，", "我是", "dot。"], line: "你交代的事，我来帮你做。" },
    watch: { chunks: ["监督我", "干活。"], line: "手机、电脑，随时查看。" },
    step: { chunks: ["随时", "接管。"], line: "你来操作，交还后我接着做。" },
    models: {
      chunks: ["什么模型", "都能用。"],
      line: "支持 25 家服务商、ChatGPT 和 Claude 会员，也支持本地模型。",
    },
    jobs: { chunks: ["干什么活，", "就找", "什么 dot。"] },
    rewind: { chunks: ["随时", "倒回去看。"], line: "每一步都有迹可循。" },
    share: { chunks: ["精彩片段，", "随手分享。"], line: "可以剪辑、加速，还能配字幕。" },
    yours: { chunks: ["开源，", "由你掌控全局。"], line: "MIT 协议开源，跑在你自己的电脑上。" },
    take: "接管",
    save: "保存视频",
    saved: "✓ 已保存",
    cards: ["带字幕", "我在画面下方", "我在角落"],
    endLine: "免费开源，macOS、Windows、Linux 都能用。",
    credit: "预告片素材：《大雄兔》，Blender 基金会，CC BY 3.0",
    line: "在浏览器里打通一整局",
    montage: ["做个小游戏", "规划京都行程", "整理一下账单", "做张爵士海报", "剪个竖屏预告"],
    roles: {
      coder: { name: "程序员", motto: "废话少说，放码过来。" },
      research: { name: "研究员", motto: "出处呢？" },
      finance: { name: "财务", motto: "时间就是金钱。" },
      video: { name: "剪辑师", motto: "没事，后期修。" },
      design: { name: "设计师", motto: "Voilà. C'est magnifique." },
    },
    ring: { "ChatGPT plan": "ChatGPT 会员", "Claude plan": "Claude 会员" },
  },
};
