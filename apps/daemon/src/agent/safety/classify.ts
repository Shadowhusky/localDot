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
// The long options of su and runuser that take a value.
const SWITCH_USER_LONG = /^--(?:user|group|supp-group|shell|whitelist-environment)$/;
// The nesting a command string may have (bash -c "eval '…'") before it counts as unclear.
const MAX_NESTING = 4;

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
    ["chroot", { long: /^--(?:userspec|groups)$/, operands: 1 }],
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
    ...(action.verb === "type" ? { newline: endsLine(action.text) } : {}),
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
    keys.some((key) => PATTERNS.enter.test(key) || endsLine(key)) ||
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

// A C0 control character other than Tab ends or runs a line: Enter is ^M and ^J, and bash runs the
// line on ^O.
function endsLine(text: string): boolean {
  return [...text].some((c) => c.charCodeAt(0) < 0x20 && c !== "\t");
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

interface Token {
  readonly kind: "word" | "operator" | "redirect";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

// The words and operators of a command line as the shell reads them: quotes and backslashes join a
// word, and only unquoted characters are operators. A substitution, even inside double quotes, opens
// a group of its own. A redirection is a `redirect` token before its target, which for a descriptor
// copy (2>&1) is the descriptor.
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const modes: ("quote" | "group" | "tick")[] = [];
  let word = "";
  let started = -1;
  const begin = (at: number) => {
    if (started < 0) started = at;
  };
  const flush = (at: number) => {
    if (started >= 0) tokens.push({ kind: "word", text: word, start: started, end: at });
    word = "";
    started = -1;
  };
  const emit = (kind: Token["kind"], text: string, at: number, length: number) => {
    flush(at);
    tokens.push({ kind, text, start: at, end: at + length });
  };
  for (let i = 0; i < source.length; ) {
    const c = source[i] ?? "";
    const rest = source.slice(i);
    const mode = modes.at(-1);
    if (mode === "quote") {
      if (c === '"') modes.pop();
      else if (rest.startsWith("$(")) {
        emit("operator", "(", i, 2);
        modes.push("group");
        i += 2;
        continue;
      } else if (c === "`") {
        emit("operator", "(", i, 1);
        modes.push("tick");
      } else if (c === "\\" && /^[$`"\\\n]/.test(source[i + 1] ?? "")) {
        begin(i);
        word += source[i + 1];
        i += 2;
        continue;
      } else {
        begin(i);
        word += c;
      }
      i++;
      continue;
    }
    if (c === "\\") {
      if (source[i + 1] !== "\n") {
        begin(i);
        word += source[i + 1] ?? "";
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      begin(i);
      const close = source.indexOf("'", i + 1);
      const end = close < 0 ? source.length : close;
      word += source.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      begin(i);
      modes.push("quote");
      i++;
      continue;
    }
    if (c === "`") {
      if (mode === "tick") modes.pop();
      else modes.push("tick");
      emit("operator", mode === "tick" ? ")" : "(", i, 1);
      i++;
      continue;
    }
    const opening = /^(?:\$\(|[<>]\(|\()/.exec(rest)?.[0];
    if (opening) {
      emit("operator", "(", i, opening.length);
      modes.push("group");
      i += opening.length;
      continue;
    }
    if (c === ")") {
      if (mode === "group") modes.pop();
      emit("operator", ")", i, 1);
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      flush(i);
      i++;
      continue;
    }
    if (endsLine(c)) {
      emit("operator", ";", i, 1);
      i++;
      continue;
    }
    const redirect = /^(?:&>>?|[<>]&|<<<|<<-?|<>|>>|>\||[<>])/.exec(rest)?.[0];
    if (redirect) {
      // Digits right before it name the descriptor, not a word.
      if (started >= 0 && /^\d+$/.test(source.slice(started, i))) {
        word = "";
        started = -1;
      }
      emit("redirect", redirect, i, redirect.length);
      i += redirect.length;
      continue;
    }
    const control = /^(?:&&|\|\||;;|\|&|[;&|])/.exec(rest)?.[0];
    if (control) {
      emit("operator", control, i, control.length);
      i += control.length;
      continue;
    }
    begin(i);
    word += c;
    i++;
  }
  flush(source.length);
  return tokens;
}

interface Stage {
  readonly words: readonly string[];
  // A here-string's text, which the stage reads as its input.
  readonly input?: string;
}
interface Line {
  readonly text: string;
  readonly stages: readonly Stage[];
}

// The commands of a command line, each a list of the stages its pipes, groups and substitutions
// separate, with redirections taken out.
function parse(source: string): Line[] {
  const lines: Line[] = [];
  let tokens: Token[] = [];
  const close = () => {
    const first = tokens[0];
    const last = tokens.at(-1);
    if (!first || !last) return;
    const stages: Stage[] = [];
    let words: string[] = [];
    let input: string | undefined;
    const end = () => {
      if (words.length) stages.push({ words, ...(input === undefined ? {} : { input }) });
      words = [];
      input = undefined;
    };
    for (let k = 0; k < tokens.length; k++) {
      const token = tokens[k];
      if (token?.kind === "operator") end();
      else if (token?.kind === "redirect") {
        const target = tokens[k + 1]?.kind === "word" ? tokens[++k] : undefined;
        if (token.text === "<<<" && target) input = target.text;
      } else if (token) words.push(token.text);
    }
    end();
    lines.push({ text: source.slice(first.start, last.end), stages });
    tokens = [];
  };
  for (const token of lex(source)) {
    if (token.kind === "operator" && [";", ";;", "&&", "||", "&"].includes(token.text)) close();
    else tokens.push(token);
  }
  close();
  return lines;
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

interface Run {
  readonly words: readonly string[];
  // Command strings the stage runs besides: a shell's -c string or here-string, eval's words, su's
  // -c string and find's -exec commands.
  readonly nested: readonly string[];
}

// The words a stage runs, after its assignments, shell keywords and wrappers.
function program(stage: Stage): Run {
  let tokens = stage.words;
  const nested: string[] = [];
  for (;;) {
    const first = tokens[0] ?? "";
    if (PATTERNS.assignment.test(first) || PATTERNS.keywords.test(first)) tokens = tokens.slice(1);
    // `coproc NAME { …; }` names the coprocess; otherwise coproc runs a plain command.
    else if (first === "coproc") tokens = tokens.slice(tokens[2] === "{" ? 2 : 1);
    else if (PATTERNS.headers.test(first)) tokens = tokens.slice(2);
    else {
      const name = base(first);
      const args = tokens.slice(1);
      if (name === "eval") nested.push(args.join(" "));
      if (name === "find") nested.push(...execs(args));
      if (name === "su" || name === "runuser") {
        const { code, command } = switchUser(args);
        if (code !== undefined) return { words: [], nested: [...nested, code] };
        if (!command) return { words: tokens, nested };
        tokens = command;
        continue;
      }
      if (interpreter(name) === SHELL) {
        const rest = unwrap(args, SHELL);
        if (rest)
          return { words: [], nested: rest[0] === undefined ? nested : [...nested, rest[0]] };
        if (stage.input !== undefined && readsProgram(tokens)) nested.push(stage.input);
        return { words: tokens, nested };
      }
      const options = PATTERNS.wrappers.get(name);
      const rest = options && unwrap(args, options);
      if (!rest) return { words: tokens, nested };
      tokens = rest;
    }
  }
}

// su and runuser read their options up to the first operand. -c runs a shell's command string and
// runuser -u runs the command after the options; past su's user, the words go to its shell.
function switchUser(args: readonly string[]): { code?: string; command?: readonly string[] } {
  let asUser = false;
  const after = (i: number) => {
    if (asUser) return { command: args.slice(i) };
    const code = unwrap(args.slice(i + 1), SHELL)?.[0];
    return code === undefined ? {} : { code };
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) return after(i);
    if (arg.startsWith("--")) {
      const [option = "", inline] = arg.split(/=(.*)/s, 2);
      if (option === "--command") return { code: inline ?? args[i + 1] ?? "" };
      if (option === "--user") asUser = true;
      if (inline === undefined && SWITCH_USER_LONG.test(option)) i++;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j] ?? "";
      const value = arg.slice(j + 1);
      if (flag === "c") return { code: value || (args[i + 1] ?? "") };
      if ("ugGsw".includes(flag)) {
        if (flag === "u") asUser = true;
        if (!value) i++;
        break;
      }
    }
  }
  return {};
}

// The commands find runs with -exec, -execdir, -ok and -okdir, each up to its ; or +.
function execs(args: readonly string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|ok)(?:dir)?$/.test(args[i] ?? "")) continue;
    const end = args.findIndex((arg, k) => k > i && (arg === ";" || arg === "+"));
    found.push(args.slice(i + 1, end < 0 ? undefined : end).join(" "));
    if (end < 0) break;
    i = end;
  }
  return found;
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
  for (const effect of effects(command, 0)) classes.add(effect);
  return [...classes];
}

function effects(command: string, depth: number): ActionClass[] {
  if (depth > MAX_NESTING) return ["unknown"];
  const found: ActionClass[] = [];
  for (const line of parse(command)) {
    const words = line.stages.flatMap((stage) => stage.words);
    if (PATTERNS.substitution.test(line.text) && remote(words)) found.push("download_execute");
    const runs = line.stages.map(program);
    runs.forEach((run, index) => {
      for (const code of run.nested) found.push(...effects(code, depth + 1));
      const effect = stageClass(run.words);
      if (effect) found.push(effect);
      const next = runs[index + 1];
      if (!next || !reads(next, depth)) return;
      const name = base(run.words[0]);
      if ((name === "curl" || name === "wget") && remote(run.words.slice(1)))
        found.push("download_execute");
      // echo "git push" | sh runs what it echoes.
      if ((name === "echo" || name === "printf") && interpreter(base(next.words[0])) === SHELL)
        found.push(...effects(echoed(run.words), depth + 1));
    });
  }
  return found;
}

// Whether a stage runs a program it reads from stdin, itself or in a command string it runs.
function reads(run: Run, depth: number): boolean {
  if (readsProgram(run.words)) return true;
  if (depth >= MAX_NESTING) return false;
  return run.nested.some((code) =>
    parse(code).some((line) => line.stages.some((stage) => reads(program(stage), depth + 1))),
  );
}

function echoed(tokens: readonly string[]): string {
  const args = tokens.slice(1);
  if (base(tokens[0]) === "printf") return (args.length > 1 ? args.slice(1) : args).join(" ");
  const start = args.findIndex((arg) => !/^-[neE]+$/.test(arg));
  return start < 0 ? "" : args.slice(start).join(" ");
}
