"use client";

// ============================================================
// GlassDesk — Snap Assist (Windows 11).
//
// After a half-snap commits, a glass panel fills the REMAINING
// half and offers the other visible windows to fill it. Pure
// local UI — the trigger logic lives in Window.tsx, which passes
// the remaining rect (VIEWPORT coords) + the candidate windows.
// Picking one dispatches `win:geom` (fill the rect) + `win:z`
// (raise) back through the caller — everything syncs to the
// other seat via the normal op pipeline.
//
// Dismiss: pick · 6 s auto (thin accent meter) · Escape ·
// click-away (transparent shield under the panel). All timers /
// listeners live in effects with cleanup and only ever call the
// onDismiss prop from async callbacks (never setState directly
// in an effect body — house rule).
// ============================================================

import { useEffect } from "react";
import { motion } from "framer-motion";
import { Columns2, CornerDownLeft } from "lucide-react";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import type { WindowState } from "@/lib/vpc/types";

const AUTO_DISMISS_MS = 6000;

export interface SnapAssistRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapAssistProps {
  /** remaining half, VIEWPORT coordinates (fixed positioning) */
  rect: SnapAssistRect;
  /** other visible windows on the current workspace (never self) */
  candidates: WindowState[];
  /** fill the remaining rect with this window (id from candidates) */
  onPick: (id: string) => void;
  onDismiss: () => void;
}

export default function SnapAssist({ rect, candidates, onPick, onDismiss }: SnapAssistProps) {
  // 6 s auto-dismiss — the timeout callback owns the call, never
  // the effect body itself.
  useEffect(() => {
    const t = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  // Escape dismisses (window-level so focus state doesn't matter).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onDismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <>
      {/* click-away shield — transparent, sits under the panel but above
          the windows; taskbar (z-100) and menubar (z-110) stay live */}
      <div className="fixed inset-0 z-[79]" onPointerDown={onDismiss} aria-hidden />

      <motion.section
        role="dialog"
        aria-label="Snap assist — fill the other half"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }}
        transition={{ type: "spring", stiffness: 420, damping: 30 }}
        className="fixed z-[80] glass-strong rounded-2xl overflow-hidden flex flex-col"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        <div className="gd-scroll flex-1 min-h-0 grid place-items-center overflow-y-auto p-5">
          <div className="w-full max-w-sm">
            <div className="flex items-center gap-3">
              <span className="gd-accent-gradient grid size-9 shrink-0 place-items-center rounded-xl text-white shadow-md">
                <Columns2 size={16} strokeWidth={2.2} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-stone-700">Snap assist</p>
                <p className="text-[11px] text-stone-500">Fill the other half?</p>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-1">
              {candidates.length === 0 && (
                <p className="rounded-xl border border-white/50 bg-white/40 px-3 py-4 text-center text-xs text-stone-400">
                  No other windows open
                </p>
              )}
              {candidates.map((w) => {
                return (
                  <button
                    key={w.id}
                    type="button"
                    aria-label={`Snap ${w.title} into the free half`}
                    onClick={() => onPick(w.id)}
                    className="group flex w-full items-center gap-3 rounded-xl border border-white/60 bg-white/55 px-3 py-2.5 text-left transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  >
                    <span className="shrink-0 transition-transform group-hover:scale-105">
                      <AppIcon id={w.app} size={26} />
                    </span>
                    <span className="truncate text-[13px] font-medium text-stone-700">{w.title}</span>
                    <span className="ml-auto shrink-0 text-stone-400 opacity-0 transition-opacity group-hover:opacity-100">
                      <CornerDownLeft size={14} />
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="mt-3 text-center text-[10px] text-stone-400">
              click a window to fill the space · esc to dismiss
            </p>
          </div>
        </div>

        {/* 6 s auto-dismiss meter */}
        <div className="h-1 shrink-0 bg-white/40" aria-hidden>
          <motion.div
            className="h-full rounded-full gd-accent-gradient"
            initial={{ width: "100%" }}
            animate={{ width: "0%" }}
            transition={{ duration: AUTO_DISMISS_MS / 1000, ease: "linear" }}
          />
        </div>
      </motion.section>
    </>
  );
}
