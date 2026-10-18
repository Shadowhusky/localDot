# Interaction checks

Forms: labels stay associated with controls; validation identifies the field and recovery; disabled/busy buttons explain the current state. Uncontrolled private input must be cleared on submit, close, navigation and visibility changes. Editing an item should reveal its actual editor within the right scroller, without moving the whole page or reopening the keyboard unnecessarily.

Mobile: test 320–430 px widths, safe areas, text enlargement and long translated strings. Use dynamic/visual viewport data carefully; only the intended composer or footer should move for the keyboard. Avoid simultaneously applying both a resized container and a keyboard translation. Do not steal focus when data refreshes.

Overlays: choose one scroll owner, keep headers and actions reachable, and add adequate scroll padding so the last item clears sticky controls. Preserve background position; restore focus on close. Keep expanded content visibly nested and large lists virtualized or paginated, with stable item IDs.

Async controls: distinguish recording, processing, success, cancellation and failure. Do not allow stale responses to overwrite a new interaction. Keep hit areas separate even when icons appear small; verify hover/focus backgrounds do not overlap adjacent controls.

Accessibility: keyboard order follows visual order; live announcements describe useful changes without spam. Check contrast, target size, focus visibility, reduced motion and screen-reader names with the applicable WCAG guidance. Test a keyboard-only critical flow rather than claiming accessibility from an automated score.

Performance: inspect rerenders, large DOM trees and event listeners on repeated open/close. Use representative long histories. Group repeated steps without hiding errors or losing chronological order; collapsed summaries must still lead to their full details.
