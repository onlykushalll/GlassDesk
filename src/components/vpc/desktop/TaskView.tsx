"use client";

// ============================================================
// GlassDesk — Task View (Mission Control / Win11 Task View).
// Self-gates on the uiStore overlay "taskview" — mounted once by
// the shell, no props.
//   • full-viewport glass veil (z-[115]) over desktop + bar
//   • centered grid of LIVE PREVIEW cards for every window on
//     the viewed workspace (minimized ones included, desaturated
//     + chipped) — click focuses/restores, hover X closes
//   • workspace strip at the bottom: 4 chips with window counts;
//     clicking one switches the viewed (and active) workspace and
//     the task view STAYS open
//   • closes on backdrop click, Escape (and F3, the toggle key)
// ============================================================

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Monitor, X } from "lucide-react";
import { APP_META, nextZ } from "@/components/vpc/desktop/Dock";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { WORKSPACES, type WindowState } from "@/lib/vpc/types";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;

/** Preview aspect ratio clamps — keeps absurd windows recognizable. */
function clampRatio(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return 1.4;
  return Math.max(0.45, Math.min(3.4, r));
}

export default function TaskView() {
  const open = useShellUi((s) => s.overlay === "taskview");
  const setOverlay = useShellUi((s) => s.setOverlay);
  return (
    <AnimatePresence>
      {open && <TaskPanel key="task-panel" close={() => setOverlay(null)} />}
    </AnimatePresence>
  );
}

function TaskPanel({ close }: { close: () => void }) {
  const state = useGlassDesk((s) => s.state);
  const dispatch = useGlassDesk((s) => s.dispatch);

  // Escape closes; F3 is the toggle key, so pressing it while open
  // closes too (matches what toggleOverlay would do).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key === "F3") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const windows = state?.windows ?? [];
  const ws = state?.workspace ?? 0;
  const wsWindows = windows
    .filter((w) => (w.workspace ?? 0) === ws)
    .sort((a, b) => b.z - a.z); // topmost first
  const wsCounts = Array.from({ length: WORKSPACES }, (_, i) =>
    windows.filter((w) => (w.workspace ?? 0) === i).length,
  );

  return (
    <motion.div
      role="dialog"
      aria-label="Task view — windows on this workspace"
      onClick={close}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[115] bg-white/40 backdrop-blur-xl"
    >
      {/* scrollable center — the grid (or the empty state) */}
      <div className="gd-scroll h-full w-full overflow-y-auto px-6 pb-32 pt-16 sm:pt-20">
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col items-center justify-center">
          {wsWindows.length > 0 ? (
            <div className="grid w-full grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              <AnimatePresence>
                {wsWindows.map((w, i) => (
                  <TaskCard key={w.id} win={w} index={i} />
                ))}
              </AnimatePresence>
            </div>
          ) : (
            <motion.div
              className="flex flex-col items-center gap-3 text-center"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={SPRING}
            >
              <span className="grid size-14 place-items-center rounded-2xl bg-white/60 text-stone-400 shadow-sm">
                <Monitor size={24} />
              </span>
              <p className="text-sm font-semibold text-stone-600">Nothing here</p>
              <p className="max-w-56 text-xs leading-relaxed text-stone-400">
                Press Alt+Q later or open something from the dock.
              </p>
            </motion.div>
          )}
        </div>
      </div>

      {/* workspace strip — clicking a chip switches the view, task view stays open */}
      <div
        className="absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          role="group"
          aria-label="Workspaces"
          className="glass-strong flex items-center gap-2 rounded-2xl p-2"
        >
          {Array.from({ length: WORKSPACES }, (_, i) => {
            const active = ws === i;
            return (
              <button
                key={i}
                type="button"
                aria-label={`Workspace ${i + 1}, ${wsCounts[i]} window${wsCounts[i] === 1 ? "" : "s"}`}
                aria-pressed={active}
                onClick={() => dispatch({ t: "sys", patch: { workspace: i } })}
                className={`flex h-14 w-12 flex-col items-center justify-center gap-1 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                  active ? "gd-accent-gradient text-white shadow-md" : "bg-white/60 text-stone-600 hover:bg-white/80"
                }`}
              >
                <span className="text-sm font-semibold tabular-nums leading-none">{i + 1}</span>
                <span
                  className={`gd-mono text-[9px] tabular-nums leading-none ${
                    active ? "text-white/80" : "text-stone-400"
                  }`}
                >
                  {wsCounts[i]}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-[10px] text-stone-500">F3 task view · Esc to close</p>
      </div>
    </motion.div>
  );
}

function TaskCard({ win, index }: { win: WindowState; index: number }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const setOverlay = useShellUi((s) => s.setOverlay);
  const meta = APP_META[win.app];
  const ratio = clampRatio(win.w / win.h);

  function focusWindow(): void {
    dispatch({ t: "win:z", id: win.id, z: nextZ() });
    if (win.minimized) dispatch({ t: "win:min", id: win.id, minimized: false });
    setOverlay(null);
  }

  return (
    <motion.div
      className="group relative"
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ ...SPRING, delay: Math.min(index, 8) * 0.02 }}
    >
      <motion.button
        type="button"
        aria-label={`Focus ${win.title}${win.minimized ? " (minimized)" : ""}`}
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.97 }}
        transition={{ type: "spring", stiffness: 420, damping: 24 }}
        onClick={(e) => {
          e.stopPropagation();
          focusWindow();
        }}
        className="glass-strong w-full rounded-2xl p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
      >
        {/* live preview — gradient block at the window's aspect ratio,
            with a scaled-down titlebar strip baked in */}
        <div className="flex h-[132px] items-center justify-center overflow-hidden rounded-xl bg-stone-100/70">
          <div
            className={`relative h-full max-w-full overflow-hidden rounded-lg bg-gradient-to-br ${meta.gradient} shadow-inner ${
              win.minimized ? "opacity-75 saturate-[.6]" : ""
            }`}
            style={{ aspectRatio: ratio }}
          >
            <div className="absolute inset-x-0 top-0 flex h-3 items-center gap-1 bg-white/45 px-1.5">
              <span className="size-1 rounded-full bg-white/90" aria-hidden />
              <span className="size-1 rounded-full bg-white/75" aria-hidden />
              <span className="size-1 rounded-full bg-white/60" aria-hidden />
            </div>
          </div>
        </div>

        {/* icon + title + minimized chip */}
        <div className="mt-2 flex items-center gap-2">
          <AppIcon id={win.app} size={22} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700">{win.title}</span>
          {win.minimized && (
            <span className="shrink-0 rounded-full bg-stone-900/5 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-stone-400">
              minimized
            </span>
          )}
        </div>
      </motion.button>

      {/* close — stays in task view (only the veil closes it) */}
      <button
        type="button"
        aria-label={`Close ${win.title}`}
        title={`Close ${win.title}`}
        onClick={(e) => {
          e.stopPropagation();
          dispatch({ t: "win:close", id: win.id });
        }}
        className="absolute right-4 top-4 grid size-6 place-items-center rounded-full bg-white/85 text-stone-500 opacity-0 shadow-sm transition-all hover:bg-rose-50 hover:text-rose-600 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 group-hover:opacity-100"
      >
        <X size={13} strokeWidth={2.2} />
      </button>
    </motion.div>
  );
}
