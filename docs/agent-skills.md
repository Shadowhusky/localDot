# Skills for each dot

localDot bundles 25 skills. Each task receives its dot’s built-in selection and the user’s custom skills. All dots share skill discovery, office files, PDF tools and image basics; specialist selections are defined in `packages/protocol/src/personas.ts`.

| Dot | Additional workflows |
| --- | --- |
| Everyday | Web research, media production |
| Coder | Project workflow, previews, debugging, engineering quality, frontend design, interface quality, web app testing, MCP building, Vercel React performance and composition rules |
| Designer | Visual and frontend design, interface quality, media production, slides, Vercel component composition |
| Video editor | Media production, visual design, video editing, captions |
| Finance | Data analysis, spreadsheet models, financial analysis, bookkeeping |
| Researcher | Web research, report writing, data analysis |

The daemon copies complete skill bundles, including references and scripts, into the virtual computer. The native DeepSeek harness advertises their metadata and loads selected instructions on demand. Other runtimes receive the same installed paths. Switching roles removes only previously selected built-ins, preserving user-added skills.

`skill-discovery` teaches the agent to research official sources, evaluate suitable workflows, inspect a selected skill and its dependencies, pin its revision, test a small output and deliver the result. Familiar small tasks do not require a new toolchain. The source catalog is a starting point, not a claim that one library is best for every task. A skill does not supply an account or unavailable tool.

## Reviewed upstream packs

`frontend-design`, `webapp-testing` and `mcp-builder` are adapted from [Anthropic’s Apache-2.0 skill repository](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills). Each contains its license and provenance. `skills/upstream-lock.json` records the reviewed revision and original/installed SHA-256 hashes. Changes retain actual localDot tool names, visible-browser workflows for user interaction, project-first testing, private credential handling and delivery through `done.files`.

To update a pack, review its new revision and license, inspect executable resources, preserve local adaptations, update both hashes and run the skill corpus and harness tests. Do not overwrite installed user skills or treat upstream instructions as additional authorization. The server helper is tested with successful startup, failed tests, failed startup and an occupied port; it stops only its own process groups.

## Verification

The corpus check verifies every role’s skills, descriptions, resources, licenses and manifest hashes. Harness tests load actual coder/designer bundles through the native skill tool and confirm bodies are not injected before selection. Key and UI tests cover the separate credential workflow. API capabilities, permissions and tool availability still determine what a task can execute.


## 2026-10-19 review and integration

Reviewed the Agent Skills specification, Anthropic skills, Vercel agent-skills, obra/superpowers and HeyGen HyperFrames. Directory popularity was used only to find candidates, not as evidence of task quality. The official Vercel repository had 32,609 stars at review; the exact source revision is pinned in upstream-lock.json. Its two included packs declare MIT in their front matter; attribution and terms are bundled. Existing Anthropic packs remain at their reviewed revision.

- **Coder:** project-first vertical slices, explicit risky-boundary proof, race/failure tests, measured performance and final diff/UI review. Added Vercel React/Next.js and component architecture rule files for the matching stack. Their examples are optional techniques, scoped by the local preface; they do not force framework migrations or new dependencies.
- **Designer:** representative art-direction drafts, real content/assets, a concrete pixel-level critique, targeted corrections and editable delivery. Existing frontend-design remains available; component composition supports interface implementations.
- **Video editor:** sequence planning, tool selection, a representative scene with sound, bounded renders and final playback QA. Official HyperFrames/Remotion packs are discovery routes, not preinstalled runtimes or mandatory renderers.
- **Researcher:** bounded evidence collection, claim/source tracking, contradictions and a completion check.
- **Finance:** recalculation, independent arithmetic, sensitivity checks and readable workbook review.
- **Everyday:** uses the shared discovery workflow and existing document/media/research skills; reuses installed methods instead of searching for skills on routine tasks.

Role guidance points to the relevant entry workflow. Detailed playbooks and Vercel rules are files loaded only when needed. No extra planner service, model call, background scan, auto-updater, telemetry, executable download or new npm dependency was added. The duplicate compiled Vercel guides are omitted; selected rule files remain available. Bulk-importing every pack or forcing multi-agent planning was rejected because it increases context and latency regardless of task fit.

Sources: [skill format and progressive disclosure](https://agentskills.io/specification), [Vercel](https://github.com/vercel-labs/agent-skills), [Anthropic](https://github.com/anthropics/skills), [Superpowers](https://github.com/obra/superpowers), [HyperFrames](https://github.com/heygen-com/hyperframes). These are maintained approaches, not a guarantee of best-in-class output for every model. Corpus/native-loader tests verify availability and bounded loading; aesthetic quality still requires reviewing real task outputs. No paid model quality benchmark was run for this change.
