import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const USAGE = `usage: node capture.mjs --url <url> [--size 1280x800] [--wait "<js expression>"]
  [--run "<js async function body>"] [--screenshot <file.png>] [--full-page]
  [--eval "<js expression>" --out <file.json>] [--timeout 60000] [--allow-errors]`;

function readOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        size: { type: "string", default: "1280x800" },
        wait: { type: "string" },
        run: { type: "string" },
        screenshot: { type: "string" },
        "full-page": { type: "boolean", default: false },
        eval: { type: "string" },
        out: { type: "string" },
        timeout: { type: "string", default: "60000" },
        "allow-errors": { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    throw new Error(`${error.message}\n${USAGE}`);
  }
  const size = /^(\d+)x(\d+)$/.exec(values.size);
  const timeout = Number(values.timeout);
  if (!values.url || !size || !(timeout > 0) || (values.out && !values.eval)) {
    throw new Error(USAGE);
  }
  return { ...values, width: Number(size[1]), height: Number(size[2]), timeout };
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function launchChrome(profile) {
  // Its own process group, so closing it also reaps the GPU and renderer helpers.
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      // A fresh profile otherwise asks the macOS keychain for access.
      "--use-mock-keychain",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  const ready = new Promise((resolve, reject) => {
    chrome.stderr.setEncoding("utf8");
    chrome.stderr.on("data", (text) => {
      log = (log + text).slice(-4000);
      if (log.includes(`DevTools listening on ws://127.0.0.1:${PORT}/`)) resolve();
    });
    chrome.once("error", reject);
    chrome.once("exit", (code) =>
      reject(new Error(`Chrome exited (${code}) before DevTools opened:\n${log}`)),
    );
  });
  return { chrome, ready };
}

function closeChrome(chrome) {
  const signalGroup = (signal) => {
    try {
      process.kill(-chrome.pid, signal);
    } catch {}
  };
  if (chrome.pid === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => signalGroup("SIGKILL"), 5000);
    const done = () => {
      clearTimeout(kill);
      signalGroup("SIGKILL");
      resolve();
    };
    if (chrome.exitCode !== null || chrome.signalCode !== null) done();
    else {
      chrome.once("exit", done);
      signalGroup("SIGTERM");
    }
  });
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), {
      once: true,
    });
  });
  let nextId = 1;
  const calls = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const call = calls.get(message.id);
    if (call) {
      calls.delete(message.id);
      if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
      else call.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  });
  socket.addEventListener("close", () => {
    for (const call of calls.values())
      call.reject(new Error(`Chrome closed during ${call.method}`));
    calls.clear();
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => calls.set(id, { method, resolve, reject }));
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
    },
    close() {
      socket.close();
    },
  };
}

const remoteText = (remote) =>
  remote.type === "string" ? remote.value : (remote.description ?? String(remote.value));

const exceptionText = (details) => {
  const where = details.url ? ` (${details.url}:${details.lineNumber + 1})` : "";
  return `${details.exception?.description ?? details.text}${where}`;
};

async function pageTarget() {
  const base = `http://127.0.0.1:${PORT}/json`;
  const targets = await (await fetch(`${base}/list`)).json();
  const page = targets.find((t) => t.type === "page");
  return page ?? (await (await fetch(`${base}/new?about:blank`, { method: "PUT" })).json());
}

async function capture(options, chrome, errors) {
  const deadline = Date.now() + options.timeout;
  const within = (promise, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${options.timeout} ms ${label}`)),
        Math.max(0, deadline - Date.now()),
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  await within(chrome.ready, "waiting for Chrome to start");
  const cdp = await within(
    pageTarget().then((t) => connect(t.webSocketDebuggerUrl)),
    "connecting",
  );
  try {
    cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type === "error" || type === "assert") {
        errors.push(`console.${type}: ${args.map(remoteText).join(" ")}`);
      }
    });
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
      errors.push(`uncaught: ${exceptionText(exceptionDetails)}`),
    );
    cdp.on("Log.entryAdded", ({ entry }) => {
      // Chrome fetches /favicon.ico on its own; a page without one has not failed.
      if (entry.level === "error" && !entry.url?.endsWith("/favicon.ico")) {
        errors.push(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const evaluate = async (expression, label) => {
      const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (exceptionDetails) throw new Error(`${label} threw: ${exceptionText(exceptionDetails)}`);
      return result.value;
    };

    const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
    const { errorText } = await cdp.send("Page.navigate", { url: options.url });
    if (errorText) throw new Error(`cannot open ${options.url}: ${errorText}`);
    await within(loaded, "waiting for the page to load");

    if (options.wait) {
      const expression = `(async () => Boolean(await (${options.wait})))()`;
      const ready = async () => {
        let lastError = "";
        while (Date.now() <= deadline) {
          try {
            if (await evaluate(expression, "--wait")) return;
          } catch (error) {
            lastError = error.message;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`--wait never became true${lastError ? ` (${lastError})` : ""}`);
      };
      await within(ready(), `waiting for ${options.wait}`);
    }
    if (options.run)
      await within(evaluate(`(async () => {\n${options.run}\n})()`, "--run"), "in --run");
    if (options.screenshot) {
      const params = { format: "png" };
      if (options["full-page"]) {
        const { cssContentSize } = await cdp.send("Page.getLayoutMetrics");
        params.captureBeyondViewport = true;
        params.clip = {
          x: 0,
          y: 0,
          width: Math.ceil(cssContentSize.width),
          height: Math.ceil(cssContentSize.height),
          scale: 1,
        };
      }
      const { data } = await within(
        cdp.send("Page.captureScreenshot", params),
        "taking the screenshot",
      );
      writeFileSync(options.screenshot, Buffer.from(data, "base64"));
      console.log(`screenshot: ${options.screenshot}`);
    }
    if (options.eval) {
      const value = await within(evaluate(options.eval, "--eval"), "in --eval");
      const json = `${JSON.stringify(value ?? null, null, 2)}\n`;
      if (options.out) {
        writeFileSync(options.out, json);
        console.log(`eval: ${options.out}`);
      } else {
        process.stdout.write(json);
      }
    }
  } finally {
    cdp.close();
  }
}

async function main() {
  let options;
  try {
    options = readOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (!(await portIsFree(PORT))) {
    console.error(
      `capture: port ${PORT} is in use; refusing to drive a browser this script did not start`,
    );
    return 1;
  }
  const profile = mkdtempSync(join(tmpdir(), "localdot-capture-"));
  const chrome = launchChrome(profile);
  const cleanup = async () => {
    await closeChrome(chrome.chrome);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, () => cleanup().finally(() => process.exit(code)));
  }
  const errors = [];
  let failure = null;
  try {
    await capture(options, chrome, errors);
  } catch (error) {
    failure = error;
  } finally {
    await cleanup();
  }
  for (const error of errors) console.error(`page error: ${error}`);
  if (failure) {
    console.error(`capture: ${failure.message}`);
    return 1;
  }
  return errors.length > 0 && !options["allow-errors"] ? 1 : 0;
}

process.exitCode = await main();
