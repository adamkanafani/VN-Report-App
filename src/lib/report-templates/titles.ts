// Section titles vary by author for the same block: Alfredo's "Incoming NDT Reports" / "Heat Treat
// Charts" / "Incoming Air Flow" are Elmer Gomez's "Incoming NDT Report" / "Heat Treat Chart" /
// "Flow Test" (Jobs 20381, 20387, 19820) and Adan Aguirre's "Flow Test" (19886). These helpers
// match a title against a section's own title and aliases regardless of that wording, so a past
// report's divider names map onto this app's sections (draft/autoDraft.ts) and an edited deck's
// divider slides are found whatever the tech rep called them (pptx/finalFromDeck.ts).

/** Wording-insensitive key: lower case, letters only, "air"/"the" dropped, plurals folded. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/airflow/g, "air flow")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "air" && w !== "the")
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .join(" ");
}

/** The section (of those given) whose title or aliases match `title`, if any. */
export function sectionForTitle<T extends { title: string; aliases?: string[] }>(sections: T[], title: string): T | undefined {
  const key = titleKey(title);
  if (!key) return undefined;
  return sections.find((s) => titleKey(s.title) === key || (s.aliases ?? []).some((a) => titleKey(a) === key));
}
