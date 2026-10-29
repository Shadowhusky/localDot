import { z } from "zod";
import { Sealed } from "./keyd.ts";

// Several dots on one computer: each has its own home, ports, key service and computer, and one
// installation runs them all. <home>/instance.json describes one; a home without it is the
// installation's first dot with today's fixed ports and Keychain service.
export const DOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
export const DotId = z.string().regex(DOT_ID_PATTERN);
export const MAIN_DOT_ID = "main";

export const DotName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((name) => !/[\p{Cc}<>]/u.test(name), "Use letters, numbers and punctuation");

const Port = z.number().int().min(1024).max(65535);
export const DotPortRange = z
  .tuple([Port, Port])
  .refine(([first, last]) => first <= last, "The first port comes before the last");
export type DotPortRange = z.infer<typeof DotPortRange>;

export const DotPorts = z
  .strictObject({ app: Port, tool: Port, keyd: DotPortRange, preview: DotPortRange })
  .refine((ports) => {
    const spans: DotPortRange[] = [
      [ports.app, ports.app],
      [ports.tool, ports.tool],
      ports.keyd,
      ports.preview,
    ];
    return spans.every((a, i) => spans.every((b, j) => i === j || a[1] < b[0] || b[1] < a[0]));
  }, "A dot's ports must not overlap");
export type DotPorts = z.infer<typeof DotPorts>;

export const DEFAULT_DOT_PORTS: DotPorts = {
  app: 4750,
  tool: 4751,
  keyd: [4760, 4789],
  preview: [4900, 4915],
};

// keyd's Keychain (and keyring) service. The first dot keeps the name keyd has always used.
export const KEYCHAIN_SERVICE = "localdot-keyd";
export const KeychainService = z.string().regex(/^localdot-keyd(\.[a-z][a-z0-9-]{0,23})?$/);
export const keychainServiceFor = (id: string) =>
  id === MAIN_DOT_ID ? KEYCHAIN_SERVICE : `${KEYCHAIN_SERVICE}.${id}`;

const HttpsOrigin = z
  .string()
  .max(256)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  }, "An https origin");

export const DotInstance = z.strictObject({
  v: z.literal(1),
  id: DotId,
  name: DotName,
  ports: DotPorts,
  keychainService: KeychainService,
  // HTTPS fronts that reach this dot from other devices, such as Tailscale Serve on its app port.
  publicOrigins: z.array(HttpsOrigin).max(4).optional(),
});
export type DotInstance = z.infer<typeof DotInstance>;

// What a new dot can take from an existing one. Its identity and sign-in token, remote-access
// identity, phone notification subscriptions, ChatGPT and Claude Code sign-ins, and key audit and
// spending records are never copied.
export const COPY_CATEGORIES = [
  "settings",
  "keys",
  "memory",
  "skills",
  "connectors",
  "conversations",
  "computer",
  "signins",
] as const;
export const CopyCategory = z.enum(COPY_CATEGORIES);
export type CopyCategory = z.infer<typeof CopyCategory>;
export const DEFAULT_COPY: readonly CopyCategory[] = [
  "settings",
  "keys",
  "memory",
  "skills",
  "connectors",
];

export const DotState = z.enum(["running", "stopped", "unknown"]);
export type DotState = z.infer<typeof DotState>;

export const DotSummary = z.strictObject({
  id: DotId,
  name: DotName,
  port: Port,
  // The dot answering this request.
  self: z.boolean(),
  // The installation's first dot, which only uninstalling removes.
  main: z.boolean(),
  state: DotState,
});
export type DotSummary = z.infer<typeof DotSummary>;

export const DotsReply = z.strictObject({
  dots: z.array(DotSummary).max(64),
  // Whether this installation can add, remove, start and stop dots from the app.
  manage: z.boolean(),
});
export type DotsReply = z.infer<typeof DotsReply>;

export const AddDotRequest = z.strictObject({
  name: DotName,
  from: DotId.optional(),
  copy: z.array(CopyCategory).max(COPY_CATEGORIES.length),
});
export type AddDotRequest = z.infer<typeof AddDotRequest>;

export const DOT_JOB_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const DotJob = z.strictObject({
  id: z.string().regex(DOT_JOB_PATTERN),
  kind: z.enum(["add", "remove", "start", "stop"]),
  state: z.enum(["running", "needs-passphrase", "done", "failed"]),
  // What it is doing now, in a few words.
  step: z.string().max(200).optional(),
  error: z.string().max(500).optional(),
  // While it needs a passphrase: the new dot's key service key, which the passphrase is sealed to.
  sealKey: z.string().max(200).optional(),
  // The dot it acted on, once known.
  dot: DotId.optional(),
});
export type DotJob = z.infer<typeof DotJob>;

export const DotPassphrase = z.strictObject({ sealed: Sealed });
export type DotPassphrase = z.infer<typeof DotPassphrase>;

export const RemoveDotRequest = z.strictObject({ deleteData: z.boolean() });
export type RemoveDotRequest = z.infer<typeof RemoveDotRequest>;
export const RemoveDotReply = z.strictObject({
  job: DotJob.optional(),
  // Removing the dot that answers: a one-use sign-in to another dot, to go to before it stops.
  next: z.string().max(512).optional(),
});
export type RemoveDotReply = z.infer<typeof RemoveDotReply>;

// What a dot tells another dot on this computer: whether an update or a stop would interrupt its
// work, and the HTTPS addresses other devices reach it at.
export const DotSelf = z.strictObject({
  busy: z.boolean(),
  origins: z.array(z.string().max(256)).max(8),
});
export type DotSelf = z.infer<typeof DotSelf>;

// A one-use sign-in to another dot on this computer, at the address that suits this browser.
export const DotSignIn = z.strictObject({ url: z.string().max(512) });
export type DotSignIn = z.infer<typeof DotSignIn>;
