import type { CommandResult } from "../access-links.ts";
import type { PortRange } from "../cells/ports.ts";

// Runs the `tailscale` that answered as connected (AccessLinks.runTailscale); undefined while none
// does.
export type TailscaleRun = (args: readonly string[]) => Promise<CommandResult | undefined>;

export class ServeError extends Error {
  constructor(result: CommandResult | undefined) {
    super(
      result
        ? `tailscale serve failed (${result.timedOut ? "timed out" : (result.error ?? `exit ${result.code}`)})`
        : "Tailscale isn't connected",
    );
    this.name = "ServeError";
  }
}

// A Tailscale Serve entry for each preview port this daemon holds: HTTPS on the tailnet only (never
// Funnel), to the same port on loopback. Entries go when their previews do; ones a previous run
// left in this daemon's block go before the first new one is made.
export class PreviewServe {
  readonly #held = new Set<number>();
  #swept: Promise<void> | undefined;

  constructor(
    private readonly run: TailscaleRun,
    private readonly range: PortRange,
  ) {}

  async add(port: number): Promise<void> {
    this.#swept ??= this.#sweep();
    await this.#swept;
    const result = await this.run(["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
    if (result?.code !== 0) throw new ServeError(result);
    this.#held.add(port);
  }

  async remove(port: number): Promise<void> {
    if (!this.#held.delete(port)) return;
    await this.#off(port);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#held].map((port) => this.remove(port)));
  }

  async #off(port: number): Promise<void> {
    await this.run(["serve", `--https=${port}`, "off"]).catch(() => undefined);
  }

  async #sweep(): Promise<void> {
    const listing = await this.run(["serve", "status", "--json"]).catch(() => undefined);
    if (listing?.code !== 0) return;
    let config: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    try {
      config = JSON.parse(listing.stdout) ?? {};
    } catch {
      return;
    }
    const stale = Object.entries(config.Web ?? {}).flatMap(([host, web]) => {
      const port = Number(host.slice(host.lastIndexOf(":") + 1));
      const ours =
        port >= this.range.from &&
        port <= this.range.to &&
        !this.#held.has(port) &&
        web.Handlers?.["/"]?.Proxy === `http://127.0.0.1:${port}`;
      return ours ? [port] : [];
    });
    for (const port of new Set(stale)) await this.#off(port);
  }
}
