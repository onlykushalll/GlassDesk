"use client";

// ============================================================
// GlassDesk — a desktop window (OS-grade). Window Manager 2.0.
//
// Positioning model (derived, no sync effects):
//   • render geometry = `override ?? win` — remote geom updates
//     render directly and animate through a CSS transition; while WE
//     drag/resize, a local `override` is the source (60fps pointer
//     capture, `transition-none`)
//   • live `win:geom` ops are throttled to ~30Hz with a final
//     forced flush on release
//
// OS features layered on top:
//   • EDGE SNAP (Windows 11 Aero-snap): while dragging, the pointer
//     entering edge/corner zones lights a glass preview; releasing
//     there snaps the window (halves / quarters / top = maximize)
//   • SNAP ASSIST (Windows 11): after a half-snap commits, a glass
//     panel fills the REMAINING half and offers the other visible
//     windows to fill it (pick · 6 s · Escape · click-away) —
//     see SnapAssist.tsx; trigger + geometry live here
//   • SNAP LAYOUTS (Win11): hovering the maximize button blooms a
//     6-zone layout picker — halves, top-amps, quarters
//   • 8-DIRECTION RESIZE: N/S/E/W invisible 6px pointer strips
//     (hover lights a 2px accent edge highlight) + visible 14px
//     corner grips (NE/NW/SW; SE keeps the chunky grip).
//     Min 320×220, clamped inside the desktop area, correct
//     cursors; shares the drag `override` so resize disables drag
//   • DOUBLE-CLICK titlebar → maximize/restore, parking the
//     restore geometry exactly like the top-edge snap
//   • MINIMIZE = "sucked into the taskbar": spring scale→0.55 +
//     translate toward the taskbar + fade to 0. The window STAYS
//     MOUNTED (iframes/audio keep running) and sits inert at
//     opacity 0 with pointer-events none — driven by animate
//     values, never conditional rendering
//   • ACTIVE vs INACTIVE: the top-z VISIBLE window of the current
//     workspace keeps the full shadow + crisp traffic lights; inactive
//     windows dim via an inner filter layer (saturate .92 /
//     brightness .97, 250ms — filter + box-shadow ONLY, never the
//     mover's transform) + softer shadow + hollow stone lights
//   • TITLEBAR: app icon + title, context menu, traffic lights with
//     macOS glyph reveal (cluster-hover shows all symbols dimmed,
//     per-dot hover lights one; press scale rides SPRING.snappy)
//
// z-index note: the store's z grows unboundedly (+10 per focus),
// so we map it to a dense rank (10 + index in z-order). Stacking
// order among windows is preserved EXACTLY, and windows always
// stay under the fixed chrome (taskbar 100 / boot 60 / cursors 70).
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { AnimatePresence, motion, type TargetAndTransition } from "framer-motion";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import type { WindowState } from "@/lib/vpc/types";
import { SPRING } from "@/lib/vpc/motion";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import { APP_META } from "./Dock";
import { openContextMenu } from "./ContextMenu";
import SnapAssist from "./SnapAssist";

interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}

const EMIT_MS = 33; // live geom op throttle (~30Hz, mirrors pointer cap)
// Top inset of the usable desktop area, in ROOT-relative coordinates.
// The top menubar was removed (12-d — windows get the full height), so
// the root now spans the whole viewport: TOP_INSET is 0 and windows may
// reach y=0. Kept as a named constant so every geometry path (maximize
// park, snap clamps, launch vector, drag ceiling, resize fallback)
// stays one edit away from any future top chrome.
const TOP_INSET = 0;
const TASKBAR_H = 60; // keep clear when maximized/snapped
const GRAB_MARGIN = 140; // px of titlebar always kept reachable
const MIN_W = 320; // absolute resize floor (mission contract)
const MIN_H = 220;

// snap zone tuning (pointer-distance, root-relative)
const EDGE_PX = 22; // distance to a long edge that arms a half/max snap
const CORNER_PX = 110; // distance to a corner that arms a quarter snap
const LAYOUT_HOVER_MS = 380; // maximize-button hover before snap layouts bloom

// resize affordances (px) — thin invisible strips + visible corner grips
const STRIP_PX = 6;
const CORNER_PX_HIT = 14;

type SnapZone = "max" | "left" | "right" | "tl" | "tr" | "bl" | "br" | null;
type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

// active vs inactive window treatments (Apple-subtle, stone rgba only)
const ACTIVE_SHADOW =
  "0 24px 64px rgba(31,41,55,0.18), 0 1px 0 rgba(255,255,255,0.75) inset, 0 -1px 0 rgba(255,255,255,0.25) inset, 0 0 0 1px rgba(255,255,255,0.45) inset";
const IDLE_SHADOW =
  "0 10px 28px rgba(31,41,55,0.09), 0 1px 0 rgba(255,255,255,0.6) inset, 0 0 0 1px rgba(255,255,255,0.35) inset";

interface RootRect {
  left: number;
  top: number;
  w: number;
  h: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Rect for a snap zone, in ROOT coordinates (usable area excludes taskbar). */
function zoneRect(zone: Exclude<SnapZone, null>, rootW: number): Geom {
  const H = window.innerHeight - TOP_INSET - TASKBAR_H;
  const half = Math.floor(rootW / 2);
  const halfH = Math.floor(H / 2);
  switch (zone) {
    case "max":
      return { x: 0, y: 0, w: rootW, h: H };
    case "left":
      return { x: 0, y: 0, w: half, h: H };
    case "right":
      return { x: rootW - half, y: 0, w: half, h: H };
    case "tl":
      return { x: 0, y: 0, w: half, h: halfH };
    case "tr":
      return { x: rootW - half, y: 0, w: half, h: halfH };
    case "bl":
      return { x: 0, y: H - halfH, w: half, h: halfH };
    case "br":
      return { x: rootW - half, y: H - halfH, w: half, h: halfH };
  }
}

/** Diagonal stripes for the visible corner grips (matches the SE grip). */
function gripStyle(deg: number): CSSProperties {
  return {
    backgroundColor: "rgba(255,255,255,0.6)",
    backgroundImage: `repeating-linear-gradient(${deg}deg, rgba(87,83,78,0.5) 0 2px, transparent 2px 5px)`,
  };
}

export interface WindowProps {
  win: WindowState;
  hidden?: boolean; // lives on another workspace — keep mounted (iframes/audio stay alive), invisible
  children: ReactNode;
}

export default function Window({ win, hidden = false, children }: WindowProps) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const siblings = useGlassDesk((s) => (s.state ? s.state.windows : null));
  const activeWs = useGlassDesk((s) => s.state?.workspace ?? 0);

  // Local geometry override — non-null ONLY while we drag/resize.
  const [override, setOverride] = useState<Geom | null>(null);
  const [interacting, setInteracting] = useState(false);

  // snap state — zone the pointer is courting + its preview rect in
  // VIEWPORT coordinates. Both are set together in drag handlers (event
  // time — render stays pure and never touches refs)
  const [snap, setSnap] = useState<{ zone: SnapZone; rect: Geom | null } | null>(null);

  // snap-layouts popover (hovering the maximize button)
  const [layoutsOpen, setLayoutsOpen] = useState(false);
  const layoutTimer = useRef<number | null>(null);
  const layoutCloseTimer = useRef<number | null>(null);
  const layoutKeepRef = useRef(false);

  // snap assist — rect of the REMAINING half after a half-snap commits.
  // `vp` is viewport coords (panel positioning), `root` is root coords
  // (the win:geom op we dispatch for the picked window).
  const [snapAssist, setSnapAssist] = useState<{ vp: Geom; root: Geom } | null>(null);

  // root dims as STATE (rAF-measured + resize subscription) — needed by
  // the render-time minimize vector; the REF below serves event-time
  // drag/resize math. Never read the ref during render.
  const [rootDims, setRootDims] = useState<RootRect | null>(null);

  const dragBase = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const resizeBase = useRef<{
    px: number;
    py: number;
    x: number;
    y: number;
    w: number;
    h: number;
    dir: ResizeDir;
  } | null>(null);
  const lastEmit = useRef(0);
  const lastGeo = useRef<Geom>({ x: win.x, y: win.y, w: win.w, h: win.h });
  // the desktop root rect, captured at drag/resize start (windows are
  // absolutely positioned inside it)
  const rootRect = useRef<RootRect | null>(null);

  // LAUNCH VECTOR (macOS): the window blooms OUT of its dock tile on mount —
  // the exact mirror of the genie minimize END state (scale .42 / scaleX 1.3
  // / scaleY .5 / rotate −1.2), so open and minimize read as one continuous
  // physical gesture. The tile rect is measured ONCE at mount (bottom-most
  // matching button inside the taskbar bar — a small, scoped scan with a
  // single rect pass, NO per-comparison layout reads); falls back to a rise
  // from the taskbar's center line when the tile can't be found.
  const launchInitial = useMemo<TargetAndTransition>(() => {
    let dx = 0;
    let dy = (typeof window !== "undefined" ? window.innerHeight - TOP_INSET : 600) / 2;
    try {
      const label = APP_META[win.app]?.label;
      if (label && typeof document !== "undefined") {
        // scope to the bottom bar so the scan stays tiny; read each rect
        // exactly once into a flat array (one layout pass, cached reads).
        const bar = document.querySelector('nav[aria-label="Taskbar"]') ?? document;
        const rects = Array.from(bar.querySelectorAll<HTMLButtonElement>("button[aria-label]"))
          .map((b) => ({ label: (b.getAttribute("aria-label") || "").split(",")[0].trim(), r: b.getBoundingClientRect() }))
          .filter((t) => t.label === label)
          .sort((a, b) => b.r.y - a.r.y);
        const tile = rects[0]?.r;
        if (tile) {
          dx = tile.x + tile.width / 2 - (win.x + win.w / 2);
          dy = tile.y + tile.height / 2 - TOP_INSET - (win.y + win.h / 2);
        }
      }
    } catch {
      /* headless/measure quirk → fallback vector */
    }
    return {
      scale: 0.42,
      scaleX: 1.3,
      scaleY: 0.5,
      rotate: -1.2,
      opacity: 0,
      x: dx,
      y: dy,
    };
    // mount-time only, by design: re-measuring per render would fight the
    // spring and re-read layout in a hot path.
  }, []);

  // Render geometry: ours while interacting, the synced win otherwise.
  const geo: Geom = override ?? { x: win.x, y: win.y, w: win.w, h: win.h };

  // Dense z-rank (see file header).
  const zIndex = useMemo(() => {
    const visible = (siblings ?? []).filter((w) => !w.minimized);
    const sorted = [...visible].sort((a, b) => a.z - b.z);
    const idx = sorted.findIndex((w) => w.id === win.id);
    return 10 + (idx < 0 ? 0 : idx);
  }, [siblings, win.id]);

  // The ACTIVE window = top-z VISIBLE (non-minimized) window on the
  // current workspace. Inactive windows fade to .96 + soft shadow.
  const activeId = useMemo(() => {
    let top: WindowState | null = null;
    for (const w of siblings ?? []) {
      if (w.minimized || (w.workspace ?? 0) !== activeWs) continue;
      if (!top || w.z > top.z) top = w;
    }
    return top?.id ?? null;
  }, [siblings, activeWs]);
  const isActive = !hidden && !win.minimized && win.id === activeId;

  // candidates for snap assist — other visible windows on this workspace
  const candidates = useMemo(
    () => (siblings ?? []).filter((w) => w.id !== win.id && !w.minimized && (w.workspace ?? 0) === activeWs),
    [siblings, win.id, activeWs],
  );

  function emitGeom(x: number, y: number, w: number, h: number, force = false): void {
    const now = performance.now();
    if (!force && now - lastEmit.current < EMIT_MS) return;
    lastEmit.current = now;
    dispatch({ t: "win:geom", id: win.id, x, y, w, h });
  }

  function focusWindow(): void {
    dispatch({ t: "win:z", id: win.id, z: useGlassDesk.getState().nextZ() });
  }

  function captureRoot(): void {
    const el = (document.querySelector("[data-gd-root]") as HTMLElement | null) ?? null;
    const r = el?.getBoundingClientRect();
    rootRect.current = r
      ? { left: r.left, top: r.top, w: r.width, h: r.height }
      : { left: 0, top: TOP_INSET, w: window.innerWidth, h: window.innerHeight - TOP_INSET };
  }

  /** Measure the desktop root into STATE — equality-bailed so unchanged
   *  measurements never re-render. Called from async callbacks only
   *  (rAF / resize listener / pointer events), never the effect body. */
  function measureRoot(): void {
    const el = (document.querySelector("[data-gd-root]") as HTMLElement | null) ?? null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    setRootDims((prev) =>
      prev && prev.left === r.left && prev.top === r.top && prev.w === r.width && prev.h === r.height
        ? prev
        : { left: r.left, top: r.top, w: r.width, h: r.height },
    );
  }

  useEffect(
    () => () => {
      if (layoutTimer.current !== null) clearTimeout(layoutTimer.current);
      if (layoutCloseTimer.current !== null) clearTimeout(layoutCloseTimer.current);
    },
    [],
  );

  // fresh root dims for the minimize vector — rAF on mount + on viewport
  // resize. setState happens inside the async callbacks (house rule).
  useEffect(() => {
    const raf = requestAnimationFrame(measureRoot);
    window.addEventListener("resize", measureRoot);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measureRoot);
    };
  }, []);

  /** Which snap zone (if any) is the pointer courting right now? */
  function zoneFromPointer(clientX: number, clientY: number): SnapZone {
    const r = rootRect.current;
    if (!r) return null;
    const x = clientX - r.left;
    const y = clientY - r.top;
    const W = r.w;
    const usableH = window.innerHeight - TOP_INSET - TASKBAR_H;
    const nearL = x < EDGE_PX;
    const nearR = x > W - EDGE_PX;
    const nearT = y < EDGE_PX;
    const nearB = y > usableH - EDGE_PX && y < usableH + EDGE_PX * 2;
    const cornerTL = x < CORNER_PX && y < CORNER_PX;
    const cornerTR = x > W - CORNER_PX && y < CORNER_PX;
    const cornerBL = x < CORNER_PX && y > usableH - CORNER_PX;
    const cornerBR = x > W - CORNER_PX && y > usableH - CORNER_PX;
    if (cornerTL) return "tl";
    if (cornerTR) return "tr";
    if (cornerBL) return "bl";
    if (cornerBR) return "br";
    if (nearT) return "max";
    if (nearL) return "left";
    if (nearR) return "right";
    if (nearB) return "max"; // dragging onto the taskbar ledge = maximize
    return null;
  }

  // ---------------- maximize helpers (shared paths) ----------------

  /** Maximize AND park the restore rect at a sane spot near the drop
   *  point — the exact code path the top-edge snap and the titlebar
   *  double-click both ride. */
  function maximizeWithPark(): void {
    dispatch({ t: "win:max", id: win.id, maximized: true });
    emitGeom(
      clamp(geo.x, 0, Math.max(0, window.innerWidth - geo.w)),
      clamp(geo.y, 0, Math.max(0, window.innerHeight - TOP_INSET - geo.h)),
      geo.w,
      geo.h,
      true,
    );
  }

  function toggleMaximize(): void {
    if (win.maximized) {
      dispatch({ t: "win:max", id: win.id, maximized: false });
    } else {
      maximizeWithPark();
    }
  }

  // ---------------- drag (title bar) ----------------

  function onDragStart(e: ReactPointerEvent<HTMLElement>): void {
    if (win.maximized || e.button !== 0) return;
    if (resizeBase.current) return; // a resize owns the override — drag is disabled
    if ((e.target as HTMLElement).closest("[data-gd-nodrag]")) return;
    captureRoot();
    dragBase.current = { px: e.clientX, py: e.clientY, x: geo.x, y: geo.y };
    lastGeo.current = geo;
    setInteracting(true);
    setSnapAssist(null); // new gesture cancels any pending snap assist
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onDragMove(e: ReactPointerEvent<HTMLElement>): void {
    if (resizeBase.current) return; // resize in flight — drag logic frozen
    const base = dragBase.current;
    if (!base) return;
    const zone = zoneFromPointer(e.clientX, e.clientY);
    const r = rootRect.current;
    setSnap((prev) => {
      if (prev?.zone === zone) return prev;
      if (!zone || !r) return null;
      const rect = zone === "max" ? zoneRect("max", r.w) : zoneRect(zone, r.w);
      // store viewport coords so the render never reads the ref
      return { zone, rect: { x: r.left + rect.x, y: r.top + rect.y, w: rect.w, h: rect.h } };
    });
    if (zone) return; // snapping — freeze the window where it is, preview leads
    const maxX = Math.max(GRAB_MARGIN, window.innerWidth - GRAB_MARGIN);
    const maxY = Math.max(TOP_INSET, window.innerHeight - TOP_INSET - 40);
    const x = clamp(base.x + (e.clientX - base.px), -(geo.w - GRAB_MARGIN), maxX);
    const y = clamp(base.y + (e.clientY - base.py), 0, maxY);
    const next = { x, y, w: geo.w, h: geo.h };
    lastGeo.current = next;
    setOverride(next);
    emitGeom(x, y, next.w, next.h);
  }

  function onDragEnd(e: ReactPointerEvent<HTMLElement>): void {
    if (!dragBase.current) return;
    dragBase.current = null;
    setInteracting(false);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* pointer already released — nothing to do */
    }
    const zone = snap?.zone ?? null;
    setSnap(null);
    if (zone && rootRect.current) {
      // snap! (top zone → real maximize; others → geometry)
      if (zone === "max") {
        maximizeWithPark();
      } else {
        const r = zoneRect(zone, rootRect.current.w);
        emitGeom(r.x, r.y, r.w, r.h, true);
        lastGeo.current = r;
        // Windows 11 snap assist — offer to fill the remaining half
        if (zone === "left" || zone === "right") showSnapAssist(zone);
      }
      setOverride(null);
      return;
    }
    const l = lastGeo.current;
    emitGeom(l.x, l.y, l.w, l.h, true); // final flush makes win == override
    setOverride(null);
  }

  // ---------------- resize (8 directions) ----------------

  function onResizeStart(e: ReactPointerEvent<HTMLDivElement>, dir: ResizeDir): void {
    if (win.maximized || e.button !== 0) return;
    // kill the native drag/text-selection machinery before it starts —
    // otherwise Chromium fires dragstart + pointercancel mid-gesture and
    // silently steals the pointer capture from the strip
    e.preventDefault();
    captureRoot();
    resizeBase.current = { px: e.clientX, py: e.clientY, x: geo.x, y: geo.y, w: geo.w, h: geo.h, dir };
    lastGeo.current = geo;
    setInteracting(true);
    setSnapAssist(null); // new gesture cancels any pending snap assist
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onResizeMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const base = resizeBase.current;
    if (!base) return;
    const meta = APP_META[win.app];
    const minW = Math.max(MIN_W, meta.minW);
    const minH = Math.max(MIN_H, meta.minH);
    const r = rootRect.current;
    const rootW = r?.w ?? window.innerWidth;
    const rootH = r && r.h > 0 ? r.h : window.innerHeight - TOP_INSET;
    const dx = e.clientX - base.px;
    const dy = e.clientY - base.py;
    let { x, y, w, h } = base;
    // opposing edges stay anchored; growth is clamped inside the desktop
    // area (x∈[0,rootW-w], y∈[0,rootH-h]) and never below the min size
    if (base.dir.includes("e")) {
      w = clamp(base.w + dx, minW, Math.max(minW, rootW - base.x));
    }
    if (base.dir.includes("s")) {
      h = clamp(base.h + dy, minH, Math.max(minH, rootH - base.y));
    }
    if (base.dir.includes("w")) {
      w = clamp(base.w - dx, minW, Math.max(minW, base.x + base.w));
      x = base.x + (base.w - w);
    }
    if (base.dir.includes("n")) {
      h = clamp(base.h - dy, minH, Math.max(minH, base.y + base.h));
      y = base.y + (base.h - h);
    }
    const next = { x, y, w, h };
    lastGeo.current = next;
    setOverride(next);
    emitGeom(x, y, w, h);
  }

  function onResizeEnd(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!resizeBase.current) return;
    resizeBase.current = null;
    setInteracting(false);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* pointer already released — nothing to do */
    }
    const l = lastGeo.current;
    emitGeom(l.x, l.y, l.w, l.h, true);
    setOverride(null);
  }

  /** One handler kit per resize direction — spread onto every strip/grip. */
  function resizeHandlers(dir: ResizeDir): {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onLostPointerCapture: (e: ReactPointerEvent<HTMLDivElement>) => void;
  } {
    return {
      onPointerDown: (e) => onResizeStart(e, dir),
      onPointerMove: onResizeMove,
      onPointerUp: onResizeEnd,
      onPointerCancel: onResizeEnd,
      onLostPointerCapture: onResizeEnd,
    };
  }

  // ---------------- snap assist ----------------

  function showSnapAssist(zone: "left" | "right"): void {
    const r = rootRect.current;
    if (!r) return;
    const remaining = zone === "left" ? "right" : "left";
    const root = zoneRect(remaining, r.w); // exact complement of the snapped half
    setSnapAssist({
      root,
      vp: { x: r.left + root.x, y: r.top + root.y, w: root.w, h: root.h },
    });
  }

  const dismissSnapAssist = useCallback(() => setSnapAssist(null), []);

  const pickSnapAssist = useCallback(
    (id: string) => {
      const sa = snapAssist;
      if (!sa) return;
      // a maximized candidate must un-maximize first — otherwise the
      // geom op only moves its (ignored) restore rect
      const target = (useGlassDesk.getState().state?.windows ?? []).find((w) => w.id === id);
      if (target?.maximized) dispatch({ t: "win:max", id, maximized: false });
      dispatch({ t: "win:geom", id, x: sa.root.x, y: sa.root.y, w: sa.root.w, h: sa.root.h });
      dispatch({ t: "win:z", id, z: useGlassDesk.getState().nextZ() });
      setSnapAssist(null);
    },
    [dispatch, snapAssist],
  );

  // ---------------- snapping helpers ----------------

  function applyZone(zone: Exclude<SnapZone, null>): void {
    captureRoot();
    const r = rootRect.current;
    const W = r?.w ?? window.innerWidth;
    if (zone === "max") {
      dispatch({ t: "win:max", id: win.id, maximized: true });
      return;
    }
    dispatch({ t: "win:max", id: win.id, maximized: false });
    const rect = zoneRect(zone, W);
    emitGeom(rect.x, rect.y, rect.w, rect.h, true);
    lastGeo.current = rect;
    if (zone === "left" || zone === "right") showSnapAssist(zone);
  }

  // ---------------- titlebar ----------------

  function onTitleDoubleClick(e: ReactMouseEvent<HTMLElement>): void {
    if ((e.target as HTMLElement).closest("[data-gd-nodrag]")) return;
    toggleMaximize();
  }

  function openTitleMenu(e: React.MouseEvent<HTMLElement>): void {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, [
      { id: "min", label: "Minimize", icon: <Minus size={13} />, onSelect: () => dispatch({ t: "win:min", id: win.id, minimized: true }) },
      {
        id: "max",
        label: win.maximized ? "Restore" : "Maximize",
        icon: <Maximize2 size={13} />,
        onSelect: () => dispatch({ t: "win:max", id: win.id, maximized: !win.maximized }),
      },
      { id: "sep1", separator: true },
      { id: "snapl", label: "Snap left", onSelect: () => applyZone("left") },
      { id: "snapr", label: "Snap right", onSelect: () => applyZone("right") },
      { id: "sep2", separator: true },
      { id: "close", label: "Close", icon: <X size={13} />, danger: true, onSelect: () => dispatch({ t: "win:close", id: win.id }) },
    ]);
  }

  // ---------------- snap layouts (hover the maximize button) ----------------

  const layoutZones: { zone: Exclude<SnapZone, null>; label: string }[] = [
    { zone: "left", label: "Left half" },
    { zone: "right", label: "Right half" },
    { zone: "tl", label: "Top-left quarter" },
    { zone: "tr", label: "Top-right quarter" },
    { zone: "bl", label: "Bottom-left quarter" },
    { zone: "br", label: "Bottom-right quarter" },
  ];

  function armLayouts(): void {
    if (layoutTimer.current !== null) return;
    layoutTimer.current = window.setTimeout(() => {
      layoutTimer.current = null;
      captureRoot();
      setLayoutsOpen(true);
    }, LAYOUT_HOVER_MS);
  }

  function disarmLayouts(): void {
    if (layoutTimer.current !== null) {
      clearTimeout(layoutTimer.current);
      layoutTimer.current = null;
    }
    // grace period — moving the pointer INTO the panel cancels the close
    if (layoutCloseTimer.current === null) {
      layoutCloseTimer.current = window.setTimeout(() => {
        layoutCloseTimer.current = null;
        if (!layoutKeepRef.current) setLayoutsOpen(false);
      }, 260);
    }
  }

  function keepLayouts(): void {
    layoutKeepRef.current = true;
    if (layoutCloseTimer.current !== null) {
      clearTimeout(layoutCloseTimer.current);
      layoutCloseTimer.current = null;
    }
  }

  // ---------------- render ----------------

  const style: CSSProperties = win.maximized
    ? { left: 0, top: 0, width: "100%", height: `calc(100% - ${TASKBAR_H}px)`, zIndex }
    : { left: geo.x, top: geo.y, width: geo.w, height: geo.h, zIndex };

  if (hidden) {
    // another workspace — keep the subtree alive (iframes/audio continue),
    // just invisible & untouchable
    (style as Record<string, unknown>).visibility = "hidden";
    (style as Record<string, unknown>).pointerEvents = "none";
  } else if (win.minimized) {
    // minimized but MOUNTED (iframes/audio keep running) — the spring in
    // `animate` sucked it into the taskbar; keep it inert at opacity 0
    (style as Record<string, unknown>).pointerEvents = "none";
  }
  style.boxShadow = isActive ? ACTIVE_SHADOW : IDLE_SHADOW;

  // minimize vector — from the window's live center toward the taskbar
  // (bottom-center of the desktop root). Read from the rAF-measured STATE
  // (pure render); before the first measure falls back to a viewport
  // estimate. Root-relative coords cancel, so only sizes are needed.
  const root = rootDims ?? { left: 0, top: TOP_INSET, w: window.innerWidth, h: window.innerHeight - TOP_INSET };
  const miniRect: Geom = win.maximized
    ? { x: 0, y: 0, w: root.w, h: Math.max(0, root.h - TASKBAR_H) }
    : geo;
  const miniDx = root.w / 2 - (miniRect.x + miniRect.w / 2);
  const miniDy = root.h - 30 - (miniRect.y + miniRect.h / 2); // ≈ taskbar center

  const animateTarget: TargetAndTransition = win.minimized
    ? {
        // GENIE — squash into a sliver that dives into the taskbar.
        // Distortion is transform-only (scaleX/scaleY multiply `scale`);
        // the opacity fade is delayed a beat so the eye tracks the
        // shrink before it dissolves.
        scale: 0.42,
        scaleX: 1.3,
        scaleY: 0.5,
        opacity: 0,
        x: miniDx,
        y: miniDy,
        rotate: -1.2,
        transition: {
          type: "spring",
          stiffness: 380,
          damping: 26,
          opacity: { delay: 0.14, duration: 0.22 },
        },
      }
    : {
        scale: 1,
        scaleX: 1,
        scaleY: 1,
        rotate: 0,
        opacity: 1, // focus dimming moved to the inner filter layer
        x: 0,
        y: 0,
        transition: { type: "spring", stiffness: 380, damping: 30 },
      };

  // snap preview — fixed overlay in viewport coords (state-driven, pure)
  const previewStyle: CSSProperties | null =
    snap && snap.rect
      ? {
          position: "fixed",
          left: snap.rect.x,
          top: snap.rect.y,
          width: snap.rect.w,
          height: snap.rect.h,
          zIndex: zIndex - 1,
        }
      : null;

  return (
    <>
      {/* edge-snap preview (glass ghost of the zone) */}
      {previewStyle && (
        <motion.div
          aria-hidden
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          style={previewStyle}
          className="gd-snap-preview pointer-events-none rounded-2xl"
        />
      )}

      {/* snap assist — fills the remaining half after a half-snap commits */}
      <AnimatePresence>
        {snapAssist && !win.minimized && !hidden && (
          <SnapAssist
            key="snap-assist"
            rect={snapAssist.vp}
            candidates={candidates}
            onPick={pickSnapAssist}
            onDismiss={dismissSnapAssist}
          />
        )}
      </AnimatePresence>

      <motion.div
        role="dialog"
        aria-label={win.title}
        aria-hidden={win.minimized || hidden || undefined}
        initial={launchInitial}
        animate={animateTarget}
        exit={{ scale: 0.88, opacity: 0, y: 12, transition: { type: "spring", stiffness: 520, damping: 34 } }}
        transition={{ type: "spring", stiffness: 460, damping: 26 }}
        onPointerDownCapture={() => {
          if (!isActive) focusWindow();
          measureRoot(); // keep the minimize vector's root dims fresh
        }}
        style={{ ...style, willChange: "transform" }}
        className={`glass-strong absolute flex flex-col overflow-hidden ${
          win.maximized ? "rounded-none" : "rounded-2xl"
        } ${
          interacting
            ? "transition-none"
            : "transition-[left,top,width,height,box-shadow] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        }`}
      >
        {/* focus dim layer (10-c) — saturate/brightness live HERE, never on
            the mover (framer owns the mover's transform: drag + genie), so
            the filter transition can never fight pointer-driven motion.
            Resize strips/grips are OUTSIDE this layer and stay crisp. */}
        <div
          className={`absolute inset-0 flex flex-col transition-[filter] duration-[250ms] ease-out ${
            isActive ? "" : "saturate-[.92] brightness-[.97]"
          }`}
        >
        {/* accent crown — a hair-thin gradient line that lights up on
            the active window (Apple-subtle focus cue) */}
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 top-0 z-20 h-[2.5px] gd-accent-gradient transition-opacity duration-300 ${
            win.maximized ? "" : "rounded-t-2xl"
          } ${isActive ? "opacity-90" : "opacity-0"}`}
        />
        <header
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
          onDoubleClick={onTitleDoubleClick}
          onContextMenu={openTitleMenu}
          className={`h-10 shrink-0 flex items-center gap-2 px-3 border-b select-none touch-none transition-colors duration-200 ${
            isActive ? "bg-white/45 border-white/50" : "bg-white/30 border-white/40"
          } ${win.maximized ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
        >
          {/* traffic lights — macOS glyph reveal (pure CSS: cluster hover
              shows all three symbols dimmed, per-dot hover lights one at
              full strength; framer adds ONLY the press scale) + snap
              layouts still armed on max-hover */}
          <div
            className={`gd-lights flex items-center gap-2 shrink-0 ${isActive ? "" : "gd-lights-idle"}`}
            data-gd-nodrag
            onPointerLeave={() => disarmLayouts()}
          >
            <motion.button
              type="button"
              aria-label={`Close ${win.title}`}
              whileTap={{ scale: 0.88, transition: SPRING.snappy }}
              onClick={() => dispatch({ t: "win:close", id: win.id })}
              className="gd-light gd-light-close relative grid place-items-center p-0"
            >
              <X size={8} strokeWidth={3} className="gd-glyph" />
              <span className="absolute -inset-2" aria-hidden />
            </motion.button>
            <motion.button
              type="button"
              aria-label={`Minimize ${win.title}`}
              whileTap={{ scale: 0.88, transition: SPRING.snappy }}
              onClick={() => dispatch({ t: "win:min", id: win.id, minimized: true })}
              className="gd-light gd-light-min relative grid place-items-center p-0"
            >
              <Minus size={8} strokeWidth={3} className="gd-glyph" />
              <span className="absolute -inset-2" aria-hidden />
            </motion.button>
            <motion.button
              type="button"
              aria-label={win.maximized ? `Restore ${win.title}` : `Maximize ${win.title}`}
              whileTap={{ scale: 0.88, transition: SPRING.snappy }}
              onClick={() => dispatch({ t: "win:max", id: win.id, maximized: !win.maximized })}
              onPointerEnter={() => {
                armLayouts();
              }}
              className="gd-light gd-light-max relative grid place-items-center p-0"
            >
              <Plus size={8} strokeWidth={3} className="gd-glyph" />
              <span className="absolute -inset-2" aria-hidden />
            </motion.button>
          </div>

          {/* app icon + title (muted when inactive) */}
          <div
            className={`shrink-0 transition-[opacity,filter] duration-200 ${
              isActive ? "" : "opacity-75 saturate-[.85]"
            }`}
          >
            <AppIcon id={win.app} size={18} />
          </div>
          <span
            className={`text-xs font-medium truncate transition-colors duration-200 ${
              isActive ? "text-stone-700" : "text-stone-400"
            }`}
          >
            {win.title}
          </span>
          <div className="flex-1" />
        </header>

        {/* snap layouts popover — blooms under the traffic lights */}
        <AnimatePresence>
          {layoutsOpen && !win.maximized && (
            <motion.div
              data-gd-nodrag
              initial={{ opacity: 0, scale: 0.9, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: -4 }}
              transition={{ type: "spring", stiffness: 440, damping: 30 }}
              onPointerEnter={() => keepLayouts()}
              onPointerLeave={() => {
                layoutKeepRef.current = false;
                setLayoutsOpen(false);
              }}
              className="absolute left-2 top-11 z-30 glass-strong rounded-xl p-2 shadow-xl origin-top-left"
              role="menu"
              aria-label="Snap layouts"
            >
              <p className="px-1 pb-1.5 text-[9px] font-semibold uppercase tracking-wider text-stone-400">
                Snap layouts
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {layoutZones.map((z) => {
                  const rect = zoneRect(z.zone, window.innerWidth);
                  const scale = 26 / rect.h; // mini-diagram scale
                  return (
                    <button
                      key={z.zone}
                      type="button"
                      title={z.label}
                      aria-label={`Snap window — ${z.label}`}
                      onClick={() => {
                        applyZone(z.zone);
                        setLayoutsOpen(false);
                      }}
                      className="grid h-8 w-9 place-items-center rounded-lg bg-white/60 hover:bg-white/90 transition-colors"
                    >
                      <span
                        className="block rounded-[3px] gd-accent-gradient/80"
                        style={{
                          width: Math.max(4, rect.w * scale * (rect.w / window.innerWidth)),
                          height: 18,
                          opacity: rect.w < window.innerWidth ? 0.9 : 0.5,
                        }}
                      >
                        <span
                          className="block h-full w-full rounded-[3px]"
                          style={{ background: "linear-gradient(135deg, var(--gd-accent), var(--gd-accent-2))", opacity: 0.85 }}
                        />
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  title="Maximize"
                  aria-label="Maximize window"
                  onClick={() => {
                    applyZone("max");
                    setLayoutsOpen(false);
                  }}
                  className="grid h-8 w-9 place-items-center rounded-lg bg-white/60 hover:bg-white/90 transition-colors"
                >
                  <span
                    className="block h-[18px] w-[22px] rounded-[3px]"
                    style={{ background: "linear-gradient(135deg, var(--gd-accent), var(--gd-accent-2))", opacity: 0.85 }}
                  />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* app content owns its own inner scroll */}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
        </div>

        {/* 8-direction resize: thin pointer strips (2px accent edge
            highlight on hover) + visible corner grips. Rendered BEFORE
            the SE grip so the chunky grip wins overlaps. */}
        {!win.maximized && (
          <>
            <div
              aria-hidden
              {...resizeHandlers("n")}
              className="group/edge absolute z-10 left-3.5 right-3.5 top-0 cursor-ns-resize touch-none"
              style={{ height: STRIP_PX }}
            >
              <span className="pointer-events-none absolute inset-x-0 top-0 h-[2px] rounded-full gd-accent-gradient opacity-0 transition-opacity duration-150 group-hover/edge:opacity-100" />
            </div>
            <div
              aria-hidden
              {...resizeHandlers("s")}
              className="group/edge absolute z-10 left-3.5 right-3.5 bottom-0 cursor-ns-resize touch-none"
              style={{ height: STRIP_PX }}
            >
              <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] rounded-full gd-accent-gradient opacity-0 transition-opacity duration-150 group-hover/edge:opacity-100" />
            </div>
            <div
              aria-hidden
              {...resizeHandlers("w")}
              className="group/edge absolute z-10 top-3.5 bottom-3.5 left-0 cursor-ew-resize touch-none"
              style={{ width: STRIP_PX }}
            >
              <span className="pointer-events-none absolute inset-y-0 left-0 w-[2px] rounded-full gd-accent-gradient opacity-0 transition-opacity duration-150 group-hover/edge:opacity-100" />
            </div>
            <div
              aria-hidden
              {...resizeHandlers("e")}
              className="group/edge absolute z-10 top-3.5 bottom-3.5 right-0 cursor-ew-resize touch-none"
              style={{ width: STRIP_PX }}
            >
              <span className="pointer-events-none absolute inset-y-0 right-0 w-[2px] rounded-full gd-accent-gradient opacity-0 transition-opacity duration-150 group-hover/edge:opacity-100" />
            </div>
            <div
              title="Resize window"
              {...resizeHandlers("nw")}
              className="absolute z-10 -top-0.5 -left-0.5 cursor-nwse-resize touch-none rounded-[4px] border border-white/80 shadow-sm transition-[filter] duration-150 hover:brightness-110"
              style={{ ...gripStyle(135), width: CORNER_PX_HIT, height: CORNER_PX_HIT }}
            />
            <div
              title="Resize window"
              {...resizeHandlers("ne")}
              className="absolute z-10 -top-0.5 -right-0.5 cursor-nesw-resize touch-none rounded-[4px] border border-white/80 shadow-sm transition-[filter] duration-150 hover:brightness-110"
              style={{ ...gripStyle(45), width: CORNER_PX_HIT, height: CORNER_PX_HIT }}
            />
            <div
              title="Resize window"
              {...resizeHandlers("sw")}
              className="absolute z-10 -bottom-0.5 -left-0.5 cursor-nesw-resize touch-none rounded-[4px] border border-white/80 shadow-sm transition-[filter] duration-150 hover:brightness-110"
              style={{ ...gripStyle(45), width: CORNER_PX_HIT, height: CORNER_PX_HIT }}
            />
          </>
        )}

        {/* resize grip (bottom-right chunky grip — primary) */}
        {!win.maximized && (
          <div
            title="Resize window"
            aria-label="Resize window"
            {...resizeHandlers("se")}
            className="absolute -bottom-0.5 -right-0.5 p-2 cursor-nwse-resize touch-none z-10 transition-[filter] duration-150 hover:brightness-110"
          >
            <div
              className="size-3.5 rounded-[4px] border border-white/80 shadow-sm"
              style={{
                backgroundColor: "rgba(255,255,255,0.6)",
                backgroundImage:
                  "repeating-linear-gradient(135deg, rgba(87,83,78,0.5) 0 2px, transparent 2px 5px)",
              }}
            />
          </div>
        )}
      </motion.div>
    </>
  );
}
