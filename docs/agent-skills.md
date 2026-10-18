# Skills for each dot

localDot bundles 23 skills. Each task receives its dot’s built-in selection and the user’s custom skills. All dots share skill discovery, office files, PDF tools and image basics; specialist selections are defined in `packages/protocol/src/personas.ts`.

| Dot | Additional workflows |
| --- | --- |
| Everyday | Web research, media production |
| Coder | Project workflow, previews, debugging, engineering quality, frontend design, interface quality, web app testing, MCP building |
| Designer | Visual and frontend design, interface quality, media production, slides |
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
