"use client";

// ============================================================
// GlassDesk — Toaster: the on-screen toast stack (portal into
// document.body, top-right, BELOW the menu bar, above every
// overlay). Reads the LOCAL toast store — every seat renders
// its own toasts, nothing is synced.
//   • max 3 stacked (store caps `visible`), newest at the bottom
//   • spring enter from the right, spring exit + collapse
//   • auto-dismiss after 4.5 s, PAUSED while hovered
//   • click anywhere on a toast to dismiss it now
// Mounted once by the shell (SessionView); takes no props.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, OctagonX, type LucideIcon } from "lucide-react";
import { useToasts, type GdToast, type ToastKind } from "@/lib/vpc/toast";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;
const AUTO_DISMISS_MS = 4500;

const KIND_META: Record<ToastKind, { icon: LucideIcon; tile: string; text: string }> = {
  info: { icon: Info, tile: "bg-stone-100", text: "text-stone-500" },
  success: { icon: CheckCircle2, tile: "bg-emerald-50", text: "text-emerald-600" },
  warn: { icon: AlertTriangle, tile: "bg-amber-50", text: "text-amber-600" },
  danger: { icon: OctagonX, tile: "bg-rose-50", text: "text-rose-600" },
};

/** Compact relative time — "now" / "2m" / "1h" / "3d". */
function relTimeShort(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function Toaster() {
  const visible = useToasts((s) => s.visible);

  // Portal target only exists in the browser (same guard as ContextMenuHost).
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 top-16 z-[160] flex flex-col items-end gap-2"
    >
      <AnimatePresence initial={false}>
        {visible.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

function ToastCard({ toast }: { toast: GdToast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const [hovered, setHovered] = useState(false);
  // flung = dismissed via swipe — exit continues the fling direction
  const [flung, setFlung] = useState(false);

  // Auto-dismiss timer with hover-PAUSE (not restart): the remaining
  // budget is frozen while hovered and resumed on un-hover. All state
  // changes happen inside the timeout callbacks — never synchronously
  // in the effect body — and the cleanup clears the pending timer.
  const remainRef = useRef(AUTO_DISMISS_MS);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (hovered) {
      // pause: stop the clock and bank the remaining budget
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      remainRef.current = Math.max(0, remainRef.current - (Date.now() - startedAtRef.current));
      return;
    }
    // (re)start the clock with the remaining budget
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      dismiss(toast.id);
    }, remainRef.current);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [hovered, toast.id, dismiss]);

  const meta = KIND_META[toast.kind];
  const Icon = meta.icon;

  return (
    <motion.button
      type="button"
      layout
      aria-label={`${toast.title}${toast.body ? ` — ${toast.body}` : ""}`}
      onClick={() => dismiss(toast.id)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onBlur={() => setHovered(false)}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.0005, right: 0.55 }}
      dragMomentum={false}
      onDragEnd={(_, info) => {
        // fling-to-dismiss: past the offset OR fast enough — physics
        // decides, then the exit animation continues the direction
        if (info.offset.x > 72 || info.velocity.x > 480) {
          setFlung(true);
          dismiss(toast.id);
        }
      }}
      whileDrag={{ cursor: "grabbing" }}
      initial={{ opacity: 0, x: 40, scale: 0.96 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: flung ? 190 : 30, scale: 0.92, transition: SPRING }}
      transition={SPRING}
      className="glass-strong pointer-events-auto w-[300px] max-w-[calc(100vw-2rem)] cursor-pointer rounded-2xl p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
    >
      <div className="flex items-start gap-2.5">
        <span className={`grid size-8 shrink-0 place-items-center rounded-xl ${meta.tile} ${meta.text}`}>
          <Icon size={15} strokeWidth={2.2} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-semibold text-stone-700">{toast.title}</span>
          {toast.body ? (
            <span className="mt-0.5 block truncate text-xs text-stone-500">{toast.body}</span>
          ) : null}
        </span>
        <span className="gd-mono shrink-0 text-[10px] tabular-nums text-stone-400">
          {relTimeShort(toast.at, Date.now())}
        </span>
      </div>
    </motion.button>
  );
}
