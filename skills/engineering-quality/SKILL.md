---
name: engineering-quality
description: Design and review backend/API changes, migrations, security boundaries, reliability and performance. Use for substantial software work alongside the project workflow, debugging and browser-testing skills.
---

# Engineering quality

Read the relevant code, project instructions, lockfile, tests and CI. Confirm the actual runtime and framework versions. Reproduce the reported behavior, or document the specific evidence if production cannot be reproduced locally. Keep existing changes and data intact.

Choose only the references needed:
- [API, storage and reliability](references/backend.md) for services, schemas, jobs, auth and upgrades.
- [Validation and delivery](references/verification.md) for regression tests, performance and review.
- For React/Next.js optimization, load the bundled `vercel-react-best-practices` and only relevant rule files; do not impose React conventions on another stack.

State the invariant the change must restore. Follow the data and control flow across frontend, API, service and storage boundaries instead of fixing only the visible symptom. For asynchronous work, account for cancellation, stale responses, retries, duplicate events and restart recovery. Add a test that fails for the original failure and checks the observable result.

Implement the smallest complete solution. Reuse existing interfaces and product patterns. Check the real user flow in the visible preview as well as automated tests. Keep a concise progress update after a material result or blocker. Final output names changed behavior, verification and any remaining limitation; a passing build alone is not feature verification.
