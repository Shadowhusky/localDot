import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { WorkWindowUpdate } from "../../../../packages/protocol/src/work-window.ts";

// One native window per computer. Acknowledgements arrive after GTK has flushed its
// display changes, so observation cannot race a still-visible activity window.
export class WorkWindow {
  #child?: ChildProcessWithoutNullStreams;
  #pending = new Map<number, () => void>();
  #next = 0;
  #phase?: string;
  #visible = false;
  #blocked = new Set<string>();
  #serial: Promise<void> = Promise.resolve();
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  update(update: WorkWindowUpdate): Promise<void> {
    if (!update.visible) return update.phase === this.#phase ? this.hide() : Promise.resolve();
    if (this.#blocked.has(update.phase)) return Promise.resolve();
    this.#visible = true;
    this.#phase = update.phase;
    return this.#enqueue(update);
  }

  hide(): Promise<void> {
    if (this.#phase) this.#blocked.add(this.#phase);
    if (this.#blocked.size > 64)
      this.#blocked.delete(this.#blocked.values().next().value as string);
    if (!this.#visible) return this.#serial;
    this.#visible = false;
    return this.#enqueue({ phase: this.#phase ?? "none", visible: false, title: "", text: "" });
  }

  close(): void {
    this.#child?.kill("SIGKILL");
  }

  #enqueue(update: WorkWindowUpdate): Promise<void> {
    const operation = this.#serial.then(async () => {
      if (update.visible && this.#blocked.has(update.phase)) return;
      if (!this.#child && !update.visible) return;
      const child = this.#child ?? this.#start();
      const id = ++this.#next;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // A display failure must never break the agent's task. Kill a hung renderer
          // rather than leave a window covering the next computer observation.
          this.close();
          // The exit listener completes pending receipts after the X connection closes.
          setTimeout(finish, 250).unref();
        }, 1500);
        const finish = () => {
          clearTimeout(timeout);
          this.#pending.delete(id);
          resolve();
        };
        this.#pending.set(id, finish);
        child.stdin.write(`${JSON.stringify({ ...update, id })}\n`, (error) => {
          if (error) {
            this.close();
            setTimeout(finish, 250).unref();
          }
        });
      });
    });
    this.#serial = operation.catch(() => {});
    return this.#serial;
  }

  #start(): ChildProcessWithoutNullStreams {
    const child = spawn("/usr/bin/python3", ["-u", "/opt/localdot/work-window.py"], {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stdin.on("error", () => {});
    child.stderr.resume(); // Never log activity content or Python input on failures.
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const id = Number(line);
      this.#pending.get(id)?.();
    });
    const retired = () => {
      if (this.#child === child) this.#child = undefined;
      for (const finish of this.#pending.values()) finish();
      lines.close();
    };
    child.once("exit", retired);
    child.once("error", retired);
    return child;
  }
}
