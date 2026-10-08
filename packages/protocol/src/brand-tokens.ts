// The Theatre tokens for a page that cannot load the web app's stylesheet: the installer's progress
// page. Each is named as in apps/web/src/ui/tokens.css (Graphite) or dot.css, and a web test keeps
// the values equal, so the page before the app looks like the app.
export const BRAND_TOKENS = {
  "color-void": "#0a0b0d",
  "color-raised": "#1a1c1f",
  "color-fg-1": "#eeeff1",
  "color-fg-2": "#a8abb0",
  "color-fg-3": "#83868b",
  "color-hairline": "rgba(255, 255, 255, 0.07)",
  "color-control": "rgba(255, 255, 255, 0.08)",
  "color-control-hover": "rgba(255, 255, 255, 0.12)",
  "color-control-pressed": "rgba(255, 255, 255, 0.16)",
  "color-danger-fg": "#f08f8f",
  "shadow-raised":
    "inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 0 0 0.5px rgba(0, 0, 0, 0.6), 0 6px 16px rgba(0, 0, 0, 0.35)",
  "dot-eye": "#0b0c0f",
  "font-ui":
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", Inter, sans-serif',
  "font-mono": 'ui-monospace, "SF Mono", Menlo, monospace',
  "text-display": "22px",
  "text-display--line-height": "28px",
  "text-display--letter-spacing": "-0.02em",
  "text-body": "13px",
  "text-body--line-height": "18px",
  "text-footnote": "12px",
  "text-footnote--line-height": "16px",
  spacing: "4px",
  "radius-md": "8px",
  "radius-lg": "12px",
  "radius-full": "9999px",
  "ease-standard": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "ease-enter": "cubic-bezier(0.23, 1, 0.32, 1)",
  "dur-hover": "120ms",
  "dur-fade": "150ms",
  "dur-spring": "360ms",
} as const;

export type BrandToken = keyof typeof BRAND_TOKENS;

// The tokens as declarations for a :root rule.
export function brandTokenCss(): string {
  return Object.entries(BRAND_TOKENS)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");
}
