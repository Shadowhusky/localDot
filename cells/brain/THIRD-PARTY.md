# Third-party code in the brain image

`dist/brain.mjs` is one esbuild bundle. `build.mjs` copies the license (and NOTICE, when there is
one) of every package it bundles into the bundle's header, and stops when a package has none.

| Package | License |
|---|---|
| ai, @ai-sdk/provider, @ai-sdk/provider-utils, @ai-sdk/gateway, @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/google, @ai-sdk/openai-compatible, @ai-sdk/azure, @ai-sdk/xai, @ai-sdk/mistral, @ai-sdk/deepseek, @ai-sdk/groq | Apache-2.0 (Vercel's AI SDK; @ai-sdk/provider-utils ships no LICENSE file, so the bundle carries `ai`'s, from the same repository) |
| @openrouter/ai-sdk-provider | Apache-2.0 (OpenRouter's; its own build carries copies of AI SDK utilities, Apache-2.0 too) |
| undici | MIT |
| zod | MIT |
| eventsource-parser | MIT |
| @vercel/oidc | Apache-2.0 |
| @workflow/serde | Apache-2.0 |

The base image is `node:24.21.0-alpine3.23`, pinned by digest.

The build writes `dist/brain.licenses.json` with the exact bundled package versions and SHA-256 hashes of the copied LICENSE/NOTICE files. Every physical package instance is checked, including duplicate versions in isolated builds. The provider-utils fallback is accepted only for the audited `5.0.52` / `ai 7.0.123` pins and matching repository/license metadata. No bundle is published until notice accounting succeeds.
