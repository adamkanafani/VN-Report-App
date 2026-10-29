"use client";

import { useMemo, useState } from "react";
import type { JobFile } from "@/lib/ingest/fileWalk";
import type { SectionState } from "@/lib/state/jobState";
import { groupPhotos, labelRank, photoGroupOf, photoPick, PHOTOS_PER_REPORT_PAGE } from "@/lib/pdf/photoGroups";

// Group titles a photo can always be moved into, besides whatever the job's own folders produce.
const STANDARD_GROUPS = ["Shipping Photos", "NDT Photos", "Incoming Photos", "Final Photos"];

/**
 * The photo section laid out as the report prints it: pages of six slots per group (Shipping, NDT,
 * Incoming, Final), filled from the job's photos on the left. What's arranged on the right is
 * exactly what the PDF and PowerPoint print, in that order. Every photo already placed shows its
 * page and slot on the left, so cycling through a few hundred shots never loses track of what's
 * been used. Keyboard: ← → to step through photos, Space to add / remove, Backspace to remove.
 * The I&A and the Final keep separate picks (see photoPick).
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
  const [order, setOrder] = useState<string[]>(() => photoPick(section, section.state, reportType));
  const [overrides, setOverrides] = useState<Record<string, string>>(() => ({ ...section.state.photoGroupOverrides }));
  const groupOf = (p: string) => photoGroupOf(p, overrides);

  // Left-hand tabs: every group the job's photos fall into, in report order.
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of all) counts.set(photoGroupOf(p, overrides).label, (counts.get(photoGroupOf(p, overrides).label) ?? 0) + 1);
    return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => labelRank(a.label) - labelRank(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.matchedFiles, overrides]);
  const [tab, setTab] = useState(groups[0]?.label ?? "");
  const [hideUsed, setHideUsed] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const placed = groupPhotos(order, overrides);
  const slotOf = (p: string) => {
    for (const g of placed) {
      const i = g.paths.indexOf(p);
      if (i !== -1) return { page: Math.floor(i / PHOTOS_PER_REPORT_PAGE) + 1, slot: (i % PHOTOS_PER_REPORT_PAGE) + 1 };
    }
    return null;
  };
  const tabPhotos = all.filter((p) => groupOf(p).label === tab && (!hideUsed || !order.includes(p) || p === focus));
  const current = focus && tabPhotos.includes(focus) ? focus : (tabPhotos[0] ?? null);

  const save = (nextOrder: string[], nextOverrides = overrides) => {
    setOrder(nextOrder);
    setOverrides(nextOverrides);
    fetch("/api/section-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobRoot,
        sectionId: section.id,
        patch: {
          selectedPhotoPathsByReport: { ...section.state.selectedPhotoPathsByReport, [reportType]: nextOrder },
          photoGroupOverrides: nextOverrides,
        },
      }),
    });
  };
  const add = (p: string) => !order.includes(p) && save([...order, p]);
  const remove = (p: string) => save(order.filter((x) => x !== p));
  const toggle = (p: string) => (order.includes(p) ? remove(p) : add(p));
  // Into group `label`: the photo's own folder group needs no override.
  const withGroup = (p: string, label: string) => {
    const next = { ...overrides };
    if (photoGroupOf(p).label === label) delete next[p];
    else next[p] = label;
    return next;
  };
  // Dropped on a placed photo: take its spot (and its group).
  const moveBefore = (from: string, to: string) => {
    if (from === to) return;
    const next = order.filter((x) => x !== from);
    next.splice(next.indexOf(to), 0, from);
    save(next, withGroup(from, groupOf(to).label));
  };
  // Dropped on an empty slot of group `label`: last in that group.
  const moveToEnd = (from: string, label: string) => {
    const nextOverrides = withGroup(from, label);
    const rest = order.filter((x) => x !== from);
    const lastOfGroup = rest.map((x) => photoGroupOf(x, nextOverrides).label).lastIndexOf(label);
    rest.splice(lastOfGroup === -1 ? rest.length : lastOfGroup + 1, 0, from);
    save(rest, nextOverrides);
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
  // Right-hand pages: every group with photos placed, plus the open tab's group (to drop into).
  const pageGroups = [...placed];
  if (tab && !pageGroups.some((g) => g.label === tab)) pageGroups.push({ label: tab, paths: [] });
  pageGroups.sort((a, b) => labelRank(a.label) - labelRank(b.label));
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
            <img src={url(current, 1400)} alt={current} />
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
              <button type="button" className={order.includes(current) ? "secondary" : ""} onClick={() => toggle(current)}>
                {order.includes(current) ? "Remove from report" : "Add to report"}
              </button>
              <select
                value={groupOf(current).label}
                title="Print this photo under a different group"
                onChange={(e) => {
                  const nextOverrides = withGroup(current, e.target.value);
                  save(order, nextOverrides);
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
          <span className="file-count">← → to look through, Space to add / remove</span>
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
                title="Click to view, double-click to add / remove, or drag onto a page"
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
          <strong>In the report ({order.length})</strong>
          {reportType === "final" && iaPick && iaPick.length > 0 && (
            <button type="button" className="secondary" onClick={() => save(iaPick.filter((p) => all.includes(p)))}>
              Start from the I&amp;A&apos;s pick
            </button>
          )}
        </div>
        {pageGroups.map((g) => {
          const pageCount = Math.max(1, Math.ceil(g.paths.length / PHOTOS_PER_REPORT_PAGE));
          return (
            <div key={g.label} className="photo-group-pages">
              <div className="photo-group-head">
                <span>
                  {g.label}: {g.paths.length} photo{g.paths.length === 1 ? "" : "s"} · {g.paths.length === 0 ? 0 : pageCount} page{pageCount === 1 && g.paths.length > 0 ? "" : "s"}
                </span>
                {g.paths.length > 0 && (
                  <button type="button" className="link-button" onClick={() => save(order.filter((p) => !g.paths.includes(p)))}>
                    Clear
                  </button>
                )}
              </div>
              {Array.from({ length: pageCount }, (_, page) => (
                <div key={page} className="photo-page">
                  <div className="photo-page-title">Page {page + 1}</div>
                  <div className="photo-page-slots">
                    {Array.from({ length: PHOTOS_PER_REPORT_PAGE }, (_, k) => {
                      const p = g.paths[page * PHOTOS_PER_REPORT_PAGE + k];
                      return (
                        <div
                          key={k}
                          className={`photo-slot ${p ? "filled" : ""} ${p && p === current ? "current" : ""}`}
                          draggable={Boolean(p)}
                          onDragStart={() => p && setDragging(p)}
                          onDragEnd={() => setDragging(null)}
                          onDragOver={(e) => dragging && e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (!dragging) return;
                            if (p) moveBefore(dragging, p);
                            else moveToEnd(dragging, g.label);
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
                            <span className="photo-slot-empty">{k === 0 && g.paths.length === 0 ? "Drop or add photos" : ""}</span>
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
