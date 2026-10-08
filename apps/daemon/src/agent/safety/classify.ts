import type { ActionClass, Target } from "@localdot/protocol";
import type { GuiAction } from "../../gateway/gateway.ts";
import type { NativeTargetFacts, RiskFacts } from "./risk.ts";

// Inside the computer the agent acts. Only a positive match here (a consequential name on a page, a
// command that reaches past the computer, a secret field) or an unidentified target on a signed-in
// screen lifts an action out of `computer`.
const PATTERNS = {
  names: [
    [
      "purchase",
      /\b(?:buy|pay|purchase|place\s+(?:your\s+)?order|check\s*out|subscribe|upgrade|donate)\b|购买|購買|支付|付款|下单|下單|结账|結帳/i,
    ],
    [
      "send",
      /\b(?:send|reply(?:\s+all)?|forward|invite)\b|发送|發送|回复|回覆|转发|轉寄|邀请|邀請/i,
    ],
    [
      "post",
      /\b(?:post|publish|share|comment|tweet|repost|retweet)\b|发布|發佈|發布|发表|發表|分享|评论|評論/i,
    ],
    ["delete", /\b(?:delete|remove|trash|erase|discard)\b|删除|刪除|移除/i],
  ] as const,
  commit: /\b(?:submit|save|update|apply|confirm|yes)\b|提交|保存|儲存|确认|確認|确定|確定/i,
  actionable: /button|link|menu ?item|submit/i,
  field:
    /^(?:ax)?(?:text|text ?box|text ?field|text ?area|search ?box|search ?field|combo ?box|entry|editable text|input|spin ?button|password text|secure ?text ?field)$/i,
  secretRole: /AXSecureTextField|password|secure/i,
  secretName:
    /密碼|密码|验证码|驗證碼|支付|付款|信用卡|登入|登录|登錄|password|passcode|passphrase|one[ -]?time|verification[ -]?code|2fa|captcha|credit[ -]?card|card[ -]?number|security[ -]?code|cvv|cvc|expiry|expiration|billing|payment|sign[ -]?in|log[ -]?in/i,
  search: /search|搜索|搜尋|\bfind\b|\bquery\b/i,
  enter: /^(?:return|enter|kp_enter)$/i,
  loopback: /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i,
  bareLoopback:
    /^(?:[^@\s/]+@)?(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?$/i,
  remotePath: /^(?:[^@\s/:]+@)?(\[[0-9a-f:]+\]|[^\s/:]+):/i,
  substitution:
    /(?:\b(?:ba|z|da|k)?sh|\beval|\bsource|(?:^|\s)\.)\s[^|;]*(?:<\(|\$\(|`)\s*(?:curl|wget)\b/,
  interpreter: /^(?:(?:ba|z|da|k|fi)?sh|python[\d.]*|node|perl|ruby|php)$/,
  installer:
    /^(?:(?:ba|z|da|k|fi)?sh|python[\d.]*|node|perl|ruby|php|chmod|dpkg|apt|apt-get|rpm|pip[\d.]*)$/,
  mail: /^(?:mail|mailx|sendmail|mutt|msmtp|ssmtp)$/,
  publish: new Map([
    ["npm", "publish"],
    ["pnpm", "publish"],
    ["yarn", "publish"],
    ["cargo", "publish"],
    ["twine", "upload"],
    ["gem", "push"],
    ["docker", "push"],
    ["podman", "push"],
  ]),
  ghPost: /^(?:create|comment|merge|edit|review|close|reopen)$/,
} as const;

export function classify(facts: RiskFacts): readonly ActionClass[] {
  switch (facts.operation) {
    case "observe":
    case "files_read":
      return ["reading"];
    case "wait":
    case "scroll":
      return ["browsing"];
    case "files_write":
    case "files_delete":
      return ["computer"];
    case "memory_write":
      return ["memory"];
    case "files_upload":
      return ["upload"];
    case "shell":
      return shell(facts.command ?? "");
    case "navigate":
      return navigation(facts);
    default:
      return input(facts);
  }
}

export function nativeActionFacts(action: GuiAction, target: Target | null): RiskFacts {
  if (action.verb === "wait" || action.verb === "scroll") return { operation: action.verb };
  return {
    operation: action.verb,
    ...(action.verb === "key" ? { keys: action.combo } : {}),
    ...(action.verb === "type" ? { newline: /[\r\n]/.test(action.text) } : {}),
    ...(target
      ? {
          target: {
            source: target.source,
            fresh: true,
            role: target.role,
            name: target.name,
            app: target.app,
            url: target.url,
            secret: target.secret === true,
          },
        }
      : {}),
  };
}

function named(text: string): ActionClass[] {
  return PATTERNS.names.filter(([, pattern]) => pattern.test(text)).map(([c]) => c);
}

function input(facts: RiskFacts): ActionClass[] {
  const target = facts.target;
  const identified =
    target?.fresh === true && (target.source === "ax" || target.source === "dom")
      ? target
      : undefined;
  if (identified && secret(identified)) return ["credentials"];
  const web = facts.screen === "browser" || target?.source === "dom" || isWebUrl(target?.url);
  const name = identified?.name ?? "";
  if (identified && (web || facts.signedIn) && PATTERNS.actionable.test(identified.role ?? "")) {
    const classes = named(name);
    if (classes.length) return classes;
    if (facts.signedIn && PATTERNS.commit.test(name)) return ["system_settings"];
  }
  if (!facts.signedIn) return ["computer"];
  if (!identified) return facts.operation === "type" && !facts.newline ? ["computer"] : ["unknown"];
  const submits =
    (facts.operation === "key" && facts.keys?.some((key) => PATTERNS.enter.test(key))) ||
    (facts.operation === "type" && facts.newline === true);
  const compose =
    PATTERNS.field.test(identified.role ?? "") &&
    !/search|combo/i.test(identified.role ?? "") &&
    !PATTERNS.search.test(name);
  return submits && compose ? ["send"] : ["computer"];
}

function secret(target: NativeTargetFacts): boolean {
  const role = target.role ?? "";
  return (
    target.secret === true ||
    PATTERNS.secretRole.test(role) ||
    (PATTERNS.field.test(role) && PATTERNS.secretName.test(target.name ?? ""))
  );
}

function isWebUrl(value: string | undefined): boolean {
  try {
    return value !== undefined && ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function navigation(facts: RiskFacts): ActionClass[] {
  let url: URL;
  try {
    url = new URL(facts.destination ?? "");
  } catch {
    return ["unknown"];
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    return ["unknown"];
  if (facts.signedIn) {
    const classes = named(decodePath(url.pathname).replace(/[-_/.+]+/g, " "));
    if (classes.length) return classes;
  }
  return ["browsing"];
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function words(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^["']+|["']+$/g, ""))
    .filter(Boolean);
}

// Drops wrappers that run the next word as the program.
function program(stage: string): string[] {
  const tokens = words(stage);
  while (
    tokens.length &&
    (/^(?:sudo|env|nohup|time|exec)$/.test(tokens[0] ?? "") || /^\w+=/.test(tokens[0] ?? ""))
  )
    tokens.shift();
  return tokens;
}

function base(token: string | undefined): string {
  return (token ?? "").split("/").pop() ?? "";
}

function hosts(tokens: readonly string[]): string[] {
  const found: string[] = [];
  for (const token of tokens) {
    for (const match of token.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi)) {
      try {
        found.push(new URL(match[0]).hostname);
      } catch {
        found.push(match[0]);
      }
    }
    if (PATTERNS.bareLoopback.test(token)) found.push("localhost");
  }
  return found;
}

// A command with no recognisable host may reach anywhere, such as a URL in a variable.
function remote(tokens: readonly string[]): boolean {
  const found = hosts(tokens);
  return found.length === 0 || found.some((host) => !PATTERNS.loopback.test(host));
}

function remoteDestination(tokens: readonly string[]): boolean {
  const last = tokens.filter((token) => !token.startsWith("-")).at(-1) ?? "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(last)) return remote([last]);
  const host = PATTERNS.remotePath.exec(last)?.[1];
  return host !== undefined && !PATTERNS.loopback.test(host);
}

function subcommand(tokens: readonly string[]): string | undefined {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token === "-C" || token === "-c") i++;
    else if (!token.startsWith("-")) return token;
  }
  return undefined;
}

// curl's short options that take a value, which may be attached (-XPUT) or the next word.
const CURL_VALUE_FLAGS = new Set("AbcCdDeEFHKmoPQrTtuUwxXyYz");

function curl(args: readonly string[]): ActionClass | undefined {
  const used = new Set<string>();
  let method = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      const [name = "", inline] = arg.slice(2).split("=", 2);
      if (name === "request") method = (inline ?? args[++i] ?? "").toUpperCase();
      else if (/^(?:data|json$)/.test(name)) used.add("d");
      else if (/^(?:form|upload-file$)/.test(name)) used.add("F");
      continue;
    }
    if (!arg.startsWith("-")) continue;
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j] ?? "";
      used.add(flag);
      if (!CURL_VALUE_FLAGS.has(flag)) continue;
      const value = arg.slice(j + 1) || args[++i] || "";
      if (flag === "X") method = value.toUpperCase();
      break;
    }
  }
  if (used.has("F") || used.has("T")) return "upload";
  if (method === "DELETE") return "delete";
  if (used.has("d") || ["POST", "PUT", "PATCH"].includes(method)) return "send";
  return undefined;
}

function wget(tokens: readonly string[]): ActionClass | undefined {
  const flags = tokens.join(" ");
  if (/--method[\s=]DELETE\b/i.test(flags)) return "delete";
  if (/--post-(?:data|file)|--body-(?:data|file)|--method[\s=](?:POST|PUT|PATCH)\b/i.test(flags))
    return "send";
  return undefined;
}

function stageClass(tokens: readonly string[]): ActionClass | undefined {
  const name = base(tokens[0]);
  const args = tokens.slice(1);
  if ((tokens[0] ?? "").includes("Downloads/")) return "download_execute";
  if (PATTERNS.installer.test(name) && args.some((arg) => arg.includes("Downloads/")))
    return "download_execute";
  if (PATTERNS.mail.test(name)) return "send";
  if (name === "curl") {
    const effect = curl(args);
    return effect && remote(args) ? effect : undefined;
  }
  if (name === "wget") {
    const effect = wget(args);
    return effect && remote(args) ? effect : undefined;
  }
  if ((name === "scp" || name === "rsync") && remoteDestination(args)) return "upload";
  if (name === "sftp" && remote(args.map((arg) => `sftp://${arg.replace(/^[^@]*@/, "")}`)))
    return "upload";
  if (name === "git" && subcommand(tokens) === "push") return "post";
  const publish = PATTERNS.publish.get(name);
  if (publish && subcommand(tokens) === publish) return "post";
  if (name === "gh") {
    if (args[1] === "delete") return "delete";
    if (
      ["pr", "issue", "release", "repo", "gist"].includes(args[0] ?? "") &&
      PATTERNS.ghPost.test(args[1] ?? "")
    )
      return "post";
  }
  return undefined;
}

function shell(command: string): ActionClass[] {
  const classes = new Set<ActionClass>(["computer"]);
  const commands = command.replace(/\d*>&\d*|&>/g, " ").split(/&&|\|\||[;\n]|&(?!&)/);
  for (const text of commands) {
    if (PATTERNS.substitution.test(text) && remote(words(text))) classes.add("download_execute");
    const stages = text
      .split(/\||[()`]|\$\(/)
      .map(program)
      .filter((stage) => stage.length);
    stages.forEach((stage, index) => {
      const effect = stageClass(stage);
      if (effect) classes.add(effect);
      const next = stages[index + 1];
      if (
        ["curl", "wget"].includes(base(stage[0])) &&
        next &&
        PATTERNS.interpreter.test(base(next[0])) &&
        remote(stage.slice(1))
      )
        classes.add("download_execute");
    });
  }
  return [...classes];
}
