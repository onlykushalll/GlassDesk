"use client";

// ============================================================
// GlassDesk — Whiteboard. One shared canvas, two pens.
// Strokes live in win.payload.strokes (full-array app:patch,
// throttled ~120 ms — last write per patch wins, fine for 2
// seats drawing at the same time). The eraser never stores
// strokes: pointer events hit-test and remove them.
// Points are flattened [x,y,...] normalized 0..1, budgeted by
// STROKE_POINTS_CAP (oldest strokes drop first).
// ============================================================

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "framer-motion";
import { Eraser, Trash2 } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { STROKE_POINTS_CAP, uid, type Stroke, type WindowState } from "@/lib/vpc/types";

const COLORS = [
  { hex: "#14b8a6", label: "Teal" },
  { hex: "#10b981", label: "Emerald" },
  { hex: "#f59e0b", label: "Amber" },
  { hex: "#f43f5e", label: "Rose" },
  { hex: "#57534e", label: "Stone" },
];

const WIDTHS = [
  { w: 2, label: "S" },
  { w: 5, label: "M" },
  { w: 9, label: "L" },
];

const PATCH_THROTTLE_MS = 120;
const MIN_STEP = 0.004; // normalized distance before a point is kept
const ERASE_TOLERANCE = 0.02; // normalized point-to-stroke distance

function toStrokes(raw: unknown): Stroke[] {
  return Array.isArray(raw) ? (raw as Stroke[]) : [];
}

function strokePoints(s: Stroke): number {
  return Math.floor(s.points.length / 2);
}

function totalPoints(strokes: Stroke[]): number {
  return strokes.reduce((a, s) => a + strokePoints(s), 0);
}

/** Drop oldest strokes until the shared point budget fits. */
function enforceCap(strokes: Stroke[]): Stroke[] {
  let total = totalPoints(strokes);
  if (total <= STROKE_POINTS_CAP) return strokes;
  const out = [...strokes];
  while (out.length > 0 && total > STROKE_POINTS_CAP) {
    total -= strokePoints(out[0]);
    out.shift();
  }
  return out;
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function strokeHit(s: Stroke, x: number, y: number): boolean {
  const p = s.points;
  if (p.length < 2) return false;
  if (Math.hypot(x - p[0], y - p[1]) < ERASE_TOLERANCE) return true;
  for (let i = 0; i + 3 < p.length; i += 2) {
    if (distToSegment(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) < ERASE_TOLERANCE) return true;
  }
  return false;
}

function polyStr(points: number[]): string {
  let out = "";
  for (let i = 0; i + 1 < points.length; i += 2) out += `${points[i]},${points[i + 1]} `;
  return out.trim();
}

/** Replace any in-flight copy of the same stroke id (throttled re-patches). */
function merged(base: Stroke[], stroke: Stroke): Stroke[] {
  return [...base.filter((s) => s.id !== stroke.id), stroke];
}

export default function WhiteboardApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState<string>(COLORS[0].hex);
  const [width, setWidth] = useState<number>(WIDTHS[1].w);
  const [current, setCurrent] = useState<Stroke | null>(null);

  const strokes = toStrokes(win.payload.strokes);

  const rectRef = useRef<DOMRect | null>(null);
  const drawingRef = useRef<Stroke | null>(null);
  const lastPatchAtRef = useRef(0);

  // freshest committed strokes — read from the store at patch time so a
  // peer stroke that landed mid-draw is never clobbered by a stale prop
  const liveStrokes = useCallback((): Stroke[] => {
    const st = useGlassDesk.getState().state;
    const w = st?.windows.find((x) => x.id === win.id);
    return toStrokes(w?.payload.strokes);
  }, [win.id]);

  const patchStrokes = useCallback(
    (next: Stroke[]) => {
      dispatch({ t: "app:patch", id: win.id, patch: { strokes: enforceCap(next) } });
    },
    [dispatch, win.id],
  );

  const commitCurrent = useCallback(
    (force: boolean) => {
      const stroke = drawingRef.current;
      if (!stroke) return;
      const now = Date.now();
      if (!force && now - lastPatchAtRef.current < PATCH_THROTTLE_MS) return;
      lastPatchAtRef.current = now;
      patchStrokes(merged(liveStrokes(), stroke));
    },
    [liveStrokes, patchStrokes],
  );

  const pointerPos = (e: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const r = rectRef.current;
    const w = r && r.width > 0 ? r.width : 1;
    const h = r && r.height > 0 ? r.height : 1;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - (r?.left ?? 0)) / w)),
      y: Math.min(1, Math.max(0, (e.clientY - (r?.top ?? 0)) / h)),
    };
  };

  const eraseAt = (x: number, y: number) => {
    const live = liveStrokes();
    const next = live.filter((s) => !strokeHit(s, x, y));
    if (next.length !== live.length) patchStrokes(next);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture is best-effort; drawing still works without it
    }
    rectRef.current = e.currentTarget.getBoundingClientRect();
    const { x, y } = pointerPos(e);
    if (tool === "eraser") {
      eraseAt(x, y);
      return;
    }
    if (drawingRef.current) return; // one stroke per pointer
    const stroke: Stroke = { id: uid(), color, width, tool: "pen", points: [x, y] };
    drawingRef.current = stroke;
    lastPatchAtRef.current = 0;
    setCurrent(stroke);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === "eraser") {
      if (e.buttons === 0) return; // hover, not erase-drag
      const { x, y } = pointerPos(e);
      eraseAt(x, y);
      return;
    }
    const stroke = drawingRef.current;
    if (!stroke) return;
    const { x, y } = pointerPos(e);
    const p = stroke.points;
    const lx = p[p.length - 2];
    const ly = p[p.length - 1];
    if (Math.hypot(x - lx, y - ly) <= MIN_STEP) return;
    const next: Stroke = { ...stroke, points: [...p, x, y] };
    drawingRef.current = next;
    setCurrent(next);
    commitCurrent(false);
  };

  const finishStroke = () => {
    const stroke = drawingRef.current;
    if (!stroke) return;
    patchStrokes(merged(liveStrokes(), stroke));
    drawingRef.current = null;
    setCurrent(null);
  };

  const clearCanvas = () => {
    drawingRef.current = null;
    setCurrent(null);
    dispatch({ t: "app:set", id: win.id, payload: { strokes: [] } });
  };

  // render set: committed strokes + the in-flight one (its throttled copy
  // may already sit in the payload — filter by id to avoid double keys)
  const renderStrokes = current ? [...strokes.filter((s) => s.id !== current.id), current] : strokes;
  const pointCount = totalPoints(renderStrokes);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-white/50 bg-white/30 px-3 py-2">
        <div className="flex items-center gap-1.5">
          {COLORS.map((c) => (
            <motion.button
              key={c.hex}
              whileTap={{ scale: 0.85 }}
              onClick={() => {
                setColor(c.hex);
                setTool("pen");
              }}
              title={`${c.label} pen`}
              aria-label={`${c.label} pen`}
              className={`h-[22px] w-[22px] rounded-full border border-black/10 ${
                color === c.hex && tool === "pen" ? "ring-2 ring-offset-2 ring-stone-600/60" : ""
              }`}
              style={{ background: c.hex }}
            />
          ))}
        </div>

        <span className="mx-1 h-5 w-px bg-white/70" />

        <div className="flex items-center gap-1">
          {WIDTHS.map((wd) => (
            <button
              key={wd.w}
              onClick={() => setWidth(wd.w)}
              title={`${wd.label} stroke width`}
              className={`h-7 w-7 rounded-md text-[10px] font-semibold transition-colors ${
                width === wd.w
                  ? "gd-accent-gradient text-white shadow-sm"
                  : "bg-white/50 text-stone-500 hover:bg-white/80"
              }`}
            >
              {wd.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => setTool(tool === "eraser" ? "pen" : "eraser")}
          title={tool === "eraser" ? "Switch to pen" : "Eraser — removes strokes you touch"}
          aria-pressed={tool === "eraser"}
          className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[10px] font-semibold transition-colors ${
            tool === "eraser"
              ? "gd-accent-gradient text-white shadow-sm"
              : "bg-white/50 text-stone-500 hover:bg-white/80"
          }`}
        >
          <Eraser className="h-3.5 w-3.5" />
          Erase
        </button>

        <span className="flex-1" />

        <span className="gd-mono text-[10px] text-stone-400">
          points {pointCount}/{STROKE_POINTS_CAP}
        </span>

        <button
          onClick={clearCanvas}
          title="Clear the canvas for both seats"
          className="flex h-7 w-7 items-center justify-center rounded-md bg-white/50 text-stone-500 transition-colors hover:bg-rose-50 hover:text-rose-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* canvas */}
      <div
        className="relative min-h-0 flex-1 touch-none cursor-crosshair select-none bg-white/40"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
        onLostPointerCapture={finishStroke}
      >
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {renderStrokes.map((s) =>
            s.points.length >= 4 ? (
              <polyline
                key={s.id}
                points={polyStr(s.points)}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : s.points.length >= 2 ? (
              <circle
                key={s.id}
                cx={s.points[0]}
                cy={s.points[1]}
                r={0.008}
                fill={s.color}
                stroke={s.color}
                strokeWidth={s.width}
                vectorEffect="non-scaling-stroke"
              />
            ) : null,
          )}
        </svg>

        {renderStrokes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="text-xs text-stone-400/80">Draw together — every stroke syncs to both seats</p>
          </div>
        )}
      </div>
    </div>
  );
}
