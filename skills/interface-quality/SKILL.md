---
name: interface-quality
description: Build and review responsive, accessible interfaces with coherent typography, spacing, interaction, motion and performance. Use for web or app UI, mobile layouts, form design and usability fixes.
---

# Interface quality

Start from the existing design system and the task’s actual content. For new visual direction, also load `frontend-design` or `visual-design`. Read [interaction checks](references/interaction.md) before implementing forms, overlays, lists or mobile keyboard behavior.

Define the primary action and readable hierarchy. Reuse tokens for type, spacing, surfaces and control sizes. Align related labels and values; group actions with the item they act on. On narrow screens shorten secondary labels or use labelled icon buttons rather than creating disconnected rows. Allow content to shrink and wrap; long names, URLs and localized text must not push actions out of their container.

Prefer semantic HTML and native input behavior. Give icon buttons accessible names and visible focus. Keep touch targets usable even when visual glyphs are small. Do not use tooltips as the only explanation on touch devices.

Use motion to explain a state change and respect reduced motion. Keep input focus stable during rerenders. For a popover or sheet, verify anchoring, scroll containment, focus return and opening during asynchronous data loading. Avoid layout shifts from changing button labels or loading indicators.

Verify in the visible browser at desktop and phone widths and with the keyboard open when possible. Inspect screenshots at actual size. Use automated tests for the behavior that broke; see `webapp-testing`. Treat real-device keyboard and permission testing as separate from viewport emulation, and state that limit when relevant.
