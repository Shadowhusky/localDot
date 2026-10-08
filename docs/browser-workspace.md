# Browser workspace

This guide describes the M7 author draft. Final integration and independent review are still
pending; an older development preview may not contain these controls.

## Two screens for one task

The isolated computer has a **Desktop** and a separate **Signed-in browser**. Ask dot to use
the signed-in browser for a website or return to the desktop for files and applications. The
label above the live stage identifies the screen receiving the current actions. Both screens
belong to the same computer and task; a browser connection error does not redirect its input
to the desktop.

The signed-in browser retains its own profile across tasks and browser restarts. The desktop's
managed Chromium launchers use a fresh profile for each task and after recovery. Use the
signed-in browser when a login should persist. This does not import your Mac's browser profile.

## Signing in and returning control

When the task requests manual control, wait until the controls are available. Click the live
computer and use **Text for the computer** to enter text. That field clears after sending.
Complete sign-in or verification, then choose **Return control to dot**. The optional hand-back
note is part of the task, so put instructions there rather than passwords or verification codes.

Takeover intervals are excluded from task recording. The browser also protects private form
fields from agent observations. These protections do not prevent a website from displaying
account information after sign-in; decide which sites the task should use.

## Downloads

Downloads first appear in **Activity → Browser downloads**. They remain in quarantine until
you choose **Review & release**, inspect the filename, size, source and SHA-256 digest, and
confirm **Release once**. The destination is the isolated computer's Downloads folder. Releasing
a file does not open it, run it or extract an archive.

Choose **Discard** for a file you do not want. If a release reply is interrupted, use **Check
delivery** to reconcile the earlier placement. It does not create a second copy. A changed file
or digest requires a new review. **Refresh downloads** reloads the current list.

The current limits are 1 GiB per download and 10 GiB total quarantine storage. Unreleased files
expire after seven days. The managed browser disables Chromium's automatic download popup so
it does not cover the page; localDot's review panel remains the place to release files.

## Uploads

Ask dot to open the website's file chooser and select a file from the isolated computer. The
upload approval names every file, its path, size and SHA-256, along with the receiving page's
origin. Approving binds those exact bytes to that chooser and page. The total upload limit is
100 MiB. A changed file, closed chooser, page navigation or expired task requires a fresh action
and approval.

The receiving origin is the page that gets the file object. Its JavaScript may then send the
file elsewhere. The upload action assigns files to the chooser; the site's submit action is a
separate interaction.

## Stop, replay and recovery

**Stop** withdraws agent control and contains both screens and their active transfers. Recovery
waits for in-flight work to drain before another task may take ownership. Do not treat an
interrupted upload or release as proof that the receiving side saw no bytes.

Replay records both screens while the agent is working, including when you are not watching.
Choose a screen in Replay to inspect or export that track. Manual-control gaps stay private.
See [the Replay guide](replay.md) for retention, export and recovery details.
