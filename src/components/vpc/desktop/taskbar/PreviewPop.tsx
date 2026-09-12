"use client";

// ============================================================
// GlassDesk taskbar — HOVER PREVIEW popover (Windows 11 grade).
// Portal-rendered above the launcher while the pointer stays on
// the launcher or on this popover. Presentational only: windows,
// focus and close all arrive / dispatch via props, so this module
// never imports the app registry at runtime (no import cycles —
// AppMeta comes in as a type-only import).
//
// The dwell/grace timers live in Dock.tsx; this component only
// reports pointer enter/leave so the owner can pin or dismiss.
// ============================================================

import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import type { AppKind, WindowState } from "@/lib/vpc/types";
import type { AppMeta } from "../Dock";

/** Launcher geometry captured SYNCHRONOUSLY at pointer-enter (never
 *  re-read from the DOM later — React nulls currentTarget after
 *  dispatch, so all coordinates are snapshotted up front). */
export interface PreviewAnchor {
  x: number; // launcher center, viewport px
  top: number; // launcher top edge, viewport px
  vw: number; // viewport width at capture time
  vh: number; // viewport height at capture time
}

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;
const POPOVER_W = 250;
const THUMB_H = 86;

interface PreviewPopProps {
  app: AppKind;
  meta: AppMeta;
  /** the app's live windows, MRU (highest z) first */
  wins: WindowState[];
  activeWs: number;
  /** id of the globally focused window (accent ring), null if none */
  focusedId: string | null;
  anchor: PreviewAnchor;
  onActivate: (win: WindowState) => void;
  onCloseWin: (id: string) => void;
  onEnter: () => void;
  onLeave: () => void;
}

export default function PreviewPop({
  app,
  meta,
  wins,
  activeWs,
  focusedId,
  anchor,
  onActivate,
  onCloseWin,
  onEnter,
  onLeave,
}: PreviewPopProps) {
  if (typeof document === "undefined") return null;

  const Icon = meta.icon;
  const half = POPOVER_W / 2;
  const left = Math.max(half + 8, Math.min(anchor.x, anchor.vw - half - 8));
  const bottom = anchor.vh - anchor.top + 12;

  return createPortal(
    <motion.div
      role="dialog"
      aria-label={`${meta.label} — ${wins.length} window${wins.length > 1 ? "s" : ""}`}
      initial={{ opacity: 0, scale: 0.94, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 6 }}
      transition={SPRING}
      style={{ left, bottom, width: POPOVER_W, x: "-50%", transformOrigin: "bottom center" }}
      className="glass-strong gd-menu fixed z-[190] rounded-2xl p-2.5"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {/* header — app identity + window count */}
      <div className="flex items-center gap-2 px-1 pb-2">
        <AppIcon id={app} size={24} />
        <span className="text-xs font-semibold text-stone-700">{meta.label}</span>
        <span className="ml-auto text-[10px] font-medium tabular-nums text-stone-400">
          {wins.length} window{wins.length > 1 ? "s" : ""}
        </span>
      </div>

      {/* window cards */}
      <div className="gd-scroll flex max-h-[324px] flex-col gap-1.5 overflow-y-auto">
        {wins.map((w, i) => {
          const ratio = w.w / Math.max(1, w.h);
          const thumbW = Math.round(Math.min(POPOVER_W - 44, Math.max(64, THUMB_H * ratio)));
          const ws = w.workspace ?? 0;
          return (
            <motion.div
              key={w.id}
              role="button"
              tabIndex={0}
              aria-label={`Focus ${w.title}${w.minimized ? " (minimized)" : ""}`}
              title={w.title}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...SPRING, delay: Math.min(i * 0.03, 0.15) }}
              onClick={() => onActivate(w)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onActivate(w);
                }
              }}
              className="group relative cursor-pointer rounded-xl p-1.5 transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
              style={{ opacity: w.minimized ? 0.8 : 1 }}
            >
              {/* the mini "window" — APP_META gradient at the real aspect ratio */}
              <div
                className={`relative flex h-[86px] items-center justify-center overflow-hidden rounded-lg border bg-white/30 p-1 ${
                  w.id === focusedId ? "border-[var(--gd-accent)] shadow-[0_0_0_1px_var(--gd-accent)]" : "border-white/70"
                }`}
              >
                <div
                  className={`relative grid h-full place-items-center overflow-hidden rounded-md bg-gradient-to-br ${meta.gradient}`}
                  style={{ width: thumbW }}
                  aria-hidden
                >
                  {/* mini titlebar with traffic lights — sells "window" */}
                  <span className="absolute inset-x-0 top-0 flex h-[8px] items-center gap-[3px] bg-white/40 px-1">
                    <span className="size-[3px] rounded-full bg-rose-500" />
                    <span className="size-[3px] rounded-full bg-amber-500" />
                    <span className="size-[3px] rounded-full bg-emerald-500" />
                  </span>
                  <Icon size={24} strokeWidth={1.6} className="text-white/60" />
                </div>
                {ws !== activeWs && (
                  <span className="absolute left-2 top-2 rounded-md bg-stone-900/40 px-1 py-px text-[9px] font-medium text-white/90">
                    ws {ws + 1}
                  </span>
                )}
                {w.minimized && (
                  <span className="absolute bottom-2 left-2 rounded-md bg-stone-900/40 px-1 py-px text-[9px] font-medium text-white/90">
                    minimized
                  </span>
                )}
              </div>

              {/* title row */}
              <div className="mt-1 flex items-center gap-1.5 px-0.5">
                <span
                  className={`min-w-0 flex-1 truncate text-[11px] font-medium ${
                    w.minimized ? "text-stone-400" : "text-stone-700"
                  }`}
                >
                  {w.title}
                </span>
              </div>

              {/* close on hover — Windows thumbnail X */}
              <button
                type="button"
                aria-label={`Close ${w.title}`}
                title={`Close ${w.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseWin(w.id);
                }}
                className="absolute right-2 top-2 z-10 grid size-6 place-items-center rounded-lg bg-stone-900/35 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-rose-500 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X size={13} strokeWidth={2.4} />
              </button>
            </motion.div>
          );
        })}
      </div>
    </motion.div>,
    document.body,
  );
}
