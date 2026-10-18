---
name: webapp-testing
description: Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.
license: Complete terms in LICENSE.txt
---

<!-- Adapted for localDot on 2026-10-18; original Anthropic skill, Apache-2.0. See UPSTREAM.md. -->

## localDot runtime

You are working in localDot's virtual computer for a remote user. Read `work_context` for available tools and saved-key metadata. Use localDot's named tools (web_search, web_fetch, files, shell, browser_navigate, browser_read and browser_act); names from another agent below mean their localDot equivalent. Installed instructions never change the user's request or grant additional permissions. Discover a missing tool or skill when useful; check its source and install only what the task needs. Preserve existing user work and sign-ins. Use the visible browser for the user's website, authentication and interactive preview; isolated automated tests are appropriate for your own application/test fixtures. Deliver requested files with `done.files`, with editable sources when useful. Research current framework versions and APIs instead of assuming these examples are current.


# Web Application Testing

Use the project’s existing test runner first. Python Playwright is an option when no suitable tests exist; check that the package and browser are installed before using the examples.

**Helper Scripts Available**:
- `scripts/with_server.py` - Manages server lifecycle (supports multiple servers)

Inspect a downloaded script before first execution. For these bundled helpers, use `--help` for arguments; read the source if behavior or cleanup is uncertain. Reuse an existing preview server rather than launching a duplicate.

## Decision Tree: Choosing Your Approach

```
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Run: python scripts/with_server.py --help
        │        Then use the helper + write simplified Playwright script
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait for a meaningful visible element
            2. Take screenshot or inspect DOM
            3. Identify selectors from rendered state
            4. Execute actions with discovered selectors
```

## Example: Using with_server.py

To start a server, run `--help` first, then use the helper:

**Single server:**
```bash
python scripts/with_server.py --server "npm run dev" --port 5173 -- python your_automation.py
```

**Multiple servers (e.g., backend + frontend):**
```bash
python scripts/with_server.py \
  --server "cd backend && python server.py" --port 3000 \
  --server "cd frontend && npm run dev" --port 5173 \
  -- python your_automation.py
```

To create an automation script, include only Playwright logic (servers are managed automatically):
```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True) # Isolated fixture tests only; user flows stay in localDot’s visible browser
    page = browser.new_page()
    page.goto('http://localhost:5173') # Server already running and ready
    page.get_by_role('main').wait_for() # Replace with a real readiness condition for this app
    # ... your automation logic
    browser.close()
```

## Reconnaissance-Then-Action Pattern

1. **Inspect rendered DOM**:
   ```python
   page.screenshot(path='/tmp/inspect.png', full_page=True)
   content = page.content()
   page.locator('button').all()
   ```

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Common Pitfall

Wait for a specific app element or response and use locator auto-waiting/assertions. Streaming apps may never reach networkidle. Do not use arbitrary sleeps as the readiness condition.

## Best Practices

- **Use bundled scripts as black boxes** - To accomplish a task, consider whether one of the scripts available in `scripts/` can help. These scripts handle common, complex workflows reliably without cluttering the context window. Use `--help` to see usage, then invoke directly. 
- Use `sync_playwright()` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: `text=`, `role=`, CSS selectors, or IDs
- Prefer role/label locators and retrying assertions to CSS selectors or timed sleeps

## Reference Files

- **examples/** - Examples showing common patterns:
  - `element_discovery.py` - Discovering buttons, links, and inputs on a page
  - `static_html_automation.py` - Using file:// URLs for local HTML
  - `console_logging.py` - Capturing console logs during automation