---
name: coding-workflow
description: Work in a code repository like a careful engineer - get the code, read its conventions, branch, change, run its tests and linters, commit, and open a pull request with git and gh.
---
# Working in a repository

git, gh, Node 24 (with npm and npx) and Python 3 are installed; VSCodium is the editor.

## Get set up
1. Get the code: `gh repo clone owner/repo ~/code/repo` (or `git clone`). Check `gh auth status`
   first; if signed out, see the connected-apps guidance for signing gh in.
2. Read before changing: README, CONTRIBUTING, AGENTS.md/CLAUDE.md, package.json or pyproject
   scripts, lint and format config, CI workflow (`.github/workflows/*`). Use the project's own
   commands, versions and style.
3. Install exactly as the project says (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync`,
   `pip install -e .[dev]`). Use the package manager the lockfile belongs to.
4. Branch: `git switch -c fix/short-description` from an up-to-date default branch.

## Change
- Find the code with `git grep -n` and read the callers before editing.
- Make the smallest change that solves the task; match the surrounding naming and patterns.
- Add or update a test that fails without the change and passes with it.

## Prove it
Run the same checks CI runs (tests, type check, lint, build). For a web app, also run it and
exercise the feature (see the web-app-preview skill). Read failures fully; fix causes, not tests.

## Hand over
- `git diff` to review your own change; remove debug output.
- Commit with a clear message (`fix(parser): handle empty input`), one logical change per commit.
- Push and open a PR only when asked: `git push -u origin HEAD` then
  `gh pr create --title "..." --body "..."` (what changed, why, how it was tested).
- Never force-push, rewrite shared history, or commit secrets, `.env` files or large binaries.
