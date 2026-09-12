"use client";

// ============================================================
// GlassDesk — Paint. One shared canvas, two brushes, both seats.
// Strokes live in win.payload.strokes (throttled app:patch, same
// proven pattern as the Whiteboard: points normalized 0..1, capped
// by STROKE_POINTS_CAP). Extras over the whiteboard: a 10-color
// palette, canvas paper color (synced in payload.bg), undo, and a
// real PNG export (strokes rasterized onto an offscreen canvas).
// ============================================================

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { motion } from "framer-motion";
import { Brush, Download, Eraser, PaintBucket, Trash2, Undo2 } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { STROKE_POINTS_CAP, uid, type Stroke, type WindowState } from "@/lib/vpc/types";
import { pushToast } from "@/lib/vpc/toast";

const COLORS = [
  { hex: "#14b8a6", label: "Teal" },
  { hex: "#10b981", label: "Emerald" },
  { hex: "#f59e0b", label: "Amber" },
  { hex: "#f43f5e", label: "Rose" },
  { hex: "#8b5cf6", label: "Violet" },
  { hex: "#fb923c", label: "Orange" },
  { hex: "#ec4899", label: "Pink" },
  { hex: "#0d9488", label: "Deep teal" },
  { hex: "#57534e", label: "Stone" },
  { hex: "#292524", label: "Ink" },
];

const PAPERS = ["#ffffff", "#fefce8", "#f0fdf9", "#fff1f2"];

const WIDTHS = [
  { w: 2, label: "S" },
  { w: 5, label: "M" },
  { w: 10, label: "L" },
  { w: 18, label: "XL" },
];

const PATCH_THROTTLE_MS = 120;
const MIN_STEP = 0.004;
const ERASE_TOLERANCE = 0.02;

type Tool = "pen" | "eraser";

function toStrokes(raw: unknown): Stroke[] {
  return Array.isArray(raw) ? (raw as Stroke[]) : [];
}

function toBg(raw: unknown): string {
  return typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : PAPERS[0];
}

function strokePoints(s: Stroke): number {
  return Math.floor(s.points.length / 2);
}

function totalPoints(strokes: Stroke[]): number {
  return strokes.reduce((a, s) => a + strokePoints(s), 0);
}

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

function merged(base: Stroke[], stroke: Stroke): Stroke[] {
  return [...base.filter((s) => s.id !== stroke.id), stroke];
}

/** Rasterize strokes onto a canvas at export resolution and download a PNG. */
function exportPng(strokes: Stroke[], bg: string, w: number, h: number): void {
  const canvas = document.createElement("canvas");
  const scale = Math.min(2, 1600 / Math.max(1, w));
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < s.points.length; i += 2) pts.push([s.points[i], s.points[i + 1]]);
    if (pts.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width * scale;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * canvas.width, pts[0][1] * canvas.height);
    for (const [x, y] of pts.slice(1)) ctx.lineTo(x * canvas.width, y * canvas.height);
    if (pts.length === 1) ctx.lineTo(pts[0][0] * canvas.width + 0.01, pts[0][1] * canvas.height);
    ctx.stroke();
  }
  try {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `glassdesk-paint-${Date.now()}.png`;
    a.click();
  } catch {
    /* download blocked — non-fatal */
  }
}

export default function PaintApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0].hex);
  const [width, setWidth] = useState<number>(WIDTHS[1].w);

  const strokes = toStrokes(win.payload.strokes);
  const paper = toBg(win.payload.bg);

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
    rectRef.current = e.currentTarget.getBoundingClientRect();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture best-effort */
    }
    const { x, y } = pointerPos(e);
    if (tool === "eraser") {
      eraseAt(x, y);
      return;
    }
    drawingRef.current = { id: uid(), color, width, tool: "pen", points: [x, y] };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (tool === "eraser") {
      if (e.buttons === 1) {
        rectRef.current = e.currentTarget.getBoundingClientRect();
        const { x, y } = pointerPos(e);
        eraseAt(x, y);
      }
      return;
    }
    const stroke = drawingRef.current;
    if (!stroke) return;
    const { x, y } = pointerPos(e);
    const n = stroke.points.length;
    const lx = stroke.points[n - 2];
    const ly = stroke.points[n - 1];
    if (Math.hypot(x - lx, y - ly) < MIN_STEP) return;
    stroke.points.push(x, y);
    commitCurrent(false);
  };

  const finishStroke = () => {
    commitCurrent(true);
    drawingRef.current = null;
  };

  const undo = () => {
    const live = liveStrokes();
    if (live.length === 0) return;
    patchStrokes(live.slice(0, -1));
  };

  const clearAll = () => {
    if (liveStrokes().length === 0) return;
    patchStrokes([]);
    pushToast({ title: "Canvas cleared", body: "Both seats see the fresh paper", kind: "info" });
  };

  const savePng = () => {
    const r = rectRef.current;
    const live = liveStrokes();
    if (live.length === 0) {
      pushToast({ title: "Nothing to save yet", body: "Draw something first ✏️", kind: "info" });
      return;
    }
    exportPng(live, paper, r?.width || 800, r?.height || 560);
    pushToast({ title: "PNG saved", body: `${live.length} strokes → your downloads`, kind: "info" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white/25">
      {/* toolbar */}
      <div className="glass flex shrink-0 flex-wrap items-center gap-2 border-b border-white/50 px-2.5 py-2">
        <div className="flex items-center gap-0.5 rounded-xl bg-white/60 p-0.5" role="group" aria-label="Tools">
          <button
            type="button"
            aria-label="Brush"
            aria-pressed={tool === "pen"}
            onClick={() => setTool("pen")}
            className={`grid size-8 place-items-center rounded-lg transition-colors ${
              tool === "pen" ? "gd-accent-gradient text-white shadow-sm" : "text-stone-500 hover:bg-white/90"
            }`}
          >
            <Brush size={15} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label="Eraser"
            aria-pressed={tool === "eraser"}
            onClick={() => setTool("eraser")}
            className={`grid size-8 place-items-center rounded-lg transition-colors ${
              tool === "eraser" ? "gd-accent-gradient text-white shadow-sm" : "text-stone-500 hover:bg-white/90"
            }`}
          >
            <Eraser size={15} strokeWidth={2.2} />
          </button>
        </div>

        {/* palette */}
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Brush color">
          {COLORS.map((c) => (
            <motion.button
              key={c.hex}
              type="button"
              role="radio"
              aria-checked={color === c.hex}
              aria-label={c.label}
              title={c.label}
              whileHover={{ scale: 1.18 }}
              whileTap={{ scale: 0.85 }}
              transition={{ type: "spring", stiffness: 420, damping: 18 }}
              onClick={() => {
                setColor(c.hex);
                setTool("pen");
              }}
              className={`size-5 rounded-full border shadow-sm ${
                color === c.hex ? "border-stone-700 ring-2 ring-white ring-offset-1" : "border-white/80"
              }`}
              style={{ background: c.hex }}
            />
          ))}
        </div>

        {/* widths */}
        <div className="flex items-center gap-0.5 rounded-xl bg-white/60 p-0.5" role="group" aria-label="Brush size">
          {WIDTHS.map((wd) => (
            <button
              key={wd.w}
              type="button"
              aria-label={`Brush ${wd.label}`}
              aria-pressed={width === wd.w}
              onClick={() => setWidth(wd.w)}
              className={`grid size-8 place-items-center rounded-lg transition-colors ${
                width === wd.w ? "bg-white shadow-sm" : "hover:bg-white/80"
              }`}
            >
              <span
                className="rounded-full"
                style={{
                  width: Math.min(14, 3 + wd.w),
                  height: Math.min(14, 3 + wd.w),
                  background: width === wd.w ? "var(--gd-accent)" : "#78716c",
                }}
              />
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* paper colors */}
        <div className="flex items-center gap-1" role="group" aria-label="Paper color">
          <PaintBucket size={13} className="text-stone-400" aria-hidden />
          {PAPERS.map((p) => (
            <button
              key={p}
              type="button"
              aria-label={`Paper ${p}`}
              aria-pressed={paper === p}
              onClick={() => dispatch({ t: "app:patch", id: win.id, patch: { bg: p } })}
              className={`size-4.5 rounded-md border shadow-sm ${
                paper === p ? "border-stone-700 ring-2 ring-white ring-offset-1" : "border-stone-300"
              }`}
              style={{ background: p, width: 18, height: 18 }}
            />
          ))}
        </div>

        <div className="mx-1 h-6 w-px bg-white/70" aria-hidden />

        <div className="flex items-center gap-0.5 rounded-xl bg-white/60 p-0.5" role="group" aria-label="Canvas actions">
          <button
            type="button"
            aria-label="Undo last stroke"
            title="Undo"
            onClick={undo}
            disabled={strokes.length === 0}
            className="grid size-8 place-items-center rounded-lg text-stone-500 transition-colors hover:bg-white/90 disabled:opacity-40"
          >
            <Undo2 size={15} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label="Clear canvas"
            title="Clear"
            onClick={clearAll}
            disabled={strokes.length === 0}
            className="grid size-8 place-items-center rounded-lg text-rose-500 transition-colors hover:bg-rose-500/10 disabled:opacity-40"
          >
            <Trash2 size={15} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label="Save as PNG"
            title="Save PNG"
            onClick={savePng}
            className="grid size-8 place-items-center rounded-lg text-stone-500 transition-colors hover:bg-white/90"
          >
            <Download size={15} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {/* the shared canvas — dotted-grid paper + synced strokes */}
      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        style={{ background: paper, cursor: tool === "eraser" ? "cell" : "crosshair" }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "radial-gradient(rgba(120,113,108,0.28) 1px, transparent 1.2px)",
            backgroundSize: "22px 22px",
          }}
          aria-hidden
        />
        <div
          className="absolute inset-0 touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onLostPointerCapture={finishStroke}
          role="img"
          aria-label={`Shared paint canvas, ${strokes.length} strokes`}
        >
          <svg className="h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
            {strokes.map((s) => (
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
            ))}
          </svg>
        </div>

        {strokes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <p className="text-xs font-medium text-stone-400">
              Pick a color and draw — every stroke syncs to both seats ✏️
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
