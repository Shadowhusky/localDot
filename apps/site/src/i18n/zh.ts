import type { DayPart } from "@app/dot/tips.ts";
import type { PersonaId } from "@localdot/protocol";

// The site in Simplified Chinese, written for Chinese readers rather than carried over from the
// English: dot introduces itself and talks to the visitor the way a person would, in everyday words.
// Keyed by the English it stands for; a missing line shows in English. A headline too long for its
// column marks where its phrases part (\u200b), as Chinese has no spaces to break at.
export const ZH: Readonly<Record<string, string>> = {
  // The page.
  "localDot — an AI with a computer of its own": "localDot：有自己电脑的 AI 助手",
  "Meet dot: an open-source AI that does real work on a computer of its own, on yours. Watch it live, take over any time, use any model, and replay or export every task.":
    "dot 是一个开源 AI 助手，在你的电脑上有一台属于自己的电脑，替你完成实际的工作。你可以实时查看它的操作、随时接管，自由选择模型，每项任务都能回放并导出成视频。",
  Story: "目录",
  "Meet dot": "认识 dot",
  Watch: "直播",
  Models: "模型",
  Replay: "回放",
  Dots: "角色",
  "Get localDot": "安装 localDot",
  More: "更多",
  "An AI with a computer of its own.": "给 AI 一台自己的电脑。",
  intro:
    '下面是 dot 完成过的真实任务，录像已加速。选一个看看，或者先<a class="film-link" href="/film/localdot-film-zh.mp4" data-film>看一段短片</a>。',
  "A replay of localDot at work": "localDot 工作回放",
  "Talk to dot": "跟 dot 打个招呼",
  "localDot is open source under the MIT licence.": "localDot 采用 MIT 协议开源。",
  "Install guide": "安装说明",
  "The localDot film": "localDot 短片",
  "Close the film": "关掉短片",

  // Hi, I'm dot.
  "Hi, I'm dot.": "嗨，我是 dot。",
  "I do real work on a computer of my own, right on yours.":
    "我在你的电脑里有一台自己的小电脑。你交代的事，我来帮你做。",
  "Watch the film": "观看短片",

  // Watch me work.
  "Watch dot work": "观看 dot 工作",
  "Watch me work.": "监督我\u200b干活。",
  "Live, from your laptop or your phone. You see every click and keystroke as it happens.":
    "手机、电脑，随时查看。我点了哪里、输入了什么，你都看得清清楚楚。",
  "Step in any time.": "随时接管。",
  "Take control and the mouse is yours. Hand it back and I pick up where you left off.":
    "点「接管」就由你来操作，交还后我从你停下的地方接着做。",
  "Take control": "接管",
  "Hand back": "交还",
  "You decide how often I ask.": "问不问你，你说了算。",
  "How often dot asks": "dot 多久问你一次",
  Ask: "每次都问",
  Auto: "自动",
  "Full access": "完全放手",
  "I check with you before anything that changes something.": "只要会改动东西，我都先问你一声。",
  "Routine steps just happen. Anything risky waits for you.":
    "平常的操作我直接做，有风险的等你点头。",
  "I get on with it, and still ask before buying anything or deleting things online.":
    "我会直接完成任务，只在购物、删除网上内容之前问你。",

  // Use any model.
  "Use any model.": "什么模型都能用。",
  "models.body":
    "支持 {n} 家服务商的 API Key，也能直接用你的 ChatGPT 或 Claude 会员，还可以用你自己电脑上的本地模型。随时可以切换。",
  "Some of the models dot can use": "dot 支持的部分模型",
  "ChatGPT plan": "ChatGPT 会员",
  "Claude plan": "Claude 会员",

  // Rewind, then share.
  "Replay and export": "回放和导出",
  "Rewind anything.": "随时\u200b倒回去看。",
  "Every task is recorded, step by step. Scrub back to see exactly what I did.":
    "每一步都有迹可循。往回拖动，就能看到我当时是怎么做的。",
  "Share the good part.": "精彩片段，随手分享。",
  "Trim to the moment, speed it up as much as 16 times, add captions, and keep me under the picture or in its corner. Then save it as a video.":
    "想要哪段就剪哪段，最高 16 倍加速，可以配字幕，把我放在画面下方或角落，最后导出成视频。",
  "With captions": "带字幕",
  "Me under the picture": "我在画面下方",
  "Me in the corner": "我在角落",

  // A dot for every job.
  "A dot for every job.": "干什么活，就找什么 dot。",
  "Each one brings only the skills its work needs, so it stays focused and spends nothing on the rest.":
    "每个 dot 只配备本职工作需要的技能，更专注，也更省 token。",
  "The dots": "各种 dot",
  Everyday: "日常助手",
  Coder: "程序员",
  "Video editor": "剪辑师",
  Finance: "财务",
  Researcher: "研究员",
  Designer: "设计师",
  "It works on my machine.": "废话少说，放码过来。",
  "Citation needed.": "出处呢？",
  "Time is money.": "时间就是金钱。",
  "We'll fix it in post.": "没事，后期修。",
  "Happy to help.": "包在我身上。",
  "Learning new skills": "学新技能",
  "Office files": "文档",
  PDFs: "PDF",
  Images: "图片",
  "Web research": "查资料",
  "Media production": "多媒体制作",
  "Coding workflow": "写代码",
  "App previews": "预览应用",
  Debugging: "调 bug",
  "Backend and APIs": "后端与 API",
  "React performance": "React 性能优化",
  "Component design": "组件设计",
  "Front-end design": "前端设计",
  "Interface polish": "界面打磨",
  "Web app testing": "Web 应用测试",
  "MCP servers": "MCP 服务开发",
  "Video editing": "剪视频",
  Captions: "加字幕",
  "Data analysis": "数据分析",
  "Spreadsheet models": "表格建模",
  "Financial analysis": "财务分析",
  Bookkeeping: "记账",
  "Report writing": "写报告",
  "Visual design": "视觉设计",
  Slides: "做 PPT",
  "Pick yours.": "挑一个\u200b你喜欢的。",
  "Choose when you set up and change any time: just press me. Then give your localDot a look of its own.":
    "安装时先选一个，之后想换，点一下我就行。还可以给你的 localDot 挑个配饰。",
  Accessory: "配饰",
  None: "不戴",
  Cap: "帽子",
  Shades: "墨镜",
  Bow: "蝴蝶结",
  Star: "星星",

  // Open source, and yours.
  "Open source, and yours.": "开源，由你\u200b掌控全局。",
  "MIT licensed. The app, my computer and every recording stay on your machine, and your keys live in a local vault.":
    "代码采用 MIT 协议开源。应用、我的电脑和所有录像都保存在你自己的电脑上，API Key 也只存在本地。",
  "Read the code on GitHub": "在 GitHub 查看源代码",

  // Get localDot.
  "Get localDot.": "开始使用 localDot。",
  "One command sets up the app and my computer. Open the link it prints, pick a model, and give me something to do.":
    "只需一条命令，就能装好应用和我的电脑。打开安装后给出的链接，选好模型，就可以把任务交给我了。",
  "Your computer": "你的电脑",
  Copy: "复制",
  "Paste it in Terminal. It walks you through Docker if you don't have it yet.":
    "粘贴到终端运行即可。如果还没装 Docker，它会引导你一步步装好。",
  "Paste it in a terminal. It walks you through Docker if you don't have it yet.":
    "粘贴到终端运行即可。如果还没装 Docker，它会引导你一步步装好。",
  "Paste it in PowerShell. Windows support is in alpha.":
    "粘贴到 PowerShell 运行即可。Windows 版仍处于早期测试阶段。",
  "Copied. Paste it in your terminal.": "已复制，请到终端中粘贴运行。",
  "Select the command and copy it.": "无法自动复制，请选中命令手动复制。",
  "Read the install guide": "查看安装说明",

  // The app in the window.
  Chat: "对话",
  Activity: "过程",
  Mode: "模式",
  Conversation: "对话",
  "Hi, I'm dot. Pick a task and I'll show you how I did it.":
    "嗨，我是 dot。选一个任务，我演示给你看。",
  "Listening.": "我在听。",
  "That recording didn't load. Try another, or reload the page.":
    "这段录像没有加载出来，请换一个试试，或者刷新页面。",
  "Meet the dots for other jobs": "看看其他角色的 dot",
  "Pick something for me to do. Each one is a recording of a real task, sped up.":
    "选一个任务交给我。每个都是我实际完成过的任务，录像已加速。",
  "Make a Breakout game where you're the ball": "做个打砖块小游戏，你来当那个球",
  "Plan three autumn days in Kyoto": "秋天去京都玩三天，帮我做个攻略",
  "Make sense of my bank export": "帮我看看这份银行流水，钱都花哪儿了",
  "Design a poster for a jazz night": "给爵士之夜做张海报",
  "Cut a Reels teaser from a short film": "把这部短片剪成竖屏预告",
  "Breakout, starring dot": "打砖块，dot 主演",
  "Three autumn days in Kyoto": "京都秋游三日",
  "Where my money went": "钱都花哪儿了",
  "A poster for Blue Hour": "「蓝调时刻」海报",
  "A Reels teaser of Big Buck Bunny": "《大雄兔》竖屏预告",
  "Watch another task": "再看一个",
  "These are replays.": "这些都是回放。",
  "Real tasks dot did, sped up.": "dot 实际完成的任务，已加速播放。",
  "A replay.": "此任务为实机回放，",
  "A real task with {model}, sped up.": "使用模型：{model}",
  "You have control": "你正在操作",
  "Skipping to the game": "快进到游戏",
  "Back to the game": "回到游戏开头",
  Done: "已完成",
  "A recording of a real task, sped up": "真实任务的录像，加速播放",
  "Time into the task": "已用时间",
  Pause: "暂停",
  Play: "播放",
  "Breakout, yours to play: move the paddle with the pointer or the arrow keys, and launch with Space.":
    "打砖块，现在归你玩：用鼠标或方向键移动挡板，按空格发球。",
  "Recording of dot's screen: {title}": "dot 的屏幕录像：{title}",
  "dot's computer": "dot 的电脑",
  "This is a demo.": "这只是演示。",
  "In your own localDot, dot revises the file as you ask.":
    "装好 localDot 后，dot 就能按你的要求修改这个文件。",
  "In your own localDot, this saves the replay as a video.":
    "装好 localDot 后，点这里就能把回放导出成视频。",
};

// What dot says, by the time of day, as the app's empty chat greets you.
export const ZH_GREETINGS: Readonly<Record<DayPart, readonly string[]>> = {
  morning: [
    "早上好！今天想让我帮你做点什么？",
    "早呀。我和我的电脑都醒了。",
    "早上好。先把最烦的那件事交给我吧。",
  ],
  afternoon: [
    "下午好！有什么要我帮忙的？",
    "下午好。手头的活，分我一点？",
    "下午好。有没有又琐碎又费时间的事？交给我。",
  ],
  evening: [
    "晚上好。今天还有什么没弄完的吗？",
    "晚上好。下班前，要不要我顺手把事做了？",
    "晚上好。累了吧？剩下的交给我。",
  ],
  night: [
    "这么晚还没睡？要我帮你做点什么？",
    "夜深了，事情交给我，你早点休息。",
    "我夜里也不困，有活尽管说。",
  ],
};

// What each dot says when pressed: its own kind of work, in its own words.
export const ZH_LINES: Readonly<Record<PersonaId, readonly string[]>> = {
  everyday: [
    "填表、订票、整理文件这种杂事，我最拿手。",
    "那件你一直拖着没办的事，交给我吧。",
    "PDF 我看得懂，还能照着把表填好。",
  ],
  coder: [
    "改代码前我先看懂，改完跑一遍测试。",
    "提交拆小，说明写清楚，我从不 force push。",
    "把报错贴给我，bug 我来找。",
    "想看效果？我在浏览器里打开给你看。",
  ],
  video: [
    "原片我一帧不动，剪的都是副本。",
    "抖音要竖屏，B 站要横屏，你说发哪儿就行。",
    "导出的每一版，我都逐帧看过再给你。",
    "给我一段长视频，我把最值得看的 30 秒挑出来。",
  ],
  finance: [
    "我给的每个数字，都标着出处。",
    "用活公式，不贴死数字，表才靠得住。",
    "交给你之前，我会再算一遍。",
    "帮你分析没问题，理财建议我可不乱给。",
  ],
  research: [
    "关键的事，我至少找两个来源对一对。",
    "先说结论，再摆证据，出处都附上链接。",
    "一手的新资料，比转了好几手的旧文章靠谱。",
    "猜的就是猜的，没把握我会直说。",
  ],
  design: [
    "颜色少用几种，字号分好层次，版面才稳。",
    "对比度我按实际大小看，不放大了看。",
    "给你的是能改的源文件，不只是一张图。",
    "告诉我给谁看、用在哪儿，剩下的交给我。",
  ],
};
