"use client";

// ============================================================
// GlassDesk — SessionView: the fixed desktop shell.
//
//   <main> (FULL viewport height — no menubar, 12-d) → Desktop
//   + CallSidebar (toggleable OVERLAY, 12-e) + ChatPanel.
//   The taskbar tray carries the session pill (peers · code ·
//   connection), the fullscreen toggle and the chat button.
//
// Shell OS wiring lives here:
//  • KEYBOARD: Ctrl/Cmd+K (Search) · Ctrl+Space (Search) ·
//    Ctrl/Cmd+Shift+C (Chat panel — 12-e) · Ctrl+Alt+←/→
//    (workspace) · Alt+Q (quick window switcher) · F11 (real
//    browser fullscreen — preferred for max view) · Escape
//    (close overlays + floating panels)
//  • FULLSCREEN: window "fullscreenchange" keeps uiStore truthful;
//    the stored "prefer fullscreen" preference arms a one-time
//    gesture listener on mount (browsers require a user gesture)
//  • QUICK SWITCHER: Alt+Q cycles visible windows z-order, with
//    a glass alt-tab overlay; commits after 900ms of silence
//  • OVERLAYS: StartMenu / Spotlight / ControlCenter / Calendar
//    (self-gated on uiStore) + the ContextMenu host — all mounted
//    exactly once
//  • sets the live accent CSS vars; brightness veil is in Desktop
// ============================================================

import { useEffect, useRef, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, WifiOff } from "lucide-react";
import CallSidebar from "@/components/vpc/call/CallSidebar";
import ChatPanel from "@/components/vpc/call/ChatPanel";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi, FULLSCREEN_KEY } from "@/lib/vpc/uiStore";
import { AppIcon } from "@/components/vpc/icons/AppIcon";
import { WORKSPACES, accentOf } from "@/lib/vpc/types";
import Desktop from "@/components/vpc/desktop/Desktop";
import AboutDialog from "@/components/vpc/desktop/AboutDialog";
import { ContextMenuHost } from "@/components/vpc/desktop/ContextMenu";
import StartMenu from "@/components/vpc/desktop/StartMenu";
import Spotlight from "@/components/vpc/desktop/Spotlight";
import ControlCenter from "@/components/vpc/desktop/ControlCenter";
import CalendarPop from "@/components/vpc/desktop/CalendarPop";
import Toaster from "@/components/vpc/desktop/Toaster";
import NotifCenter from "@/components/vpc/desktop/NotifCenter";
import TaskView from "@/components/vpc/desktop/TaskView";
import SysWatchers from "@/components/vpc/desktop/SysWatchers";
import LockScreen from "@/components/vpc/desktop/LockScreen";

const SWITCHER_COMMIT_MS = 900;

export default function SessionView() {
  const state = useGlassDesk((s) => s.state);
  const connected = useGlassDesk((s) => s.connected);

  const setOverlay = useShellUi((s) => s.setOverlay);
  const overlay = useShellUi((s) => s.overlay);

  const accent = state ? accentOf(state.accent) : accentOf("teal");
  const accentVars = {
    "--gd-accent": accent.hex,
    "--gd-accent-2": accent.hex2,
  } as CSSProperties;

  // ---------------- global keyboard (the OS shortcuts) ----------------
  const switcher = useShellUi((s) => s.switcher);
  const cycleSwitcher = useShellUi((s) => s.cycleSwitcher);
  const closeSwitcher = useShellUi((s) => s.closeSwitcher);
  const commitTimer = useRef<number | null>(null);

  // windows on the active workspace, top-of-z first (switcher order)
  const switchList = state
    ? state.windows
        .filter((w) => !w.minimized && (w.workspace ?? 0) === state.workspace)
        .sort((a, b) => b.z - a.z)
    : [];

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const mod = e.ctrlKey || e.metaKey;
      const s = useGlassDesk.getState();
      const ui = useShellUi.getState();

      // locked screen swallows everything (its own listener unlocks)
      if (ui.locked) return;

      // Fullscreen — F11 (real browser fullscreen; the shell prefers
      // it: zero chrome, maximum vertical space for windows)
      if (e.key === "F11") {
        e.preventDefault();
        ui.toggleFullscreen();
        return;
      }

      // Task view — F3 (Win11-style mission control)
      if (e.key === "F3") {
        e.preventDefault();
        ui.toggleOverlay("taskview");
        return;
      }

      // Search (Spotlight)
      if (mod && (e.key === "k" || e.key === "K") && !e.shiftKey) {
        e.preventDefault();
        ui.toggleOverlay("spotlight");
        return;
      }
      if (e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        ui.toggleOverlay("spotlight");
        return;
      }

      // Chat panel — Ctrl/Cmd+Shift+C (standalone surface; works
      // with or without a live call, 12-e)
      if (mod && e.shiftKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        ui.toggleChat();
        return;
      }

      // workspaces
      if (e.ctrlKey && e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        if (!s.state) return;
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const next = (s.state.workspace + dir + WORKSPACES) % WORKSPACES;
        s.dispatch({ t: "sys", patch: { workspace: next } });
        return;
      }

      // quick switcher — Alt+Q cycles the active workspace's windows
      if (e.altKey && (e.key === "q" || e.key === "Q")) {
        e.preventDefault();
        const st = useGlassDesk.getState().state;
        const count = st
          ? st.windows.filter((w) => !w.minimized && (w.workspace ?? 0) === st.workspace).length
          : 0;
        if (count > 1) ui.cycleSwitcher(count);
        return;
      }

      // Escape closes overlays + the floating panels (call / chat —
      // both are keyboard-escapable even without focus)
      if (
        e.key === "Escape" &&
        (ui.overlay !== null || ui.switcher.open || ui.chatOpen || ui.callOpen)
      ) {
        e.preventDefault();
        if (ui.overlay !== null) ui.setOverlay(null);
        if (ui.switcher.open) ui.closeSwitcher();
        if (ui.chatOpen) ui.setChatOpen(false);
        if (ui.callOpen) ui.setCallOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // auto-commit the switcher selection shortly after the last Alt+Q
  useEffect(() => {
    if (!switcher.open) return;
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      const idx = useShellUi.getState().switcher.index;
      const list = switchList;
      const win = list[idx % Math.max(1, list.length)];
      if (win) {
        const s = useGlassDesk.getState();
        s.dispatch({ t: "win:z", id: win.id, z: s.nextZ() });
      }
      useShellUi.getState().closeSwitcher();
    }, SWITCHER_COMMIT_MS);
    return () => {
      if (commitTimer.current !== null) {
        clearTimeout(commitTimer.current);
        commitTimer.current = null;
      }
    };
  }, [switcher.open, switcher.index]);

  // ---- fullscreen (12-d) --------------------------------------------
  // The DOM is the source of truth: every entry/exit path (button,
  // F11, native Esc, OS gestures) fires "fullscreenchange" — one
  // listener keeps uiStore truthful. Adopt the current state on
  // mount too (e.g. a dev-HMR remount while already fullscreen).
  useEffect(() => {
    const onFsChange = (): void => {
      useShellUi
        .getState()
        .setFullscreen(typeof document !== "undefined" && document.fullscreenElement !== null);
    };
    window.addEventListener("fullscreenchange", onFsChange);
    onFsChange();
    return () => window.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // "prefer fullscreen": when the stored preference says so, arm a
  // ONE-TIME gesture listener — requestFullscreen() is only allowed
  // from a user gesture, so the very first click takes the shell
  // fullscreen and the listener disarms itself.
  useEffect(() => {
    let prefersFullscreen = false;
    try {
      prefersFullscreen = localStorage.getItem(FULLSCREEN_KEY) === "1";
    } catch {
      /* private mode — windowed */
    }
    if (!prefersFullscreen) return;
    const enterOnGesture = (): void => {
      try {
        void document.documentElement.requestFullscreen().catch(() => {
          /* gesture not allowed after all — stay windowed */
        });
      } catch {
        /* synchronous reject (old embedders) — stay windowed */
      }
    };
    window.addEventListener("pointerdown", enterOnGesture, { once: true });
    return () => window.removeEventListener("pointerdown", enterOnGesture);
  }, []);

  return (
    <div style={accentVars} className="h-dvh w-full overflow-hidden flex flex-col relative">
      <main className="flex-1 min-h-0 flex relative">
        <Desktop />
        {/* call sidebar — an overlay for ALL sizes now (12-e): pill,
            slide-in panel and the live-call PiP all read
            uiStore.callOpen; the desktop never reflows */}
        <CallSidebar />
      </main>

      {/* reconnect strip */}
      <AnimatePresence>
        {!connected && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[125] pointer-events-none">
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="glass rounded-full pl-3 pr-4 py-2 flex items-center gap-2 text-amber-800"
              style={{ background: "rgba(255,251,235,0.85)", borderColor: "rgba(253,230,138,0.8)" }}
            >
              <WifiOff size={14} className="animate-pulse" />
              <span className="text-xs font-medium whitespace-nowrap">
                reconnecting — your PC keeps running…
              </span>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* quick switcher (Alt+Q) — glass alt-tab */}
      <AnimatePresence>
        {switcher.open && switchList.length > 0 && (
          <motion.div
            key="switcher"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 440, damping: 34 }}
            className="fixed left-1/2 top-[22vh] z-[140] -translate-x-1/2"
            role="dialog"
            aria-label="Quick window switcher"
          >
            <div className="glass-strong rounded-2xl p-3 flex gap-2 shadow-2xl max-w-[92vw] overflow-x-auto gd-scroll">
              {switchList.map((w, i) => {
                const active = i === switcher.index % switchList.length;
                return (
                  <div
                    key={w.id}
                    className={`flex w-24 flex-col items-center gap-1.5 rounded-xl p-2 ${
                      active ? "bg-white/90 ring-2 ring-[var(--gd-accent)] shadow-md" : "opacity-70"
                    }`}
                  >
                    <AppIcon id={w.app} size={38} />
                    <span className="line-clamp-1 w-full text-center text-[10px] font-medium text-stone-600">
                      {w.title}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-center text-[10px] text-stone-500">
              Alt+Q cycles · releasing commits
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* shell overlays — self-gated on uiStore */}
      <StartMenu />
      <Spotlight />
      <ControlCenter />
      <CalendarPop />
      <NotifCenter />
      <TaskView />
      <ContextMenuHost />

      {/* standalone chat panel (12-e) — floating right overlay,
          self-gated on uiStore.chatOpen, independent of the call */}
      <ChatPanel />

      {/* About GlassDesk — local, never synced; fixed-position dialog
          (formerly housed in the deleted MenuBar) still reachable via
          the desktop right-click menu → "About GlassDesk" */}
      <AboutDialog />

      {/* notification toasts + system watchers (invisible) */}
      <Toaster />
      <SysWatchers />

      {/* lock screen (local theater, z-200) */}
      <LockScreen />

      {/* state not landed yet */}
      {!state && (
        <div className="absolute inset-0 z-[145] flex flex-col items-center justify-center gap-3 bg-white/50 backdrop-blur-sm">
          <Loader2 size={28} className="animate-spin text-stone-400" />
          <span className="text-xs text-stone-500">waking your GlassDesk…</span>
        </div>
      )}
    </div>
  );
}
