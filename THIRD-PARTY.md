# Third-party software

localDot's own source is licensed under its root [LICENSE](LICENSE). These
components retain their respective licenses and notices.

| Component | Version | License | Distribution and notice |
| --- | --- | --- | --- |
| mediabunny | 1.61.0 | MPL-2.0 | Used unmodified by the daemon and web app. Its complete license and exact source locations ship with each web build at `/assets/licenses/mediabunny-1.61.0.txt`. |
| pdf.js (`pdfjs-dist`) | 6.3.289 | Apache-2.0 (Copyright Mozilla Foundation) | Used unmodified by the web app to draw PDFs in a file's preview, loaded only when one opens. Its license ships with each web build at `/assets/licenses/pdfjs-dist-6.3.289.txt`; its optional Node canvas binary is not installed (`ignoredOptionalDependencies`). |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | 0.3.282 | Proprietary: © Anthropic PBC, all rights reserved; use is subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance) | Used unmodified by the daemon to drive the user's own installed Claude Code. Its bundled Claude Code binaries are not installed (`ignoredOptionalDependencies` in `pnpm-workspace.yaml`); only the user's `claude` runs. Its license ships in the package as `LICENSE.md`. |
| DeepSeek Harness core (`@deepseek-ai/dsh-*`) and Cordis | DSH 0.1.7-rc.2; Cordis 4.0.4 | MIT (DeepSeek; Cordis: Shigma) | Published packages drive the API-model loop; the build embeds DSH’s package-version lookup for the single-file image. Full license texts for every bundled package ship inside `brain.mjs`; `cells/brain/dist/brain.licenses.json` records their hashes. No default shell, credential store, session uploader or telemetry plugin is mounted. |
| Tailwind CSS | 4.3.3 | MIT | Build-time stylesheet generator for the web app. Its license banner ships at the top of each built stylesheet. |
| Base UI (`@base-ui/react`) | 1.8.0 | MIT (Copyright (c) 2019 Material-UI SAS) | Headless components under the web UI kit in `apps/web/src/ui/`. |
| shadcn/ui component source | generator 4.21.0, `base-vega` style | MIT (Copyright (c) 2023 shadcn) | Generated source, adapted by hand into `apps/web/src/ui/`. |
| Lucide icons | 1.31.0 (35 outlines) | ISC (Copyright (c) 2026 Lucide Icons and Contributors); the outlines Lucide derived from Feather are MIT (Copyright (c) 2013-present Cole Bemis) | Path data vendored unmodified in `apps/web/src/ui/icons.ts`. [License and notices](apps/web/vendor/lucide/LICENSE). |
| Selkies client | Pinned vendored client | See its notice | [Client notice](apps/web/vendor/selkies/NOTICE.md). |
| Desktop cell software | Pinned cell image | See individual components | [Desktop third-party list](cells/desktop/THIRD-PARTY.md). |
| sherpa-onnx (`sherpa-onnx-offline`) and ONNX Runtime | sherpa-onnx 2.0.1, ONNX Runtime 1.28.2 | Apache-2.0 (Xiaomi Corporation and the k2-fsa authors); MIT (Microsoft) | Not shipped. Downloaded on the owner's press from the project's own release, pinned by SHA-256 in `apps/daemon/src/voice/speech-catalog.ts`, and kept in `<home>/speech/`. [Upstream licence](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE), [ONNX Runtime licence](https://github.com/microsoft/onnxruntime/blob/main/LICENSE). |
| X-ASR zh-en (Balanced speech model) | int8, 2026-06-03 | Apache-2.0 | Not shipped. Downloaded the same way from sherpa-onnx's model release. [Upstream](https://huggingface.co/GilgameshWind/X-ASR-zh-en). |
| SenseVoice Small (Light speech model) | int8, 2024-07-17 | FunASR Model Open Source License (attribution required: the model's name and source are kept in Settings) | Not shipped. Downloaded the same way. [Upstream](https://github.com/FunAudioLLM/SenseVoice), [licence](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE). |
| Qwen3-ASR 0.6B (Most languages speech model) | int8 ONNX export, 2026-03-25 | Apache-2.0 | Not shipped. Downloaded the same way. [Upstream](https://github.com/QwenLM/Qwen3-ASR), [ONNX export](https://github.com/Wasser1462/Qwen3-ASR-onnx). |
| X keysym names (xorgproto `keysymdef.h`, `XF86keysym.h`) | 2025.1 | MIT-style (The Open Group, Digital) | The names and values in [`packages/protocol/src/keysyms.ts`](packages/protocol/src/keysyms.ts), which carries the notice. |

mediabunny's Source Code Form for the exact version used here is available from
[the npm source archive](https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz)
and [upstream tag v1.61.0](https://github.com/Vanilagy/mediabunny/tree/v1.61.0).
The daemon uses the installed package with its `LICENSE`; the web build copies
that license unchanged into the notice above. No patch, fork or vendored
mediabunny files are used. The larger localDot work retains its own MIT license.
