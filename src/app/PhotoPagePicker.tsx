"use client";

import { useMemo, useState } from "react";
import type { JobFile } from "@/lib/ingest/fileWalk";
import type { SectionState } from "@/lib/state/jobState";
import { groupPhotos, labelRank, layoutGroup, photoGroupOf, photoPick, photoSlots, PHOTOS_PER_REPORT_PAGE } from "@/lib/pdf/photoGroups";

// Group titles a photo can always be moved into, besides whatever the job's own folders produce.
const STANDARD_GROUPS = ["Shipping Photos", "NDT Photos", "Incoming Photos", "Final Photos"];
const PER_PAGE = PHOTOS_PER_REPORT_PAGE;

/** Each group's slots in page order (page = slot / 6); null is an empty slot. */
type Layout = Record<string, Array<string | null>>;

const trimEnd = (slots: Array<string | null>) => {
  const out = [...slots];
  while (out.length > 0 && !out[out.length - 1]) out.pop();
  return out;
};

/**
 * The photo section laid out as the report prints it: pages of six numbered slots per group
 * (Shipping, NDT, Incoming, Final), filled from the job's photos on the left by clicking or by
 * dragging a photo onto the exact slot it belongs in. What's on the right is exactly what the PDF
 * and PowerPoint print. "+ Add page" starts a new page in a group even before the last one is full.
 * Every placed photo shows its page and slot on the left, so cycling through a few hundred shots
 * never loses track of what's been used. Keyboard: ← → to step through photos, Space to add /
 * remove, Backspace to remove. The I&A and the Final keep separate picks (see photoPick).
 */
export function PhotoPagePicker({
  jobRoot,
  section,
  reportType,
}: {
  jobRoot: string;
  section: { id: string; matchedFiles: JobFile[]; state: SectionState };
  reportType: "ia" | "final";
}) {
  const all = section.matchedFiles.map((f) => f.relativePath);
  const [overrides, setOverrides] = useState<Record<string, string>>(() => ({ ...section.state.photoGroupOverrides }));
  const [layout, setLayout] = useState<Layout>(() => {
    const slots = photoSlots(section.state, reportType);
    const out: Layout = {};
    for (const g of groupPhotos(photoPick(section, section.state, reportType), section.state.photoGroupOverrides)) out[g.label] = layoutGroup(g.paths, slots);
    return out;
  });
  // Pages a group shows beyond its last photo ("+ Add page"), and where Add / Space puts the next
  // photo in each group -- the start of the page just added, else the first empty slot.
  const [shownPages, setShownPages] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState<Record<string, number>>({});
  const groupOf = (p: string) => photoGroupOf(p, overrides);

  // Left-hand tabs: every group the job's photos fall into, in report order.
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of all) {
      const label = photoGroupOf(p, overrides).label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => labelRank(a.label) - labelRank(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.matchedFiles, overrides]);
  const [tab, setTab] = useState(groups[0]?.label ?? "");
  const [hideUsed, setHideUsed] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const placedCount = Object.values(layout).reduce((n, slots) => n + slots.filter(Boolean).length, 0);
  const slotOf = (p: string) => {
    for (const slots of Object.values(layout)) {
      const i = slots.indexOf(p);
      if (i !== -1) return { page: Math.floor(i / PER_PAGE) + 1, slot: (i % PER_PAGE) + 1 };
    }
    return null;
  };
  const isPlaced = (p: string) => slotOf(p) !== null;
  const tabPhotos = all.filter((p) => groupOf(p).label === tab && (!hideUsed || !isPlaced(p) || p === focus));
  const current = focus && tabPhotos.includes(focus) ? focus : (tabPhotos[0] ?? null);

  // Saved as the print order plus each photo's slot -- what photoPick / layoutGroup read back.
  const save = (nextLayout: Layout, nextOverrides = overrides) => {
    const cleaned: Layout = {};
    for (const [label, slots] of Object.entries(nextLayout)) cleaned[label] = trimEnd(slots);
    setLayout(cleaned);
    setOverrides(nextOverrides);
    const labels = Object.keys(cleaned).sort((a, b) => labelRank(a) - labelRank(b));
    const order = labels.flatMap((label) => cleaned[label].filter((p): p is string => Boolean(p)));
    const slots: Record<string, number> = {};
    for (const label of labels) cleaned[label].forEach((p, i) => p && (slots[p] = i));
    fetch("/api/section-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobRoot,
        sectionId: section.id,
        patch: {
          selectedPhotoPathsByReport: { ...section.state.selectedPhotoPathsByReport, [reportType]: order },
          photoSlotsByReport: { ...section.state.photoSlotsByReport, [reportType]: slots },
          photoGroupOverrides: nextOverrides,
        },
      }),
    });
  };
  const without = (p: string): Layout => Object.fromEntries(Object.entries(layout).map(([label, slots]) => [label, slots.map((x) => (x === p ? null : x))]));
  // Into group `label`: the photo's own folder group needs no override.
  const withGroup = (p: string, label: string) => {
    const next = { ...overrides };
    if (photoGroupOf(p).label === label) delete next[p];
    else next[p] = label;
    return next;
  };
  // Put `p` in slot `index` of group `label`. An empty slot just takes it; a filled one makes room
  // by pushing the photos after it along to the next empty slot (so later pages keep their breaks).
  const placeAt = (p: string, label: string, index: number) => {
    const next = without(p);
    const slots = [...(next[label] ?? [])];
    while (slots.length < index) slots.push(null);
    if (!slots[index]) slots[index] = p;
    else {
      slots.splice(index, 0, p);
      const gap = slots.indexOf(null, index + 1);
      if (gap !== -1) slots.splice(gap, 1);
    }
    next[label] = slots;
    save(next, withGroup(p, label));
  };
  const add = (p: string) => {
    if (isPlaced(p)) return;
    const label = groupOf(p).label;
    const slots = layout[label] ?? [];
    let i = cursor[label] ?? 0;
    while (slots[i]) i++;
    placeAt(p, label, i);
  };
  const remove = (p: string) => save(without(p));
  const toggle = (p: string) => (isPlaced(p) ? remove(p) : add(p));
  const pagesFor = (label: string) => Math.max(1, Math.ceil((layout[label]?.length ?? 0) / PER_PAGE), shownPages[label] ?? 0);
  const addPage = (label: string) => {
    const pages = pagesFor(label);
    setShownPages({ ...shownPages, [label]: pages + 1 });
    setCursor({ ...cursor, [label]: pages * PER_PAGE });
  };
  const step = (delta: number) => {
    if (!current) return;
    const i = tabPhotos.indexOf(current);
    const next = tabPhotos[Math.min(tabPhotos.length - 1, Math.max(0, i + delta))];
    if (next) setFocus(next);
  };

  const url = (p: string, w: number) => `/api/photo-file?jobRoot=${encodeURIComponent(jobRoot)}&path=${encodeURIComponent(p)}&w=${w}`;
  const name = (p: string) => p.split("/").pop();
  const iaPick = section.state.selectedPhotoPathsByReport?.ia ?? section.state.selectedPhotoPaths;
  const groupLabels = [...new Set([...groups.map((g) => g.label), ...STANDARD_GROUPS])].sort((a, b) => labelRank(a) - labelRank(b));
  // Right-hand pages: every group this job has photos for, plus any a photo was moved into -- each
  // with at least one page, so there's always somewhere to drop.
  const pageGroups = [...new Set([...groups.map((g) => g.label), ...Object.keys(layout).filter((l) => layout[l].some(Boolean))])].sort(
    (a, b) => labelRank(a) - labelRank(b)
  );
  const currentSlot = current ? slotOf(current) : null;

  return (
    <div
      className="photo-picker"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === "SELECT") return;
        if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
        else if (e.key === " " && current) toggle(current);
        else if ((e.key === "Backspace" || e.key === "Delete") && current) remove(current);
        else return;
        e.preventDefault();
      }}
    >
      <div className="photo-picker-source">
        <div className="photo-filter-tabs">
          {groups.map((g) => (
            <button key={g.label} type="button" className={`photo-filter-tab ${g.label === tab ? "active" : ""}`} onClick={() => setTab(g.label)}>
              {g.label} ({g.count})
            </button>
          ))}
        </div>

        {current ? (
          <div className="photo-preview">
            <img src={url(current, 1400)} alt={current} draggable onDragStart={() => setDragging(current)} onDragEnd={() => setDragging(null)} />
            <div className="photo-preview-bar">
              <button type="button" className="secondary" onClick={() => step(-1)} disabled={tabPhotos.indexOf(current) <= 0}>
                ←
              </button>
              <span className="photo-preview-name">
                {name(current)} · {tabPhotos.indexOf(current) + 1} of {tabPhotos.length}
                {currentSlot && (
                  <strong>
                    {" "}
                    · Page {currentSlot.page}, slot {currentSlot.slot}
                  </strong>
                )}
              </span>
              <button type="button" className="secondary" onClick={() => step(1)} disabled={tabPhotos.indexOf(current) >= tabPhotos.length - 1}>
                →
              </button>
              <button type="button" className={isPlaced(current) ? "secondary" : ""} onClick={() => toggle(current)}>
                {isPlaced(current) ? "Remove from report" : "Add to report"}
              </button>
              <select
                value={groupOf(current).label}
                title="Print this photo under a different group"
                onChange={(e) => {
                  const label = e.target.value;
                  if (isPlaced(current)) {
                    const slots = layout[label] ?? [];
                    let i = 0;
                    while (slots[i]) i++;
                    placeAt(current, label, i);
                  } else save(layout, withGroup(current, label));
                }}
              >
                {groupLabels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <p className="file-count">{hideUsed ? "Every photo in this group is already in the report." : "No photos in this group."}</p>
        )}

        <div className="photo-picker-tools">
          <label>
            <input type="checkbox" checked={hideUsed} onChange={(e) => setHideUsed(e.target.checked)} /> Hide photos already in the report
          </label>
          <span className="file-count">Drag a photo onto its slot, or ← → and Space</span>
        </div>
        <div className="photo-strip">
          {tabPhotos.map((p) => {
            const at = slotOf(p);
            return (
              <div
                key={p}
                className={`photo-strip-tile ${p === current ? "current" : ""} ${at ? "used" : ""}`}
                onClick={() => setFocus(p)}
                onDoubleClick={() => toggle(p)}
                draggable
                onDragStart={() => setDragging(p)}
                onDragEnd={() => setDragging(null)}
                title="Click to view, double-click to add / remove, or drag onto a slot"
              >
                <img src={url(p, 360)} alt={p} loading="lazy" decoding="async" draggable={false} />
                {at && (
                  <span className="photo-slot-badge">
                    Pg {at.page} · {at.slot}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="photo-picker-pages">
        <div className="photo-picker-pages-head">
          <strong>In the report ({placedCount})</strong>
          {reportType === "final" && iaPick && iaPick.length > 0 && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const next: Layout = {};
                for (const g of groupPhotos(iaPick.filter((p) => all.includes(p)), overrides)) next[g.label] = g.paths;
                save(next);
              }}
            >
              Start from the I&amp;A&apos;s pick
            </button>
          )}
        </div>
        {pageGroups.map((label) => {
          const slots = layout[label] ?? [];
          const count = slots.filter(Boolean).length;
          const pages = pagesFor(label);
          return (
            <div key={label} className="photo-group-pages">
              <div className="photo-group-head">
                <span>
                  {label}: {count} photo{count === 1 ? "" : "s"}
                </span>
                <span className="photo-group-actions">
                  <button type="button" className="link-button" onClick={() => addPage(label)}>
                    + Add page
                  </button>
                  {count > 0 && (
                    <button type="button" className="link-button" onClick={() => save({ ...layout, [label]: [] })}>
                      Clear
                    </button>
                  )}
                </span>
              </div>
              {Array.from({ length: pages }, (_, page) => (
                <div key={page} className="photo-page">
                  <div className="photo-page-title">Page {page + 1}</div>
                  <div className="photo-page-slots">
                    {Array.from({ length: PER_PAGE }, (_, k) => {
                      const index = page * PER_PAGE + k;
                      const p = slots[index] ?? null;
                      return (
                        <div
                          key={k}
                          className={`photo-slot ${p ? "filled" : ""} ${p && p === current ? "current" : ""} ${dragging ? "drop-ready" : ""}`}
                          draggable={Boolean(p)}
                          onDragStart={() => p && setDragging(p)}
                          onDragEnd={() => setDragging(null)}
                          onDragOver={(e) => dragging && e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragging && dragging !== p) placeAt(dragging, label, index);
                            setDragging(null);
                          }}
                          onClick={() => {
                            if (!p) return;
                            setTab(groupOf(p).label);
                            setFocus(p);
                          }}
                        >
                          <span className="photo-slot-number">{k + 1}</span>
                          {p ? (
                            <>
                              <img src={url(p, 360)} alt={p} draggable={false} />
                              <button
                                type="button"
                                className="photo-slot-remove"
                                title="Take out of the report"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  remove(p);
                                }}
                              >
                                ✕
                              </button>
                            </>
                          ) : (
                            <span className="photo-slot-empty">{index === 0 && count === 0 ? "Drag photos here" : ""}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
