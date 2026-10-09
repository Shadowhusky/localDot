// The Theatre tokens for a page that cannot load the web app's stylesheet: the installer's progress
// page. Each is named as in apps/web/src/ui/tokens.css (Graphite) or dot.css, and a web test keeps
// the values equal, so the page before the app looks like the app.
export const BRAND_TOKENS = {
  "color-void": "#0a0b0d",
  "color-raised": "#18191c",
  "color-fg-1": "#eeeff1",
  "color-fg-2": "#a8abb0",
  "color-fg-3": "#83868b",
  "color-hairline": "rgba(255, 255, 255, 0.07)",
  "color-control": "rgba(255, 255, 255, 0.08)",
  "color-state-hover": "rgba(255, 255, 255, 0.06)",
  "color-state-pressed": "rgba(255, 255, 255, 0.1)",
  "color-danger-fg": "#f08f8f",
  "shadow-raised": "inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 1px 2px rgba(0, 0, 0, 0.4)",
  "dot-eye": "#0b0c0f",
  "font-ui":
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", Inter, sans-serif',
  "font-mono": 'ui-monospace, "SF Mono", Menlo, monospace',
  "text-title-1": "1.375rem",
  "text-title-1--line-height": "1.75rem",
  "text-title-1--letter-spacing": "-0.019em",
  "text-reading": "0.875rem",
  "text-reading--line-height": "1.3125rem",
  "text-body": "0.8125rem",
  "text-body--line-height": "1.125rem",
  "text-callout": "0.75rem",
  "text-callout--line-height": "1rem",
  spacing: "4px",
  "radius-md": "10px",
  "radius-lg": "14px",
  "radius-full": "9999px",
  "ease-standard": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "ease-enter": "cubic-bezier(0.23, 1, 0.32, 1)",
  "dur-hover": "120ms",
  "dur-fade": "150ms",
  "dur-default": "470ms",
  "loop-sweep": "1400ms",
  "loop-turn": "1200ms",
} as const;

export type BrandToken = keyof typeof BRAND_TOKENS;

// The tokens as declarations for a :root rule.
export function brandTokenCss(): string {
  return Object.entries(BRAND_TOKENS)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");
}
