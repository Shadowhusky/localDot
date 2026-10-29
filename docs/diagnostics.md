# Problem reports

When something goes wrong on a computer you can't look at, a problem report brings its
diagnostics to the localDot team: what version runs, what its checks say, how its computers and
web browser are doing, how recent tasks ended, and the last lines of its logs. Every report gets an
ID such as `LD-7K3P-Q9XA` to quote in an issue or an email. Nothing is sent until you have seen it.

## Sending one

- **In the app:** Settings › Report a problem. Say what happened (optional), choose **Review
  report** to see everything it holds, then **Send report**. The ID shows with a copy button.
- **From a failure:** a task that ended with an error shows **Report this problem** in the chat; a
  task that needs attention has it under **Recovery options**; when dot's web browser couldn't
  start, it is next to **Restart web browser** in Settings › Accounts. These open the same page
  with the failure attached, and offer to include what you asked dot to do in that task.
- **From a terminal:** `localdot report` prints the whole report and asks before sending.
  `--message "<what happened>"` adds your words (up to 2,000 characters; never a key),
  `--yes` sends without asking, `--dry-run` saves it to `localdot-report-<time>.json` in the
  current folder instead, and `--json` prints the result as JSON. `--dot <name>` reports on
  another dot of this computer.

When localDot isn't answering, which is often when a report matters most, `localdot report` makes
the report itself from the log files and task records in the data folder. It then has no checks
or computer states, and says so.

## What a report holds

- localDot's version and channel, how it was installed, whether it is running and for how long,
  and the state of updates.
- The operating system, its version, the processor type, the number of CPUs and the memory size.
- The results of the checks `localdot doctor` runs (from the app; up to 25 seconds).
- The key service (ready, locked or down), Docker, and whether remote access is on and connected.
- Each computer's state, what it is doing and its last error, and its web browser's state,
  restarts, last problem and the last failure its supervisor saw.
- The newest eight tasks, and the one the report is about: when each started, how it ended, its
  verdict and step counts, its states with their reasons, model retries, and which models it
  used.
- The last 300 lines of `logs/daemon.log` and `logs/keyd.log`, or of the release-managed
  installation's `install/logs/*.log`.
- Your own words, what the report is about, and an anonymous installation ID: random, made for
  reports only, so several reports from one computer can be told apart.

Never: your messages or dot's, screenshots, recordings, files, file names from your tasks, saved
sign-ins, keys or passwords. What you asked dot to do is included only for the task a report is
about, and only when you tick **Include what you asked dot to do**.

## How it is redacted

Every text in the report goes through the same steps before you see it:

1. The task redactor, with this installation's own secrets: its install token, its remote
   access keys and its computers' tokens are masked wherever they appear, along with stand-in
   keys, private key blocks and recognisable API keys (Anthropic, OpenAI, Google, GitHub, AWS,
   Slack, Stripe and others).
2. The log sanitizer `localdot logs` uses: `Bearer` values, `code=` and `token=` link
   parameters, `password`, `token`, `api_key` and `authorization` values, and control characters.
3. Sign-in, remote access and share links lose their keys (`#remote=`, `key=`, `access=`,
   `secret=`, `passphrase=`); `passphrase`, `secret`, `credential`, `cookie` and `private_key`
   values are masked.
4. Relay addresses become `[relay]`, Tailscale machine names `[tailnet]`, emails `[email]`,
   public IP addresses `[ip]` (private and loopback ones stay), the user name in home folders
   (`/Users/…`, `/home/…`, `C:\Users\…`) `[user]`, and this computer's user and host names
   `[user]` and `[host]` wherever they appear.

Each line is then cut to 1,000 characters. A report is at most 4 MB of text and 2 MB compressed;
in practice it is tens of kilobytes. The checks are a safeguard: a secret in an unusual shape can
still slip through, which is why you see the report first.

## Where it goes

Reports go to `https://reports.localdot.dev`, a Cloudflare Worker run by the localDot team, over
HTTPS. It keeps each report's details in Cloudflare D1 and its compressed diagnostics in Cloudflare
KV, for 180 days or until you or the team delete it. Your IP address is not stored: to limit
reports to 20 an hour from one network and 6 an hour from one installation, it keeps a hashed
counter that expires within the hour. `LOCALDOT_REPORTS_URL` sends reports to another service,
for example a local copy while testing (`http://127.0.0.1:8787`); it must use HTTPS unless it
is on this computer.

## Turning reports off

Settings › Report a problem › **Allow problem reports** turns reporting off for that dot,
from the app and from `localdot report` alike. The choice is kept in `<data folder>/reports.json`
with the installation ID and the reports this localDot sent (mode 0600). If that file can't be
read, reporting counts as off until you choose again.

## Deleting a report

Only the localDot that sent a report holds the token that deletes it. Delete it from Settings ›
Report a problem › **Reports you sent**, which also shows how far the team has got with each, or
with `localdot report delete LD-7K3P-Q9XA`. Deleting removes the report and its diagnostics from
the service. If you no longer have that computer, write to the team with the ID and ask them to
delete it.

The service itself, its API and how to deploy it are described in
[apps/reports](../apps/reports/README.md).
