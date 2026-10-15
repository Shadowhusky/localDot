import type { Accessory } from "@localdot/protocol";
import { t } from "../i18n.ts";
import { onSite, type Permission, setSite, site } from "../state.ts";

const PERMISSION_COPY: Record<Permission, string> = {
  ask: t("I check with you before anything that changes something."),
  auto: t("Routine steps just happen. Anything risky waits for you."),
  full: t("I get on with it, and still ask before buying anything or deleting things online."),
};

const INSTALL: Record<string, { command: string; note: string }> = {
  mac: {
    command: "curl -fsSL https://downloads.localdot.dev/install.sh | bash",
    note: t("Paste it in Terminal. It walks you through Docker if you don't have it yet."),
  },
  linux: {
    command: "curl -fsSL https://downloads.localdot.dev/install.sh | bash",
    note: t("Paste it in a terminal. It walks you through Docker if you don't have it yet."),
  },
  windows: {
    command: "irm https://downloads.localdot.dev/install.ps1 | iex",
    note: t("Paste it in PowerShell. Windows support is in alpha."),
  },
};

// A group's choice, as it changes and as the page opens: a browser may restore a choice made before
// a reload.
function radios(root: HTMLElement, name: string, pick: (value: string) => void): void {
  for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
    input.addEventListener("change", () => {
      if (input.checked) pick(input.value);
    });
    if (input.checked) pick(input.value);
  }
}

// The story's own controls: they change what the app and dot show.
export function wireControls(root: HTMLElement): void {
  const control = root.querySelector<HTMLButtonElement>('[data-act="control"]');
  const label = () => {
    if (control) control.textContent = site.control === "you" ? t("Hand back") : t("Take control");
  };
  control?.addEventListener("click", () =>
    setSite({ control: site.control === "you" ? "dot" : "you" }),
  );
  onSite(label);
  const permissionCopy = root.querySelector<HTMLElement>("[data-permission-copy]");
  radios(root, "permission", (value) => {
    setSite({ permission: value as Permission });
    if (permissionCopy) permissionCopy.textContent = PERMISSION_COPY[value as Permission];
  });
  radios(root, "accessory", (value) =>
    setSite({ accessory: (value || undefined) as Accessory | undefined }),
  );
  const command = root.querySelector<HTMLElement>("[data-command]");
  const note = root.querySelector<HTMLElement>("[data-install-note]");
  radios(root, "os", (os) => {
    const choice = INSTALL[os];
    if (!choice) return;
    if (command) command.textContent = choice.command;
    if (note) note.textContent = choice.note;
  });
  root.querySelector('[data-act="copy"]')?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command?.textContent ?? "");
      if (note) note.textContent = t("Copied. Paste it in your terminal.");
    } catch {
      if (note) note.textContent = t("Select the command and copy it.");
    }
  });
}
