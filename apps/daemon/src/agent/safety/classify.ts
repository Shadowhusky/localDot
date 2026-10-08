import type { ActionClass, Target } from "@localdot/protocol";
import type { GuiAction } from "../../gateway/gateway.ts";
import type { NativeTargetFacts, RiskFacts } from "./risk.ts";

// The options of a wrapper or interpreter: short (`value`) and long (`long`) ones whose value may be
// the next word, operands before the program, and options that carry the program itself (`code`,
// `codeLong`) or read it from stdin.
interface Options {
  readonly value?: string;
  readonly long?: RegExp;
  readonly operands?: number;
  readonly code?: string;
  readonly codeLong?: RegExp;
  readonly stdin?: string;
}

const SHELL: Options = { code: "c", value: "oO", stdin: "s", long: /^--(?:rcfile|init-file)$/ };

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
  searchRole: /search|combo/i,
  secretRole: /AXSecureTextField|password|secure/i,
  secretName:
    /密碼|密码|验证码|驗證碼|支付|付款|信用卡|登入|登录|登錄|password|passcode|passphrase|one[ -]?time|verification[ -]?code|2fa|captcha|credit[ -]?card|card[ -]?number|security[ -]?code|cvv|cvc|expiry|expiration|billing|payment|sign[ -]?in|log[ -]?in/i,
  search: /search|搜索|搜尋|\bfind\b|\bquery\b/i,
  enter: /^(?:return|enter|kp_enter)$/i,
  terminal: /terminal/i,
  ctrl: /^(?:ctrl|control(?:_l)?)$/i,
  shift: /^shift(?:_l)?$/i,
  loopback: /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i,
  bareLoopback:
    /^(?:[^@\s/]+@)?(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?$/i,
  remotePath: /^(?:[^@\s/:]+@)?(\[[0-9a-f:]+\]|[^\s/:]+):/i,
  assignment: /^\w+=/,
  // A redirection before the program, with its target attached (2>/dev/null) or as the next word.
  redirect: /^\d*[<>]+(.*)$/,
  // Reserved words that open or continue a compound command: the command follows them.
  keywords: /^(?:if|then|elif|else|do|while|until|!|\{)$/,
  // These name a word before what they run (`for x do …`, `function f { …`); `for x in a b` only
  // lists words.
  headers: /^(?:for|select|function)$/,
  substitution:
    /(?:\b(?:ba|z|da|k)?sh|\beval|\bsource|(?:^|\s)\.)\s[^|;]*(?:<\(|\$\(|`)\s*(?:curl|wget)\b/,
  wrappers: new Map<string, Options>([
    [
      "sudo",
      {
        value: "ugpCDrtTUR",
        long: /^--(?:user|group|host|prompt|close-from|chdir|role|type|command-timeout|other-user)$/,
      },
    ],
    ["doas", { value: "uaC" }],
    ["env", { value: "uCP", long: /^--(?:unset|chdir)$/ }],
    ["timeout", { value: "sk", long: /^--(?:signal|kill-after)$/, operands: 1 }],
    ["nice", { value: "n", long: /^--adjustment$/ }],
    ["ionice", { value: "cnpPu", long: /^--(?:class|classdata|pid|pgid|uid)$/ }],
    ["stdbuf", { value: "ioe", long: /^--(?:input|output|error)$/ }],
    ["nohup", {}],
    ["setsid", {}],
    ["time", { value: "fo", long: /^--(?:format|output)$/ }],
    ["command", {}],
    ["builtin", {}],
    ["eval", {}],
    ["exec", { value: "a" }],
    [
      "xargs",
      {
        value: "aIdELnPs",
        long: /^--(?:arg-file|delimiter|max-args|max-procs|max-chars|process-slot-var)$/,
      },
    ],
  ]),
  interpreters: [
    [/^(?:ba|z|da|k|fi)?sh$/, SHELL],
    [/^python[\d.]*$/, { code: "cm", value: "WX" }],
    [
      /^node$/,
      {
        code: "cep",
        codeLong: /^--(?:eval|print|check)$/,
        value: "rC",
        long: /^--(?:require|import|loader|experimental-loader|conditions|title|env-file)$/,
      },
    ],
    [/^perl$/, { code: "eE", value: "IMm" }],
    [/^ruby$/, { code: "e", value: "rICEF" }],
    [/^php$/, { code: "rfRF", value: "cdzBE" }],
  ] as readonly (readonly [RegExp, Options])[],
  stdinPath: /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/,
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
  // curl's short options that take a value, which may be attached (-XPUT) or the next word.
  curlValue: new Set("AbcCdDeEFHKmoPQrTtuUwxXyYz"),
  curlSend: /^(?:data|json$)/,
  curlUpload: /^(?:form|upload-file$)/,
  wgetDelete: /--method[\s=]DELETE\b/i,
  wgetSend: /--post-(?:data|file)|--body-(?:data|file)|--method[\s=](?:POST|PUT|PATCH)\b/i,
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
      return facts.signedIn ? ["computer", "unknown"] : ["computer"];
    case "memory_write":
      return ["memory"];
    case "files_upload":
      return ["upload"];
    case "shell":
      return shell(facts.command ?? "", facts.signedIn === true);
    case "navigate":
      return navigation(facts);
    default:
      return input(facts);
  }
}

export function nativeActionFacts(action: GuiAction, target: Target | null): RiskFacts {
  if (action.verb === "wait" || action.verb === "scroll") return { operation: action.verb };
  const terminal = PATTERNS.terminal.test(target?.role ?? "");
  return {
    operation: action.verb,
    ...(action.verb === "key" ? { keys: action.combo } : {}),
    ...(action.verb === "type" ? { newline: /[\r\n]/.test(action.text) } : {}),
    ...(action.verb === "type" && terminal ? { command: action.text } : {}),
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
  const terminal = PATTERNS.terminal.test(identified.role ?? "");
  const keys = facts.operation === "key" ? (facts.keys ?? []) : [];
  const submits =
    keys.some((key) => PATTERNS.enter.test(key)) ||
    (terminal && runsLine(keys)) ||
    (facts.operation === "type" && facts.newline === true);
  // A line run in a terminal is a command that can drive the signed-in browser, like the shell
  // tool's. A key runs a line it cannot read.
  if (terminal && submits)
    return facts.command === undefined ? ["unknown"] : shell(facts.command, true);
  const compose =
    PATTERNS.field.test(identified.role ?? "") &&
    !PATTERNS.searchRole.test(identified.role ?? "") &&
    !PATTERNS.search.test(name);
  return submits && compose ? ["send"] : ["computer"];
}

// Besides Enter, a terminal runs its line on ctrl+J, ctrl+M or ctrl+O, and on a paste that ends a
// line.
function runsLine(keys: readonly string[]): boolean {
  const has = (pattern: RegExp) => keys.some((key) => pattern.test(key));
  const ctrl = has(PATTERNS.ctrl);
  const shift = has(PATTERNS.shift);
  return (ctrl && has(/^[jmo]$/i)) || (ctrl && shift && has(/^v$/i)) || (shift && has(/^insert$/i));
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

function base(token: string | undefined): string {
  return (token ?? "").split("/").pop() ?? "";
}

function interpreter(name: string): Options | undefined {
  return PATTERNS.interpreters.find(([pattern]) => pattern.test(name))?.[1];
}

// The words after a wrapper's options. A shell wraps only with -c (otherwise it runs a script or
// stdin); the words of its command string follow, since the stage was split into plain words.
function unwrap(args: readonly string[], options: Options): string[] | undefined {
  let operands = options.operands ?? 0;
  let code = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && options.long?.test(arg)) i++;
    } else if (/^[-+]/.test(arg)) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j] ?? "";
        if (options.code?.includes(flag)) code = true;
        if (options.value?.includes(flag)) {
          if (j === arg.length - 1) i++;
          break;
        }
      }
    } else if (operands-- <= 0) break;
  }
  return options.code && !code ? undefined : args.slice(i);
}

// The words a stage runs, after its assignments, redirections, shell keywords and wrappers.
function program(stage: string): string[] {
  let tokens = words(stage);
  for (;;) {
    const first = tokens[0] ?? "";
    const redirect = PATTERNS.redirect.exec(first);
    if (redirect) tokens = tokens.slice(redirect[1] ? 1 : 2);
    else if (PATTERNS.assignment.test(first) || PATTERNS.keywords.test(first))
      tokens = tokens.slice(1);
    // `coproc NAME { …; }` names the coprocess; otherwise coproc runs a plain command.
    else if (first === "coproc") tokens = tokens.slice(tokens[2] === "{" ? 2 : 1);
    else if (PATTERNS.headers.test(first)) tokens = tokens.slice(2);
    else {
      const name = base(first);
      const options =
        PATTERNS.wrappers.get(name) ?? (interpreter(name) === SHELL ? SHELL : undefined);
      const rest = options && unwrap(tokens.slice(1), options);
      if (!rest) return tokens;
      tokens = rest;
    }
  }
}

// Whether an interpreter takes its program from stdin: no option names the code and no script
// operand is given, other than stdin itself.
function readsProgram(tokens: readonly string[]): boolean {
  const options = interpreter(base(tokens[0]));
  if (!options) return false;
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i] ?? "";
    if (PATTERNS.stdinPath.test(arg)) return true;
    if (arg === "--")
      return i + 1 === tokens.length || PATTERNS.stdinPath.test(tokens[i + 1] ?? "");
    if (arg.startsWith("--")) {
      const [option = ""] = arg.split("=", 1);
      if (options.codeLong?.test(option)) return false;
      if (!arg.includes("=") && options.long?.test(arg)) i++;
      continue;
    }
    if (!/^[-+]./.test(arg)) return false;
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j] ?? "";
      if (options.code?.includes(flag)) return false;
      if (options.stdin?.includes(flag)) return true;
      if (options.value?.includes(flag)) {
        if (j === arg.length - 1) i++;
        break;
      }
    }
  }
  return true;
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

function curl(args: readonly string[]): ActionClass | undefined {
  const used = new Set<string>();
  let method = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      const [name = "", inline] = arg.slice(2).split("=", 2);
      if (name === "request") method = (inline ?? args[++i] ?? "").toUpperCase();
      else if (name === "get") used.add("G");
      else if (PATTERNS.curlSend.test(name)) used.add("d");
      else if (PATTERNS.curlUpload.test(name)) used.add("F");
      continue;
    }
    if (!arg.startsWith("-")) continue;
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j] ?? "";
      used.add(flag);
      if (!PATTERNS.curlValue.has(flag)) continue;
      const value = arg.slice(j + 1) || args[++i] || "";
      if (flag === "X") method = value.toUpperCase();
      break;
    }
  }
  if (used.has("F") || used.has("T")) return "upload";
  if (method === "DELETE") return "delete";
  // -G sends the data as a query string on a GET.
  if ((used.has("d") && !used.has("G")) || ["POST", "PUT", "PATCH"].includes(method)) return "send";
  return undefined;
}

function wget(tokens: readonly string[]): ActionClass | undefined {
  const flags = tokens.join(" ");
  if (PATTERNS.wgetDelete.test(flags)) return "delete";
  if (PATTERNS.wgetSend.test(flags)) return "send";
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

// On a signed-in desktop any command can drive the signed-in browser (xdotool, XTest, DevTools).
function shell(command: string, signedIn: boolean): ActionClass[] {
  const classes = new Set<ActionClass>(signedIn ? ["computer", "unknown"] : ["computer"]);
  // A descriptor copy (2>&1) is dropped and a file redirect (&>f, >&f) kept, so neither splits on &.
  const commands = command
    .replace(/\|&/g, "|")
    .replace(/\d*[<>]&(?:\d+|-)/g, " ")
    .replace(/&>|>&/g, ">")
    .split(/&&|\|\||[;\r\n]|&(?!&)/);
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
        readsProgram(next) &&
        remote(stage.slice(1))
      )
        classes.add("download_execute");
    });
  }
  return [...classes];
}
