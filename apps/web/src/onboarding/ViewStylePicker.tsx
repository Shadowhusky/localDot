import { t } from "../i18n/index.ts";
import { VIEW_LINES, VIEW_NAMES, VIEW_STYLES, type ViewStyle } from "../shell/view-style.ts";
import { RadioCards } from "../ui/RadioCards.tsx";
import "./onboarding.css";

function ViewPreview({ style }: { style: ViewStyle }) {
  return style === "chat" ? (
    <span className="view-preview" data-view="chat">
      <i data-part="reply" />
      <i data-part="mine" />
      <i data-part="reply" data-short="" />
      <i data-part="field" />
    </span>
  ) : (
    <span className="view-preview" data-view="studio">
      <i data-part="rail" />
      <i data-part="stage" />
      <i data-part="panel" />
    </span>
  );
}

export function ViewStylePicker({
  value,
  recommended,
  onChange,
  "aria-label": label,
}: {
  value: ViewStyle;
  recommended: ViewStyle;
  onChange(style: ViewStyle): void;
  "aria-label"?: string;
}) {
  return (
    <RadioCards
      layout="tiles"
      className="view-style-picker"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const style = VIEW_STYLES.find((each) => each === next);
        if (style) onChange(style);
      }}
      options={VIEW_STYLES.map((style) => ({
        value: style,
        label: VIEW_NAMES[style],
        description: VIEW_LINES[style],
        ...(style === recommended ? { tag: t`Recommended` } : {}),
        preview: <ViewPreview style={style} />,
      }))}
    />
  );
}
