"use client";

// ============================================================
// GlassDesk — desktop icons + selection layer. The ~/Desktop
// folder (fs node "f-desk") is the source of truth; icon
// positions ride in that folder's content as JSON
// {pos:{name:[col,row]}} — synced via plain fs:upsert ops, so
// both seats see identical arrangements.
//
//  • double-click: file → TextEdit, folder → Files, app → app
//  • single click: select (soft emerald halo)
//  • drag: grid-snapped reposition (synced on release)
//  • right-click: open / rename / delete context menu
//  • inline rename with live conflict check
//  • rubber-band (marquee) multi-select on empty desktop bg
//
// SELECTION IS SEAT-LOCAL (deliberate): like remote cursors, a
// marquee rectangle is per-seat UI state. Selected ids + band
// geometry live only in this component — zero sync ops, the
// types.ts op contract stays frozen.
//
// HARD-WON INVARIANTS (do not regress — a past crash + jank
// came from violating these):
//  • NEVER touch e.currentTarget inside a state updater or any
//    deferred callback — React re-invokes functional updaters
//    during render (StrictMode double-invokes them too) and the
//    synthetic event is spent by then. Capture element/id/rect
//    values SYNCHRONOUSLY, before any setState.
//  • NO layout reads during pointermove. The marquee measures
//    the root ONCE at pointerdown (one getBoundingClientRect
//    per gesture, never per move) and hit-tests icons with
//    pure grid math from `placed`.
//  • The marquee rect animates ONLY transform: a fixed 1×1 div
//    at the anchor, translate + scaleX/scaleY (origin top-left,
//    sign-flip covers all four drag directions) driven by
//    motion values — zero React re-renders per move. The
//    hairline outline is a second 1×1 rect expanded by a
//    constant 2px (translate −1,−1 / scale +2): CSS borders
//    would stretch 300× under the transform; this stays crisp.
//    Only the intersecting-id Set ever re-renders, and only
//    when it actually changes.
//  • Marquee vs other gestures: it arms ONLY on left-button
//    pointerdown whose target is the background div itself
//    (icons/windows/dock swallow their own pointerdown first),
//    and pointer capture on the root keeps icon hover + drag
//    inert mid-band, so an icon drag can never race it.
// ============================================================

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { FileText, Folder, Pencil, Trash2 } from "lucide-react";
import { AppIcon, type IconId } from "@/components/vpc/icons/AppIcon";
import { openApp } from "./Dock";
import { openContextMenu } from "./ContextMenu";
import { SPRING } from "@/lib/vpc/motion";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { moveToTrash } from "@/lib/vpc/trash";
import {
  APP_KINDS,
  DESKTOP_NODE_ID,
  fsChildren,
  iconPositionsContent,
  iconPositionsOf,
  uid,
  type AppKind,
  type FSNode,
} from "@/lib/vpc/types";

const CELL_W = 92;
const CELL_H = 104;
const GRID_X = 24;
const GRID_Y = 18;
const MAX_COLS = 8; // rows flow downward

// hit-test box of one icon button: w-[84px] wide, and
// p-1.5 + 48px AppIcon tile + gap-1 + two 11px label lines + p-1.5 tall
const ICON_W = 84;
const ICON_H = 90;
// pointer travel (px) before the rubber band becomes visible
const MARQUEE_EPS = 4;
// total visual stroke of the rubber band (px) — kept constant by
// expanding the outline rect (see header), NOT by a CSS border
const MARQUEE_STROKE = 2;

function posToXY(col: number, row: number): { x: number; y: number } {
  return { x: GRID_X + col * CELL_W, y: GRID_Y + row * CELL_H };
}

function xyToPos(x: number, y: number): [number, number] {
  return [
    Math.max(0, Math.min(MAX_COLS - 1, Math.round((x - GRID_X) / CELL_W))),
    Math.max(0, Math.round((y - GRID_Y) / CELL_H)),
  ];
}

// ---- AppIcon id mapping (10-a's icon system) ----
// app shortcuts → their AppKind, folders → "folder", files →
// type by extension, everything else → "file".

const VIDEO_EXT = new Set(["mp4", "mov", "avi", "mkv", "webm"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"]);
const ARCHIVE_EXT = new Set(["zip", "tar", "gz", "rar", "7z", "bz2", "xz"]);
const TEXT_EXT = new Set(["txt", "md", "json", "csv", "log", "yml", "yaml", "py", "sh", "css", "html"]);

function iconIdFor(node: FSNode): IconId {
  if (node.kind === "app") {
    const app = node.content as AppKind;
    return APP_KINDS.includes(app) ? app : "file";
  }
  if (node.kind === "folder") return "folder";
  const ext = node.name.toLowerCase().split(".").pop() ?? "";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (IMAGE_EXT.has(ext)) return "image";
  if (ARCHIVE_EXT.has(ext)) return "archive";
  if (TEXT_EXT.has(ext)) return "text";
  return "file";
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Live marquee gesture (all coordinates desktop-local px). */
interface MarqueeGesture {
  ax: number; // anchor x
  ay: number; // anchor y
  rootLeft: number; // root rect origin — measured ONCE at pointerdown
  rootTop: number;
  active: boolean; // true once travel exceeds MARQUEE_EPS
}

export default function DesktopIcons() {
  const fs = useGlassDesk((s) => s.state?.fs);
  const dispatch = useGlassDesk((s) => s.dispatch);

  // SEAT-LOCAL selection (multi via marquee — never synced)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // drag: local pixel override while dragging (converted to grid on release)
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  // rubber band visibility only — geometry rides motion values
  const [marqueeOn, setMarqueeOn] = useState(false);

  const dragBase = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const marquee = useRef<MarqueeGesture | null>(null);
  const liveSel = useRef<Set<string>>(new Set());

  // marquee geometry as motion values → transform-only updates,
  // zero re-renders while the band is being dragged
  const mvX = useMotionValue(0);
  const mvY = useMotionValue(0);
  const mvW = useMotionValue(0); // scaleX of the 1×1 fill rect
  const mvH = useMotionValue(0); // scaleY
  // hairline outline: the same band expanded by a constant
  // MARQUEE_STROKE px on every side — uniform in all 4 directions
  const outX = useTransform(mvX, (v) => v - MARQUEE_STROKE / 2);
  const outY = useTransform(mvY, (v) => v - MARQUEE_STROKE / 2);
  const outW = useTransform(mvW, (v) => v + MARQUEE_STROKE);
  const outH = useTransform(mvH, (v) => v + MARQUEE_STROKE);

  const deskNode: FSNode | undefined = fs ? fs[DESKTOP_NODE_ID] : undefined;
  const icons = useMemo(() => (fs ? fsChildren(fs, DESKTOP_NODE_ID) : []), [fs]);
  const positions = useMemo(() => iconPositionsOf(deskNode), [deskNode]);

  // auto-layout for un-positioned icons: append below existing ones
  const placed = useMemo(() => {
    const used = new Set(Object.values(positions).map((p) => `${p[0]},${p[1]}`));
    let autoRow = 0;
    const out: { node: FSNode; x: number; y: number; iconId: IconId }[] = [];
    for (const node of icons) {
      const pos = positions[node.name];
      if (pos) {
        out.push({ node, ...posToXY(pos[0], pos[1]), iconId: iconIdFor(node) });
        continue;
      }
      while (used.has(`0,${autoRow}`)) autoRow += 1;
      used.add(`0,${autoRow}`);
      out.push({ node, ...posToXY(0, autoRow), iconId: iconIdFor(node) });
    }
    return out;
  }, [icons, positions]);

  // Escape clears the live band + the committed selection. The
  // listener exists only while something is clearable and is
  // always removed on cleanup (no leaks across unmounts).
  const hasSelection = selected.size > 0;
  useEffect(() => {
    if (!marqueeOn && !hasSelection) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      marquee.current = null;
      liveSel.current = new Set();
      setMarqueeOn(false);
      setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [marqueeOn, hasSelection]);

  if (!fs) return null;

  // ---- fs helpers (ops sync everything) ----

  function savePositions(next: Record<string, [number, number]>): void {
    const node = useGlassDesk.getState().state?.fs[DESKTOP_NODE_ID];
    if (!node) return;
    dispatch({ t: "fs:upsert", node: { ...node, content: iconPositionsContent(next), updatedAt: Date.now() } });
  }

  function openNode(node: FSNode): void {
    if (node.kind === "folder") openApp("files", { cwd: node.id });
    else if (node.kind === "app") openApp(node.content as AppKind);
    else openApp("textedit", { fileId: node.id, value: node.content });
  }

  function commitRename(node: FSNode): void {
    const name = renameDraft.trim();
    setRenaming(null);
    if (!name || name === node.name || !fs) return;
    const siblings = fsChildren(fs, node.parent);
    if (siblings.some((n) => n.id !== node.id && n.name === name)) return; // conflict → abort
    // move position entry to the new name
    const pos = { ...iconPositionsOf(deskNode) };
    if (pos[node.name]) {
      delete pos[node.name];
      pos[name] = [Math.round(0), 0];
      // keep actual cell: recompute from placement
      const entry = placed.find((p) => p.node.id === node.id);
      if (entry) pos[name] = xyToPos(entry.x, entry.y);
    }
    dispatch({ t: "fs:upsert", node: { ...node, name, updatedAt: Date.now() } });
    savePositions(pos);
  }

  // ---- icon drag (grid-snapped) ----

  function onIconPointerDown(e: ReactPointerEvent<HTMLButtonElement>, node: FSNode, x: number, y: number): void {
    if (e.button !== 0) return;
    setSelected(new Set([node.id]));
    dragBase.current = { px: e.clientX, py: e.clientY, x, y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onIconPointerMove(e: ReactPointerEvent<HTMLButtonElement>): void {
    const base = dragBase.current;
    if (!base) return;
    // capture BEFORE the updater: e.currentTarget is nulled once the event
    // dispatch ends, and React re-invokes functional updaters during render
    // (StrictMode double-invokes them too) — accessing it there crashes.
    const id = e.currentTarget.dataset.id ?? "";
    const x = base.x + (e.clientX - base.px);
    const y = base.y + (e.clientY - base.py);
    setDrag((d) => (d && Math.abs(d.x - x) < 2 && Math.abs(d.y - y) < 2 ? d : { id, x, y }));
  }

  function onIconPointerUp(e: ReactPointerEvent<HTMLButtonElement>, node: FSNode): void {
    const base = dragBase.current;
    dragBase.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!base) return;
    const x = base.x + (e.clientX - base.px);
    const y = base.y + (e.clientY - base.py);
    setDrag(null);
    if (Math.abs(x - base.x) < 4 && Math.abs(y - base.y) < 4) return; // click, not drag
    const cell = xyToPos(x, y);
    const pos = { ...iconPositionsOf(deskNode) };
    // collision: swap with whoever owns the target cell
    const occupant = icons.find((n) => {
      const p = pos[n.name];
      return n.id !== node.id && p && p[0] === cell[0] && p[1] === cell[1];
    });
    const mine = pos[node.name] ?? xyToPos(base.x, base.y);
    pos[node.name] = cell;
    if (occupant) pos[occupant.name] = [mine[0], mine[1]];
    savePositions(pos);
  }

  // ---- rubber-band (marquee) selection ----
  // Arming rule: left button ONLY, and ONLY when the pointerdown
  // lands on the background div itself — icon children swallow
  // their own pointerdown, windows/dock/menubar live in layers
  // above and never let the event reach this div. Pointer capture
  // on the root keeps the gesture alive across icons + off-desk
  // travel and freezes icon hover mid-band.

  function onRootPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return; // right/middle-click keeps the selection
    if (e.target !== e.currentTarget) return; // an icon child owns it
    // capture everything synchronously (NEVER defer currentTarget)
    const rootEl = e.currentTarget;
    const rect = rootEl.getBoundingClientRect(); // the ONE read per gesture
    setSelected(new Set()); // plain click on empty desktop clears
    liveSel.current = new Set();
    marquee.current = {
      ax: e.clientX - rect.left,
      ay: e.clientY - rect.top,
      rootLeft: rect.left,
      rootTop: rect.top,
      active: false,
    };
    try {
      rootEl.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
  }

  function onRootPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const m = marquee.current;
    if (!m) return;
    const x = e.clientX - m.rootLeft;
    const y = e.clientY - m.rootTop;
    if (!m.active) {
      if (Math.abs(x - m.ax) < MARQUEE_EPS && Math.abs(y - m.ay) < MARQUEE_EPS) return;
      m.active = true;
      // seed BEFORE showing so the band never flashes stale coords
      mvX.set(m.ax);
      mvY.set(m.ay);
      mvW.set(0);
      mvH.set(0);
      setMarqueeOn(true);
    }
    // transform-only band update — no React render
    mvX.set(m.ax);
    mvY.set(m.ay);
    mvW.set(x - m.ax); // negative ⇒ flips left (origin top-left)
    mvH.set(y - m.ay);
    // live highlight — pure grid-math hit test, zero DOM reads
    const x0 = Math.min(m.ax, x);
    const x1 = Math.max(m.ax, x);
    const y0 = Math.min(m.ay, y);
    const y1 = Math.max(m.ay, y);
    const hit = new Set<string>();
    for (const p of placed) {
      if (p.x < x1 && p.x + ICON_W > x0 && p.y < y1 && p.y + ICON_H > y0) hit.add(p.node.id);
    }
    if (!sameIds(hit, liveSel.current)) {
      liveSel.current = hit;
      setSelected(hit);
    }
  }

  function onRootPointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    const m = marquee.current;
    if (!m) return;
    marquee.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* already released */
    }
    // commit: whatever is highlighted stays selected; a plain
    // click on empty space already cleared at pointerdown
    if (m.active) setMarqueeOn(false);
  }

  // ---- context menus ----

  function onIconContextMenu(e: React.MouseEvent<HTMLButtonElement>, node: FSNode): void {
    e.preventDefault();
    e.stopPropagation();
    // right-click keeps an existing multi-selection (future bulk
    // context actions); it only selects when the node isn't in it
    if (!selected.has(node.id)) setSelected(new Set([node.id]));
    openContextMenu(e.clientX, e.clientY, [
      {
        id: "open",
        label: node.kind === "folder" ? "Open in Files" : "Open",
        icon: node.kind === "folder" ? <Folder size={13} /> : <FileText size={13} />,
        onSelect: () => openNode(node),
      },
      {
        id: "rename",
        label: "Rename",
        icon: <Pencil size={13} />,
        onSelect: () => {
          setRenaming(node.id);
          setRenameDraft(node.name);
        },
      },
      { id: "sep", separator: true },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => {
          // soft delete — the node moves into the Trash folder (synced),
          // nothing is lost until someone empties it in Files
          moveToTrash(node);
          pushToast({ title: `"${node.name}" moved to Trash`, body: "Find it in Files → Trash.", kind: "info" });
        },
      },
    ]);
  }

  return (
    <div
      className="absolute inset-0 z-[5] cursor-default touch-none select-none"
      onPointerDown={onRootPointerDown}
      onPointerMove={onRootPointerMove}
      onPointerUp={onRootPointerUp}
      onPointerCancel={onRootPointerUp}
    >
      {/* rubber band — UNDER the icons (z-0 vs z-10), ABOVE the
          wallpaper (this whole layer is z-[5] over the parallax
          layer). Transform-only: 1×1 rects at the anchor, scaled
          to the drag; the second rect is the same band expanded
          by a constant 2px → a hairline frame that never
          stretches. Geometry rides motion values (no re-renders). */}
      {marqueeOn && (
        <>
          <motion.div
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 z-0 h-px w-px origin-top-left bg-emerald-600/45"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12 }}
            style={{ x: outX, y: outY, scaleX: outW, scaleY: outH }}
          />
          <motion.div
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 z-0 h-px w-px origin-top-left bg-emerald-400/15"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12 }}
            style={{ x: mvX, y: mvY, scaleX: mvW, scaleY: mvH }}
          />
        </>
      )}

      {placed.map(({ node, x, y, iconId }) => {
        const isDrag = drag && drag.id === node.id;
        const px = isDrag ? drag.x : x;
        const py = isDrag ? drag.y : y;
        const isSel = selected.has(node.id);
        return (
          <motion.button
            key={node.id}
            type="button"
            data-id={node.id}
            aria-label={`${node.name}, ${node.kind}${isSel ? ", selected" : ""}`}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: isSel ? 1.04 : 1, left: px, top: py }}
            transition={SPRING.snappy}
            whileHover={{ scale: 1.05 }}
            onDoubleClick={() => openNode(node)}
            onPointerDown={(e) => onIconPointerDown(e, node, x, y)}
            onPointerMove={onIconPointerMove}
            onPointerUp={(e) => onIconPointerUp(e, node)}
            onContextMenu={(e) => onIconContextMenu(e, node)}
            className={`absolute flex w-[84px] touch-none select-none flex-col items-center gap-1 rounded-xl p-1.5 text-center focus-visible:outline-none ${
              isSel
                ? "bg-emerald-400/10 shadow-md ring-2 ring-emerald-400/70"
                : "hover:bg-white/40"
            } ${isDrag ? "z-20 cursor-grabbing scale-105 shadow-xl" : "z-10"}`}
            style={{ left: px, top: py }}
          >
            <AppIcon id={iconId} size={48} />
            {renaming === node.id ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => commitRename(node)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(node);
                  if (e.key === "Escape") setRenaming(null);
                }}
                onFocus={(e) => e.target.select()}
                spellCheck={false}
                className="w-full rounded-md border border-white/80 bg-white/90 px-1 py-0.5 text-center text-[11px] text-stone-700 focus:outline-none focus:ring-2 focus:ring-[var(--gd-accent)]"
              />
            ) : (
              <span
                className={`line-clamp-2 w-full break-words rounded-md px-0.5 text-[11px] font-medium leading-tight ${
                  isSel
                    ? "bg-emerald-900/90 text-white"
                    : "text-stone-700 [text-shadow:0_1px_2px_rgba(255,255,255,0.9)]"
                }`}
              >
                {node.name}
              </span>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}

/** Create a fresh node inside ~/Desktop (used by the desktop context menu). */
export function createOnDesktop(kind: "file" | "folder"): void {
  const s = useGlassDesk.getState();
  if (!s.state) return;
  const fs = s.state.fs;
  const siblings = fsChildren(fs, DESKTOP_NODE_ID);
  const base = kind === "folder" ? "New Folder" : "Untitled.txt";
  let name = base;
  let n = 2;
  while (siblings.some((x) => x.name === name)) {
    name = kind === "folder" ? `New Folder (${n})` : `Untitled ${n}.txt`;
    n += 1;
  }
  const node: FSNode = {
    id: uid(),
    name,
    kind,
    parent: DESKTOP_NODE_ID,
    content: "",
    updatedAt: Date.now(),
  };
  s.dispatch({ t: "fs:upsert", node });
}

/** Reset icon positions (auto-layout). */
export function cleanUpIcons(): void {
  const s = useGlassDesk.getState();
  const desk = s.state?.fs[DESKTOP_NODE_ID];
  if (!desk) return;
  s.dispatch({ t: "fs:upsert", node: { ...desk, content: iconPositionsContent({}), updatedAt: Date.now() } });
}

/** Re-layout icons into a name-ordered, column-major grid (fills each
 *  column top→bottom before moving right). Positions persist through the
 *  usual Desktop-folder-content upsert, so both seats + snapshots stay in
 *  sync. Exported for the desktop context-menu integrator (Desktop.tsx). */
export function sortIconsByName(): void {
  const s = useGlassDesk.getState();
  const fs = s.state?.fs;
  const desk = fs?.[DESKTOP_NODE_ID];
  if (!fs || !desk) return;
  const rows =
    typeof window === "undefined"
      ? 6
      : Math.max(4, Math.floor((window.innerHeight - GRID_Y - 96) / CELL_H));
  const kids = fsChildren(fs, DESKTOP_NODE_ID).sort((a, b) => a.name.localeCompare(b.name));
  const pos: Record<string, [number, number]> = {};
  kids.forEach((node, i) => {
    const col = Math.floor(i / rows);
    if (col >= MAX_COLS) return; // overflow falls back to auto-layout
    pos[node.name] = [col, i % rows];
  });
  s.dispatch({ t: "fs:upsert", node: { ...desk, content: iconPositionsContent(pos), updatedAt: Date.now() } });
}
