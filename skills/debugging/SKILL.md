---
name: debugging
description: Find the real cause of a bug, crash or failing test before changing code - reproduce it, read the evidence, narrow it down, fix the cause and prove the fix.
---
# Debugging

1. Reproduce. Get the exact failing command, input or click path and run it. Save the full
   output (`cmd 2>&1 | tee /tmp/fail.log`). No reproduction, no fix: gather more evidence.
2. Read the evidence fully: the whole stack trace, the first error (not the last), the log lines
   before it, versions (`node -v`, lockfile), environment variables and recent changes
   (`git log -p -5 -- path`).
3. Narrow it down. Form one hypothesis at a time and test it cheaply: add a log line, run one
   test (`npx vitest run path -t "name"`, `pytest path::test -x -q`), bisect inputs, or
   `git bisect run <test>` when it used to work.
4. Fix the cause, in the smallest change. Do not paper over it (no blanket try/catch, no skipped
   or loosened tests, no retries that hide a race).
5. Prove it. Write a test that failed before and passes now; run the whole suite; rerun the
   original reproduction.
6. Report: the cause in one or two sentences, the fix, and how you verified it.

If three hypotheses in a row are wrong, stop and re-read the evidence from the top before trying
another: the assumption you have not checked is usually the problem.
