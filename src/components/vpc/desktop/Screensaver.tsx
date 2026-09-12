"use client";

// ============================================================
// GlassDesk — Screensaver. 90s of no pointer/keys/wheel → a
// cinematic full-screen overlay: deep stone→teal gradient, 7 soft
// orbs drifting on independent mirrored loops (transform only,
// will-change — zero layout work), the accent-gradient wordmark
// breathing, a big light clock and a tiny anti-burn-in caption.
//
// Idle tracking is REF-ONLY (throttled writes, no state churn);
// activation happens on a 2.5s interval check. The FIRST input
// after activation wakes the screen and is CONSUMED (capture-phase
// stopPropagation) so the waking click/keystroke never leaks into
// the UI underneath — pointer events are also physically blocked
// by the overlay, which sits above the taskbar (z-100) and the
// menubar (z-110).
//
// z note: the brief said z-[90], but the taskbar paints at z-[100]
// and the menubar at z-[110] in the same root stacking context —
// a z-[90] saver would float a bright glass bar over a dark
// screensaver. z-[112] keeps the promise that nothing sits below
// it except transient overlays (TaskView 115, popovers 120,
// switcher/spotlight/toasts, lock screen 200).
// ============================================================

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LogoMark, Wordmark } from "@/components/vpc/brand/Logo";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";

const IDLE_MS = 90_000;
const CHECK_MS = 2_500;
const THROTTLE_MS = 400; // ref write throttle — activity at 60Hz costs nothing
const FADE_MS = 0.5;

interface Orb {
  size: number;
  cx: string;
  cy: string;
  ax: number; // horizontal drift amplitude (px)
  ay: number; // vertical drift amplitude (px)
  dur: number; // one full mirrored loop, seconds
  bg: string;
}

/** 7 independent drifters — teal/emerald/amber/rose hues. */
const ORBS: Orb[] = [
  { size: 560, cx: "10%", cy: "16%", ax: 74, ay: 48, dur: 26, bg: "radial-gradient(circle at 50% 50%, rgba(20,184,166,0.30), rgba(20,184,166,0) 68%)" },
  { size: 420, cx: "76%", cy: "10%", ax: -64, ay: 62, dur: 22, bg: "radial-gradient(circle at 50% 50%, rgba(16,185,129,0.24), rgba(16,185,129,0) 66%)" },
  { size: 640, cx: "62%", cy: "72%", ax: -88, ay: -52, dur: 30, bg: "radial-gradient(circle at 50% 50%, rgba(13,148,136,0.20), rgba(13,148,136,0) 70%)" },
  { size: 380, cx: "24%", cy: "62%", ax: 56, ay: -66, dur: 19, bg: "radial-gradient(circle at 50% 50%, rgba(245,158,11,0.15), rgba(245,158,11,0) 64%)" },
  { size: 300, cx: "44%", cy: "38%", ax: -46, ay: 40, dur: 24, bg: "radial-gradient(circle at 50% 50%, rgba(244,63,94,0.13), rgba(244,63,94,0) 62%)" },
  { size: 260, cx: "86%", cy: "56%", ax: 38, ay: -44, dur: 21, bg: "radial-gradient(circle at 50% 50%, rgba(52,211,153,0.17), rgba(52,211,153,0) 60%)" },
  { size: 340, cx: "6%", cy: "86%", ax: 62, ay: -32, dur: 27, bg: "radial-gradient(circle at 50% 50%, rgba(45,212,191,0.15), rgba(45,212,191,0) 64%)" },
];

// ============================================================
// root — idle tracker (always mounted, invisible)
// ============================================================

export default function Screensaver() {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const lastActivityRef = useRef(Date.now());
  const lastWriteRef = useRef(0);

  useEffect(() => {
    function onActivity(e: Event): void {
      const now = Date.now();
      if (activeRef.current) {
        // waking input — CONSUME it (nothing beneath reacts to the
        // very keystroke/click that dismissed the saver)
        e.stopPropagation();
        activeRef.current = false;
        setActive(false);
        lastActivityRef.current = now;
        lastWriteRef.current = now;
        return;
      }
      // throttled ref write — no state churn, ever
      if (now - lastWriteRef.current > THROTTLE_MS) {
        lastWriteRef.current = now;
        lastActivityRef.current = now;
      }
    }

    const passive = { passive: true } as const;
    window.addEventListener("pointermove", onActivity, { capture: true, ...passive });
    window.addEventListener("pointerdown", onActivity, { capture: true });
    window.addEventListener("keydown", onActivity, { capture: true });
    window.addEventListener("wheel", onActivity, { capture: true, ...passive });

    const check = window.setInterval(() => {
      if (activeRef.current) return;
      if (Date.now() - lastActivityRef.current < IDLE_MS) return;
      const s = useGlassDesk.getState();
      if (!s.state?.booted) return; // never cover the boot sequence
      if (useShellUi.getState().locked) return; // lock screen already owns the view
      activeRef.current = true;
      setActive(true);
    }, CHECK_MS);

    return () => {
      window.removeEventListener("pointermove", onActivity, { capture: true });
      window.removeEventListener("pointerdown", onActivity, { capture: true });
      window.removeEventListener("keydown", onActivity, { capture: true });
      window.removeEventListener("wheel", onActivity, { capture: true });
      window.clearInterval(check);
    };
  }, []);

  return (
    <AnimatePresence>
      {active && <SaverScene key="saver-scene" />}
    </AnimatePresence>
  );
}

// ============================================================
// the scene
// ============================================================

function SaverScene() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const hh = now.getHours().toString().padStart(2, "0");
  const mm = now.getMinutes().toString().padStart(2, "0");

  return (
    <motion.div
      role="presentation"
      aria-label="Screensaver — press any key to wake"
      className="fixed inset-0 z-[112] overflow-hidden bg-gradient-to-br from-stone-900 via-stone-950 to-teal-950"
      style={{ pointerEvents: "auto" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: FADE_MS, ease: "easeOut" } }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      {/* drifting orbs — transform-only mirrored loops */}
      {ORBS.map((o, i) => (
        <motion.div
          key={i}
          aria-hidden
          className="pointer-events-none absolute rounded-full will-change-transform"
          style={{ width: o.size, height: o.size, left: o.cx, top: o.cy, background: o.bg }}
          animate={{ x: [o.ax, -o.ax, o.ax], y: [o.ay, -o.ay, o.ay] }}
          transition={{ duration: o.dur, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}

      {/* mark + wordmark + clock */}
      <div className="relative flex h-full flex-col items-center justify-center gap-4 px-6">
        <motion.div
          aria-hidden
          className="flex flex-col items-center gap-3"
          animate={{ scale: [1, 1.04, 1], opacity: [0.85, 1, 0.85] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
        >
          <LogoMark size={46} />
          <Wordmark className="text-4xl" />
        </motion.div>
        <p className="gd-mono text-7xl font-light tracking-tight text-white/90 tabular-nums sm:text-8xl">
          {hh}:{mm}
        </p>
        <p className="text-sm font-light text-white/40">
          {now.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      {/* anti-burn-in flavor */}
      <p className="absolute bottom-4 right-5 text-[10px] text-white/25">
        everything drifts, so nobody burns in
      </p>
    </motion.div>
  );
}
