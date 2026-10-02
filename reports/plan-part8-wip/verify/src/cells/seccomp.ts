// Docker's default seccomp profile refuses unshare, and clone with namespace flags, to a container
// without CAP_SYS_ADMIN, and chroot without CAP_SYS_CHROOT; Chromium's namespace sandbox needs all
// three (user, PID and network namespaces, then a chroot). The browser cell drops every capability,
// so it runs on the default profile plus exactly this rule (P8-R4). Never --no-sandbox.
export const CHROMIUM_SANDBOX_RULE = {
  names: ["clone", "unshare", "chroot"],
  action: "SCMP_ACT_ALLOW",
  comment: "localDot: Chromium's namespace sandbox (user, pid and net namespaces, then chroot)",
} as const;

interface Profile {
  defaultAction: string;
  syscalls: { names: string[]; action: string }[];
  [key: string]: unknown;
}

export function chromiumProfile(dockerDefault: Profile): Profile {
  if (dockerDefault.defaultAction !== "SCMP_ACT_ERRNO")
    throw new Error("not Docker's default profile: its default action must be SCMP_ACT_ERRNO");
  return { ...dockerDefault, syscalls: [...dockerDefault.syscalls, { ...CHROMIUM_SANDBOX_RULE, names: [...CHROMIUM_SANDBOX_RULE.names] }] };
}
