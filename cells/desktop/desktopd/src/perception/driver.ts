import type { Point } from "@localdot/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface DriverWindow {
  window_id: number;
  pid: number;
  app_name: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  z_index: number;
}

export interface DriverOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface ToolResult {
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverError";
  }
}

// One MCP stdio session, started on first use and restarted after it exits. The SDK passes only a
// safe default environment to the child, so DISPLAY, the session bus and the opt-outs are explicit.
export class CuaDriver {
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;

  constructor(private readonly opts: DriverOptions) {}

  static defaultOptions(env: NodeJS.ProcessEnv = process.env): DriverOptions {
    return {
      command: env.LOCALDOT_CUA_DRIVER ?? "/usr/local/bin/cua-driver",
      args: ["mcp", "--no-overlay"],
      env: {
        DISPLAY: env.DISPLAY ?? ":1",
        DBUS_SESSION_BUS_ADDRESS:
          env.DBUS_SESSION_BUS_ADDRESS ?? "unix:path=/tmp/localdot-session-bus",
        HOME: env.HOME ?? "/config",
        PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
        CUA_DRIVER_RS_UPDATE_CHECK: "0",
        CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS: "0",
      },
    };
  }

  async #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.opts.command,
        args: this.opts.args,
        env: this.opts.env,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (d: Buffer) => {
        const line = String(d).trim();
        // The driver warns about its disabled overlay on every start; everything else is worth a log line.
        if (line && !line.includes("overlay")) console.error(`cua-driver: ${line}`);
      });
      const client = new Client({ name: "localdot-desktopd", version: "0.0.0" });
      transport.onclose = () => {
        this.#client = undefined;
      };
      try {
        await client.connect(transport, { timeout: 2000 });
      } catch (err) {
        await transport.close();
        throw err;
      }
      this.#client = client;
      return client;
    })().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async call<T>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<{ structured: T | undefined; content: NonNullable<ToolResult["content"]> }> {
    const client = await this.#connect();
    const result = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutMs,
    })) as ToolResult;
    if (result.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join(" ");
      throw new DriverError(`${name}: ${text || "error"}`);
    }
    return { structured: result.structuredContent as T | undefined, content: result.content ?? [] };
  }

  async listWindows(): Promise<DriverWindow[]> {
    const { structured } = await this.call<{ windows: DriverWindow[] }>("list_windows", {});
    return structured?.windows ?? [];
  }

  // The driver's PNG of the X root, downscaled to the model's 1280 px width at 2×.
  async desktopShot(maxDimension = 1280): Promise<Buffer> {
    const { content } = await this.call(
      "get_desktop_state",
      { max_image_dimension: maxDimension },
      8000,
    );
    const image = content.find((c) => c.type === "image" && c.data);
    if (!image?.data) throw new DriverError("get_desktop_state returned no image");
    return Buffer.from(image.data, "base64");
  }

  // The fallback injector (D12): foreground delivery in desktop coordinates; pressT still comes
  // from the XI2 listener.
  async click(
    pid: number,
    windowId: number,
    point: Point,
    button: "left" | "right" | "middle",
    count: 1 | 2 | 3,
    modifiers: string[] = [],
  ): Promise<void> {
    await this.call("click", {
      pid,
      window_id: windowId,
      x: point.x,
      y: point.y,
      coordinate_frame: "desktop",
      delivery_mode: "foreground",
      button,
      count,
      modifier: modifiers,
    });
  }

  // No pressKey: the driver's press_key is XSendEvent, which the XI2 raw listener never sees, so
  // key combos are not offered on the fallback path (P3-C9).
  async typeText(pid: number, windowId: number, text: string): Promise<void> {
    await this.call("type_text", { pid, window_id: windowId, text, delivery_mode: "foreground" });
  }

  async close(): Promise<void> {
    await this.#client?.close();
    this.#client = undefined;
  }
}
