import { sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, it } from "vitest";
import { KeydClient } from "../keyd/client.ts";
import { type KeydProcess, startKeyd, TEST_KEYD_PORTS } from "../keyd/testing/keyd-process.ts";
import {
  PROVIDER_CASES,
  ProviderProbeError,
  probeImage,
  providerCase,
  runProviderCase,
  safeProviderError,
  selectedProviders,
} from "./testing/provider-probe.ts";

// Requires BOTH flags. Default host/keyd/CI runs never read a provider credential or call a model.
const selected = selectedProviders((name) => process.env[name]);
let keyd: KeydProcess | undefined;
let client: KeydClient;
let image: Buffer;
describe.skipIf(selected.size === 0)(
  "computer use through real keyd (explicit paid/local opt-in)",
  () => {
    beforeAll(async () => {
      // No existing daemon home, vault, provider dispatcher, or local model lifecycle is reused.
      image = await probeImage();
      keyd = await startKeyd();
      client = new KeydClient(keyd.socketPath);
    });
    afterAll(async () => {
      await keyd?.stop();
    });
    for (const name of PROVIDER_CASES)
      it.skipIf(!selected.has(name))(`${name}: one click lands inside Gamma`, async (ctx) => {
        const config = providerCase(name, (variable) => process.env[variable]);
        try {
          if (config.key && config.keyEnv) {
            // Read only the explicitly selected credential, at point of sealed intake; never log it.
            let value = process.env[config.keyEnv];
            if (!value)
              throw new ProviderProbeError(
                "configuration",
                `${config.keyEnv} is required for the selected probe`,
              );
            const status = await client.status();
            const sealed = await sealSecret(status.sealKey, config.key, value);
            value = undefined;
            await client.putSecret(config.key, sealed);
          }
          await runProviderCase(client, config, image, TEST_KEYD_PORTS.from);
        } catch (error) {
          const safe = safeProviderError(error);
          if (safe.kind === "billing")
            ctx.skip(`${name}: provider reported unavailable credit (live acceptance pending)`);
          throw safe;
        } finally {
          if (config.key)
            await client.deleteSecret(config.key.id).catch(() => {
              throw new ProviderProbeError("cleanup", "provider fixture key cleanup failed");
            });
        }
      });
  },
);
