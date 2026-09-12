"use client";

// ============================================================
// GlassDesk — Lock screen (calm, Apple-flavored). Renders while
// uiStore.locked is true: the LIVE desktop keeps running beneath
// a deep blur — windows stay synced, the radio keeps playing.
// Unlocking is a gesture, not a button: any click, Enter or
// Escape calls uiStore.unlock().
//
// Self-gating — mount it unconditionally in SessionView next to
// the other shell overlays; it renders null (and runs nothing)
// while unlocked. z-[200] sits above every overlay and the
// taskbar; only the ContextMenu host shares that tier.
// ============================================================

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { LogoMark } from "@/components/vpc/brand/Logo";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + last).toUpperCase() || "?";
}

export default function LockScreen() {
  const locked = useShellUi((s) => s.locked);
  const unlock = useShellUi((s) => s.unlock);
  const name = useGlassDesk((s) => s.name);
  const seat = useGlassDesk((s) => s.seat);
  const code = useGlassDesk((s) => s.code);

  const [now, setNow] = useState(() => new Date());

  // The clock only ticks while the screen is actually locked —
  // zero timers while it sits hidden in the tree.
  useEffect(() => {
    if (!locked) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [locked]);

  // Enter or Escape unlocks; any click lands on the overlay
  // itself (the card bubbles up to it).
  useEffect(() => {
    if (!locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        unlock();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, unlock]);

  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <AnimatePresence>
      {locked && (
        <motion.div
          key="lock-screen"
          role="dialog"
          aria-label="Screen locked — click anywhere or press Enter to unlock"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.28, ease: "easeOut" }}
          onPointerDown={() => unlock()}
          className="fixed inset-0 z-[200] flex select-none items-center justify-center bg-white/60 backdrop-blur-2xl"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={SPRING}
            className="glass-strong w-[min(92vw,440px)] rounded-3xl px-10 py-10 text-center sm:px-14"
          >
            <LogoMark size={34} />

            <p className="mt-4 text-[clamp(3.5rem,9vw,5.5rem)] font-extralight leading-none tracking-tight text-stone-800 tabular-nums">
              {clock}
            </p>
            <p className="mt-3 text-sm font-medium text-stone-500">{date}</p>

            <div className="mt-9 flex items-center justify-center gap-2.5">
              <span className="gd-accent-gradient flex size-9 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white shadow-sm">
                {initialsOf(name)}
              </span>
              <span className="truncate text-sm font-medium text-stone-700">
                {name || "Unnamed"}
              </span>
              <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
                {seat === "host" ? "host seat" : seat === "guest" ? "guest seat" : "connecting"}
              </span>
            </div>

            {code ? (
              <p className="gd-mono mt-3.5 text-[11px] tabular-nums tracking-[0.22em] text-stone-400">
                session {code}
              </p>
            ) : null}

            <motion.p
              animate={{ opacity: [0.45, 0.9, 0.45] }}
              transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
              className="mt-10 text-xs font-medium text-stone-500"
            >
              Press Enter or click to unlock
            </motion.p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
