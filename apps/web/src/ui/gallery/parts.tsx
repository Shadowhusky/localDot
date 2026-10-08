import type { ReactNode } from "react";

export function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="atoms-section" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <p>{note}</p>
      </header>
      {children}
    </section>
  );
}

// A still specimen holds one state for the eye, so it takes no pointer or focus that would end it.
export function Specimen({
  caption,
  still = false,
  children,
}: {
  caption: string;
  still?: boolean;
  children: ReactNode;
}) {
  return (
    <figure className="atoms-specimen">
      <div className="atoms-stage" inert={still}>
        {children}
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
