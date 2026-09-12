"use client";

// ============================================================
// GlassDesk — Camera. The filter + shot count are SHARED state
// (payload {filter, shots}) so both seats see the same camera
// state; captures are written to the virtual FS (~/Pictures)
// and therefore sync to both seats as real files.
// Hardware path: mirrored getUserMedia preview, 7 CSS filters
// (baked into the JPEG via ctx.filter on capture).
// No-camera path (headless QA): a broadcast-style demo test
// card — teal→emerald gradient, drifting glass orbs, live clock,
// registration marks — and CAPTURE STILL WORKS (the card is
// rasterized to canvas and saved through the exact same flow).
// ============================================================

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Camera, TriangleAlert, X } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { SPRING, riseIn, stagger, pop } from "@/lib/vpc/motion";
import { fsChildren, uid, type FSNode, type WindowState } from "@/lib/vpc/types";

// ---------------- payload + filters ----------------

type CamP = { filter: string; shots: number };

const FILTERS = [
  { id: "none", label: "None", css: "none" },
  { id: "warm", label: "Warm", css: "sepia(0.42) brightness(1.08) saturate(1.18)" },
  { id: "cool", label: "Cool", css: "hue-rotate(-14deg) saturate(1.18) brightness(1.03)" },
  { id: "mono", label: "Mono", css: "grayscale(1) brightness(1.05)" },
  { id: "vivid", label: "Vivid", css: "saturate(1.65) contrast(1.08)" },
  { id: "noir", label: "Noir", css: "grayscale(1) contrast(1.35) brightness(0.92)" },
  { id: "dream", label: "Dream", css: "blur(1.1px) brightness(1.12) saturate(1.12)" },
] as const;

function filterCss(id: string): string {
  return FILTERS.find((f) => f.id === id)?.css ?? "none";
}

function fmtClock(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The demo test card, painted to a canvas for captures — mirrors
 *  the DOM DemoCard (same gradient, orbs, wordmark, clock, marks). */
function paintTestCard(ctx: CanvasRenderingContext2D, w: number, h: number, at: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#0d9488");
  g.addColorStop(0.48, "#14b8a6");
  g.addColorStop(1, "#10b981");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const t = at / 1000;
  const orbs = [
    { r: 0.16, px: 0.16, py: 0.2, sp: 0.16, ph: 0, a: 0.2 },
    { r: 0.1, px: 0.8, py: 0.32, sp: 0.23, ph: 2.1, a: 0.16 },
    { r: 0.08, px: 0.6, py: 0.82, sp: 0.19, ph: 4.2, a: 0.14 },
  ];
  for (const o of orbs) {
    const cx = (o.px + 0.05 * Math.sin(t * o.sp + o.ph)) * w;
    const cy = (o.py + 0.06 * Math.cos(t * o.sp * 0.8 + o.ph)) * h;
    const r = o.r * w;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, `rgba(255,255,255,${o.a})`);
    rg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.font = `800 ${Math.round(w * 0.045)}px system-ui, sans-serif`;
  ctx.fillText("G L A S S D E S K   C A M", w / 2, h * 0.44);
  ctx.font = `500 ${Math.round(w * 0.024)}px ui-monospace, monospace`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(`${fmtClock(new Date(at))}  ·  DEMO SIGNAL`, w / 2, h * 0.55);

  const m = Math.max(16, w * 0.03);
  const inset = w * 0.03;
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = Math.max(2, w * 0.004);
  const corners: [number, number, number, number][] = [
    [inset, inset, 1, 1],
    [w - inset, inset, -1, 1],
    [inset, h - inset, 1, -1],
    [w - inset, h - inset, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(x, y + sy * m);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * m, y);
    ctx.stroke();
  }
}

// ---------------- demo card (DOM) ----------------

function RegMark({ className }: { className: string }) {
  return <div aria-hidden className={`pointer-events-none absolute size-5 border-white/60 ${className}`} />;
}

function DemoCard({ css }: { css: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{
        background: "linear-gradient(135deg,#0d9488 0%,#14b8a6 48%,#10b981 100%)",
        filter: css === "none" ? undefined : css,
      }}
    >
      <motion.div
        aria-hidden
        className="absolute rounded-full bg-white/20 blur-2xl"
        style={{ width: 170, height: 170, left: "6%", top: "8%" }}
        animate={{ x: [0, 44, -12, 0], y: [0, -26, 22, 0], scale: [1, 1.12, 0.94, 1] }}
        transition={{ duration: 19, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        aria-hidden
        className="absolute rounded-full bg-white/15 blur-2xl"
        style={{ width: 120, height: 120, right: "8%", top: "18%" }}
        animate={{ x: [0, -36, 18, 0], y: [0, 30, -14, 0] }}
        transition={{ duration: 23, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        aria-hidden
        className="absolute rounded-full bg-emerald-100/20 blur-2xl"
        style={{ width: 96, height: 96, left: "34%", bottom: "6%" }}
        animate={{ x: [0, 30, -20, 0], y: [0, -18, 12, 0] }}
        transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="gd-mono text-[10px] uppercase tracking-[0.34em] text-white/70">broadcast test pattern</p>
        <h2 className="text-[26px] font-black tracking-[0.3em] text-white drop-shadow-sm pl-[0.3em]">
          GLASSDESK CAM
        </h2>
        <p className="gd-mono text-sm tabular-nums text-white/90">{fmtClock(now)} · DEMO</p>
      </div>

      <RegMark className="left-3 top-3 rounded-tl-md border-l-[3px] border-t-[3px]" />
      <RegMark className="right-3 top-3 rounded-tr-md border-r-[3px] border-t-[3px]" />
      <RegMark className="bottom-3 left-3 rounded-bl-md border-b-[3px] border-l-[3px]" />
      <RegMark className="bottom-3 right-3 rounded-br-md border-b-[3px] border-r-[3px]" />
    </div>
  );
}

// ---------------- lightbox ----------------

function ShotLightbox({ node, onClose }: { node: FSNode; onClose: () => void }) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      key="shot-lightbox"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={SPRING.window}
      className="absolute inset-0 z-40 flex flex-col bg-stone-950/85 backdrop-blur-md"
      role="dialog"
      aria-label={`Shot viewer — ${node.name}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{node.name}</p>
          <p className="text-[11px] text-white/50">
            ~/Pictures · saved {new Date(node.updatedAt).toLocaleTimeString()}
          </p>
        </div>
        <motion.button
          type="button"
          variants={pop}
          initial="rest"
          animate="rest"
          whileHover="hover"
          whileTap="tap"
          onClick={onClose}
          aria-label="Close shot"
          className="glass ml-auto grid size-8 place-items-center rounded-full text-white/80 hover:bg-rose-400/80"
        >
          <X className="size-4" aria-hidden="true" />
        </motion.button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 grid place-items-center overflow-hidden px-10 pb-4">
          <motion.div
            animate={{ scale: zoomed ? 1.55 : 1 }}
            transition={SPRING.glide}
            className="flex h-full w-full items-center justify-center overflow-hidden"
          >
            <img
              src={node.content}
              alt={`${node.name} — camera capture`}
              draggable={false}
              onClick={() => setZoomed((z) => !z)}
              className={`max-h-full max-w-full rounded-xl object-contain shadow-2xl ${
                zoomed ? "cursor-zoom-out" : "cursor-zoom-in"
              }`}
            />
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}

// ---------------- main ----------------

export default function CameraApp({ win }: { win: WindowState }) {
  // LIVE window so remote patches (filter/shots + fs saves) land instantly
  const liveWin = useGlassDesk((s) => s.state?.windows.find((x) => x.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const fs = useGlassDesk((s) => s.state?.fs);
  const w = liveWin ?? win;

  const p = w.payload as Partial<CamP>;
  const filter = FILTERS.some((f) => f.id === p.filter) ? (p.filter as string) : "none";
  const shots = typeof p.shots === "number" && p.shots >= 0 ? Math.floor(p.shots) : 0;
  const css = filterCss(filter);

  const patch = (o: Partial<CamP>) => dispatch({ t: "app:patch", id: win.id, patch: o });

  const [mode, setMode] = useState<"checking" | "live" | "demo">("checking");
  const [flash, setFlash] = useState(false);
  const [openShot, setOpenShot] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // acquire the camera once (async → setState only in continuations)
  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    const acquire = async () => {
      try {
        const md = navigator.mediaDevices;
        if (!md) throw new Error("no media devices");
        const s = await md.getUserMedia({ video: { facingMode: "user", width: 960 } });
        if (!alive) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = videoRef.current;
        if (v) {
          v.srcObject = s;
          v.play().catch(() => {});
        }
        s.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (alive) setMode("demo");
        });
        setMode("live");
      } catch {
        if (alive) setMode("demo");
      }
    };
    void acquire();
    return () => {
      alive = false;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // ~/Pictures roll (shared FS → both seats)
  const picturesFolder = fs
    ? fsChildren(fs, null).find((n) => n.kind === "folder" && n.name === "Pictures")
    : undefined;
  const roll = picturesFolder
    ? fsChildren(fs ?? {}, picturesFolder.id)
        .filter((n) => n.kind === "file" && n.content.startsWith("data:image"))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12)
    : [];
  const shotNode = openShot && fs ? fs[openShot] : undefined;

  const capture = () => {
    if (mode === "checking") return;
    // flash (120ms opacity blink)
    setFlash(true);
    window.setTimeout(() => setFlash(false), 140);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (mode === "live") {
      const v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight) return;
      const cw = Math.min(640, v.videoWidth);
      const ch = Math.max(1, Math.round((cw * v.videoHeight) / v.videoWidth));
      canvas.width = cw;
      canvas.height = ch;
      ctx.filter = css;
      // the preview is mirrored — bake the same view into the file
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(v, 0, 0, cw, ch);
    } else {
      canvas.width = 640;
      canvas.height = 360;
      ctx.filter = css;
      paintTestCard(ctx, 640, 360, Date.now());
    }

    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    if (!dataUrl || dataUrl.length < 128) return;

    // save into (creating if needed) ~/Pictures — fresh store read, no stale
    const s = useGlassDesk.getState();
    const curFs = s.state?.fs ?? {};
    let folder = fsChildren(curFs, null).find((n) => n.kind === "folder" && n.name === "Pictures");
    if (!folder) {
      folder = {
        id: uid(),
        name: "Pictures",
        kind: "folder",
        parent: null,
        content: "",
        updatedAt: Date.now(),
      };
      dispatch({ t: "fs:upsert", node: folder });
    }
    const wd = s.state?.windows.find((x) => x.id === win.id);
    const pNow = (wd?.payload ?? {}) as Partial<CamP>;
    const n = (typeof pNow.shots === "number" && pNow.shots >= 0 ? pNow.shots : 0) + 1;
    dispatch({
      t: "fs:upsert",
      node: {
        id: uid(),
        name: `shot-${n}.jpg`,
        kind: "file",
        parent: folder.id,
        content: dataUrl,
        updatedAt: Date.now(),
      },
    });
    patch({ shots: n });
    pushToast({
      title: `Saved shot-${n}.jpg`,
      body: "The roll lives in ~/Pictures — visible on both seats.",
      kind: "success",
    });
  };

  return (
    <div className="relative flex h-full flex-col gap-2.5 overflow-hidden p-3">
      {/* ---------------- no-camera fallback banner ---------------- */}
      <AnimatePresence>
        {mode === "demo" && (
          <motion.div
            variants={riseIn}
            initial="hidden"
            animate="show"
            exit="exit"
            className="flex shrink-0 items-center gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-1.5 text-[11px] font-medium text-amber-700"
          >
            <TriangleAlert className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            Camera unavailable — demo card active (captures still save to ~/Pictures)
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------------- viewfinder ---------------- */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-stone-900 shadow-inner">
        <video
          ref={videoRef}
          muted
          autoPlay
          playsInline
          aria-label="Camera preview"
          className={mode === "live" ? "absolute inset-0 h-full w-full object-cover" : "hidden"}
          style={{ transform: "scaleX(-1)", filter: css === "none" ? undefined : css }}
        />
        {mode === "demo" && <DemoCard css={css} />}
        {mode === "checking" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-teal-700 to-emerald-700">
            <motion.span
              animate={{ opacity: [0.35, 0.95, 0.35] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              className="flex items-center gap-2 text-xs font-medium text-white/90"
            >
              <Camera className="size-4" aria-hidden="true" /> Requesting camera…
            </motion.span>
          </div>
        )}

        {/* status chips */}
        <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
          {mode === "live" && (
            <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
              <span className="relative flex size-1.5" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
              </span>
              Live
            </span>
          )}
          {mode === "demo" && (
            <span className="rounded-full bg-amber-100/90 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-700 backdrop-blur-sm">
              Demo
            </span>
          )}
        </div>
        <div className="absolute right-3 top-3 z-10">
          <span className="glass gd-mono rounded-full px-2.5 py-1 text-[10px] font-medium tabular-nums text-stone-600">
            {shots} shot{shots === 1 ? "" : "s"} · ~/Pictures
          </span>
        </div>

        {/* shutter */}
        <motion.button
          type="button"
          variants={pop}
          initial="rest"
          animate="rest"
          whileHover="hover"
          whileTap="tap"
          onClick={capture}
          disabled={mode === "checking"}
          aria-label="Capture photo"
          style={{ x: "-50%" }}
          className="absolute bottom-4 left-1/2 z-10 grid size-16 place-items-center rounded-full border-[3px] border-white/90 bg-white/15 shadow-lg backdrop-blur-sm outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
        >
          <motion.span
            aria-hidden="true"
            className="absolute inset-[-3px] rounded-full border-2 border-white/80"
            animate={{ scale: [1, 1.22, 1], opacity: [0.55, 0, 0.55] }}
            transition={{ duration: 1.9, repeat: Infinity, ease: "easeInOut" }}
          />
          <span className="gd-accent-gradient size-11 rounded-full shadow-md" />
        </motion.button>

        {/* flash */}
        <AnimatePresence>
          {flash && (
            <motion.div
              key="flash"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-20 bg-white"
              initial={{ opacity: 0.95 }}
              animate={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: "linear" }}
            />
          )}
        </AnimatePresence>
      </div>

      {/* ---------------- filter rail (synced) ---------------- */}
      <motion.div
        variants={stagger(0.04, 0.03)}
        initial="hidden"
        animate="show"
        className="gd-scroll flex shrink-0 items-center gap-1.5 overflow-x-auto py-0.5"
      >
        <span className="shrink-0 pr-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
          Filter
        </span>
        {FILTERS.map((f) => {
          const active = f.id === filter;
          return (
            <motion.button
              key={f.id}
              type="button"
              variants={riseIn}
              whileHover={{ scale: 1.06 }}
              whileTap={{ scale: 0.94 }}
              transition={SPRING.snappy}
              onClick={() => patch({ filter: f.id })}
              aria-pressed={active}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-stone-300 ${
                active
                  ? "bg-white/90 text-stone-800 shadow-sm"
                  : "bg-white/45 text-stone-500 hover:bg-white/70"
              }`}
              style={active ? { boxShadow: "0 0 0 2px var(--gd-accent)", color: "var(--gd-accent)" } : undefined}
            >
              {f.label}
            </motion.button>
          );
        })}
      </motion.div>

      {/* ---------------- roll ---------------- */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">Roll</span>
        {roll.length === 0 ? (
          <div className="flex h-12 min-w-0 flex-1 items-center rounded-lg border border-dashed border-stone-300/80 px-3 text-[11px] text-stone-400">
            No captures yet — shots land in ~/Pictures, synced to both seats
          </div>
        ) : (
          <div className="gd-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            <AnimatePresence mode="popLayout" initial={false}>
              {roll.map((n) => (
                <motion.button
                  key={n.id}
                  type="button"
                  layout
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={SPRING.snappy}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setOpenShot(n.id)}
                  aria-label={`Open ${n.name}`}
                  className="relative h-12 w-16 shrink-0 overflow-hidden rounded-lg shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
                >
                  <img
                    src={n.content}
                    alt={`${n.name} thumbnail`}
                    draggable={false}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ---------------- lightbox (inside the window) ---------------- */}
      <AnimatePresence>
        {shotNode && <ShotLightbox node={shotNode} onClose={() => setOpenShot(null)} />}
      </AnimatePresence>
    </div>
  );
}
