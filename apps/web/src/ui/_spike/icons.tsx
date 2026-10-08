import type { SVGProps } from "react";

// Stand-ins until T06 vendors the icon set.
function Glyph({ d, ...props }: SVGProps<SVGSVGElement> & { d: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={d} />
    </svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return <Glyph d="M3.5 8.5 6.5 11.5 12.5 4.5" {...props} />;
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return <Glyph d="M4.5 6.5 8 10l3.5-3.5" {...props} />;
}

export function ChevronUpIcon(props: SVGProps<SVGSVGElement>) {
  return <Glyph d="M4.5 9.5 8 6l3.5 3.5" {...props} />;
}

export function XIcon(props: SVGProps<SVGSVGElement>) {
  return <Glyph d="M4.5 4.5l7 7m0-7-7 7" {...props} />;
}
