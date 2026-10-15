# Activity performance and progress

The October 14 audit found three separate issues: Activity's loaded history grew without a
render window, row labels could repeat their intent verbatim, and the DeepSeek skill catalog
was rediscovered after every shell command. In the inspected live history, individual skill
files were read more than 160 times. Event IDs and step IDs were unique: this was real repeated
work, not duplicate delivery. The same run had only one completed chat message at inspection.

## Presentation

Steps retain the 100-row initial history page and anchored earlier-history loading, but window
loaded rows with TanStack Virtual. Only mounted rows compute detailed display text. File
changes are indexed by step, avoiding a full change scan for each hidden row. Repeated read-only
file operations form expandable groups of at most 50 adjacent successful calls in the same plan
item. Failures, current actions, mutations and blocked key uses remain individual entries. Raw
step IDs, timestamps and details remain unchanged; replay retains individual steps.

Chat’s expanded Working/Worked history now shares the same read-group classifier and rendering
window, including past turns. Both views inset expanded children with a continuous guide line.
Chat indexes file changes by step instead of scanning every change for every row.

Long changed-file, memory-change, delivered-file and expanded source lists use the same window
mechanism. Conversation history already uses bounded pages; conversation and task libraries
already use virtualization. Browser downloads paginate. This is an audit of the task surfaces,
not a claim that every small settings menu or list in the product has been profiled.

Windowing discovers the actual scrollport and seeds its initial offset from the reader's current
position. This matters when a live list grows past the threshold while a group is open. Opening
and closing rows still use lazy details, and rows reentering the window do not animate again.

Design references: Cursor's compact mode hides repeated tool decoration and collapses detail
(https://cursor.com/changelog/1-4); GitHub Actions groups logs into expandable entries
(https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#grouping-log-lines).

## Skill discovery

The upstream registry can invalidate after shell commands without rereading all SKILL.md files.
The virtual-computer catalog is cached for five minutes per cwd. Recognized skill-directory
writes, skill installers and unknown command arguments invalidate immediately. Opaque script
changes are rediscovered on the next invalidation after the cache expires. Every explicit skill
invocation reads its actual instructions fresh; failures and partial catalog observations are
not stored as successful cache entries. No credential or authorization result is cached here.

## Progress

Shared guidance asks every harness to announce substantial work, meaningful findings and
changes of approach, and to update roughly once per minute. The API agent additionally adds a
reminder to its existing model request after eight silent model turns or sixty seconds without
chat text. A short native-computer preamble is no longer swallowed as an action intent when an
update is due. This does not create extra paid requests, fabricate progress or terminate work.
It cannot interrupt a single long model generation or tool call; provider compliance is still
required. Native CLI harnesses receive the guidance at daemon startup.

## Verification

`gallery.html#activity` is a local-only 3,000-step fixture. Check opening, grouping, detail
expansion, live appends, history paging and bottom reachability at desktop and phone widths.
The regression suite includes a 3,000 → 4,000-step mounted-row bound, preserved reading and
selection, no title/subtitle echo, grouping boundaries, fresh skill loads, cache expiry and
progress reminder reset. Chrome at 390 × 844 preserved the open group's vertical position
within 0.04 px across an append that activated windowing, with 22 rows mounted. This is browser
viewport testing, not a physical iPhone/Safari performance certification.
