export interface PickerItem {
  value: string;
  label: string;
  // A second line under the label, which makes the row taller.
  description?: string;
  // More text a search matches, such as a model's ID.
  keywords?: string;
  // Unavailable while set: the row stays readable and shows this in place of its description.
  disabledReason?: string;
}

export interface PickerGroup {
  label: string;
  items: readonly PickerItem[];
}

export interface PickerOption extends PickerItem {
  index: number;
  custom?: boolean;
}

export interface PickerSection {
  label?: string;
  options: PickerOption[];
}

export interface Span {
  start: number;
  text: string;
  match: boolean;
}

export const PAGE = 10;

export function buildSections(
  items: readonly PickerItem[] | undefined,
  groups: readonly PickerGroup[] | undefined,
  keep: (item: PickerItem) => boolean = () => true,
): PickerSection[] {
  const source = groups ?? [{ label: undefined, items: items ?? [] }];
  let index = 0;
  return source
    .map(({ label, items }) => ({
      label,
      options: items.filter(keep).map((item) => ({ ...item, index: index++ })),
    }))
    .filter((section) => section.options.length > 0);
}

export function flatten(sections: readonly PickerSection[]): PickerOption[] {
  return sections.flatMap((section) => section.options);
}

export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// Every word of the search appears somewhere in the label, the keywords or the value.
export function matches(item: PickerItem, terms: readonly string[]): boolean {
  const haystack = `${item.label} ${item.keywords ?? ""} ${item.value}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function highlight(label: string, terms: readonly string[]): Span[] {
  const lower = label.toLowerCase();
  const marked = new Array<boolean>(label.length).fill(false);
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1))
      marked.fill(true, at, at + term.length);
  }
  const spans: Span[] = [];
  for (let at = 0; at < label.length; at++) {
    const last = spans.at(-1);
    if (last && last.match === marked[at]) last.text += label[at];
    else spans.push({ start: at, text: label[at] as string, match: marked[at] as boolean });
  }
  return spans;
}

export function clampIndex(options: readonly PickerOption[], index: number): number {
  return options.length ? Math.min(Math.max(index, 0), options.length - 1) : -1;
}

// The row a list opens on: the chosen one, else the first that can be chosen.
export function openingIndex(options: readonly PickerOption[], value: string): number {
  const chosen = options.findIndex((option) => option.value === value);
  if (chosen >= 0) return chosen;
  const usable = options.findIndex((option) => !option.disabledReason);
  return usable >= 0 ? usable : clampIndex(options, 0);
}

// Typing jumps to the next row whose label starts with what was typed; repeating one letter cycles
// through the rows that start with it.
export function typeahead(
  options: readonly PickerOption[],
  typed: string,
  from: number,
): number | undefined {
  if (!options.length || !typed) return undefined;
  const text = typed.toLowerCase();
  const cycling = [...text].every((char) => char === text[0]);
  const prefix = cycling ? text[0] : text;
  const start = cycling ? from + 1 : Math.max(from, 0);
  for (let i = 0; i < options.length; i++) {
    const at = (start + i) % options.length;
    if (options[at]?.label.toLowerCase().startsWith(prefix as string)) return at;
  }
  return undefined;
}
