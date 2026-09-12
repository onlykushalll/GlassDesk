"use client";

// ============================================================
// GlassDesk — LOCAL shell UI state (never synced, never persisted
// except user prefs). The taskbar/overlays all read+write here.
// Exclusive: opening one popover closes the others.
// ============================================================

import { create } from "zustand";

export type OverlayId =
  | "start"
  | "spotlight"
  | "control"
  | "calendar"
  | "taskview"
  | "notifs"
  | null;

interface ShellUi {
  overlay: OverlayId; // which popover/panel is open
  volume: number; // 0..1 — synth radio master (localStorage-backed)
  brightness: number; // 0.6..1 — desktop veil (localStorage-backed)
  switcher: { open: boolean; index: number }; // Alt+Q quick switcher
  locked: boolean; // lock screen shown (local theater, never synced)
  widgetsOpen: boolean; // left-edge widgets board (local, never synced)
  clipboardOpen: boolean; // Ctrl+Shift+V clipboard history popover
  aboutOpen: boolean; // "About GlassDesk" dialog (local, never synced)
  fullscreen: boolean; // REAL browser fullscreen (synced from fullscreenchange)
  callOpen: boolean; // call sidebar overlay — INDEPENDENT of chatOpen (12-e)
  chatOpen: boolean; // standalone chat panel overlay (12-e)
  setOverlay: (id: OverlayId) => void;
  toggleOverlay: (id: Exclude<OverlayId, null>) => void;
  setWidgetsOpen: (open: boolean) => void;
  setClipboardOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  setFullscreen: (v: boolean) => void;
  toggleFullscreen: () => void;
  setCallOpen: (open: boolean) => void;
  toggleCall: () => void;
  setChatOpen: (open: boolean) => void;
  toggleChat: () => void;
  setVolume: (v: number) => void;
  setBrightness: (v: number) => void;
  openSwitcher: (index: number) => void;
  cycleSwitcher: (count: number) => void;
  closeSwitcher: () => void;
  lock: () => void;
  unlock: () => void;
}

const VOL_KEY = "gd:volume";
const BRI_KEY = "gd:brightness";
// "prefer fullscreen" user intent (wave 12-d). Read once on
// SessionView mount — browsers only allow requestFullscreen()
// from a user gesture, so the stored "1" arms a ONE-TIME
// pointerdown listener that enters fullscreen on the first click.
export const FULLSCREEN_KEY = "gd:fullscreen";

function readPref(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* private mode */
  }
}

export const useShellUi = create<ShellUi>((set, get) => ({
  overlay: null,
  volume: readPref(VOL_KEY, 0.75, 0, 1),
  brightness: readPref(BRI_KEY, 1, 0.6, 1),
  switcher: { open: false, index: 0 },
  locked: false, // NOTE (6-e): field + lock()/unlock() existed but the
  // initializer was missing → tsc error + undefined at runtime. One-line
  // unblock; the declared contract is otherwise untouched.

  setOverlay: (id) => set({ overlay: id }),
  toggleOverlay: (id) => set({ overlay: get().overlay === id ? null : id }),

  // Widgets / clipboard are shell surfaces, not popovers — they keep
  // their own flags but follow the same "exclusive" house rule: opening
  // one clears the overlay stack and the sibling panel. Existing API
  // (overlay/popovers) is untouched.
  widgetsOpen: false,
  clipboardOpen: false,
  aboutOpen: false, // About dialog — cosmetic/local, never synced (10-a)
  setWidgetsOpen: (open) =>
    set(open ? { widgetsOpen: true, clipboardOpen: false, overlay: null } : { widgetsOpen: false }),
  setClipboardOpen: (open) =>
    set(open ? { clipboardOpen: true, widgetsOpen: false, overlay: null } : { clipboardOpen: false }),
  setAboutOpen: (open) =>
    set(open ? { aboutOpen: true, overlay: null } : { aboutOpen: false }),

  // ---- call / chat panels (12-e) ------------------------------------
  // Two INDEPENDENT floating overlays: opening one never closes the
  // other (chat works mid-call), but both follow the shell's house
  // rule and clear the popover stack when they open. Both default
  // CLOSED — the desktop owns its space until the user asks for a
  // panel (pill / tray button / hotkeys are the entries).
  callOpen: false,
  chatOpen: false,
  setCallOpen: (open) =>
    set(open ? { callOpen: true, overlay: null } : { callOpen: false }),
  setChatOpen: (open) =>
    set(open ? { chatOpen: true, overlay: null } : { chatOpen: false }),
  toggleCall: () => {
    const open = !get().callOpen;
    set(open ? { callOpen: true, overlay: null } : { callOpen: false });
  },
  toggleChat: () => {
    const open = !get().chatOpen;
    set(open ? { chatOpen: true, overlay: null } : { chatOpen: false });
  },

  // ---- fullscreen (12-d) -------------------------------------------
  // The DOM is the source of truth: toggleFullscreen() only REQUESTS
  // the transition (fire-and-forget promise) — the `fullscreen` flag
  // itself is synced by SessionView's "fullscreenchange" listener, so
  // a rejected request (no gesture / iframe policy) can never desync
  // the UI. setFullscreen() is that listener's write path.
  fullscreen: false,
  setFullscreen: (v) => set({ fullscreen: v }),
  toggleFullscreen: () => {
    if (typeof document === "undefined") return;
    const want = !document.fullscreenElement;
    try {
      if (want) {
        void document.documentElement
          .requestFullscreen()
          .then(() => undefined)
          .catch(() => {
            /* rejected (no gesture / not allowed) — state stays put */
          });
      } else {
        void document
          .exitFullscreen()
          .then(() => undefined)
          .catch(() => {
            /* already exited — nothing to do */
          });
      }
    } catch {
      /* older embedders throw synchronously — swallow, stay honest */
    }
    // persist the USER INTENT (button / F11 toggles only; a native
    // Esc exit keeps the preference so the next session still
    // auto-enters fullscreen on first click)
    try {
      localStorage.setItem(FULLSCREEN_KEY, want ? "1" : "0");
    } catch {
      /* private mode */
    }
  },

  setVolume: (v) => {
    const vol = Math.min(1, Math.max(0, v));
    writePref(VOL_KEY, vol);
    set({ volume: vol });
  },
  setBrightness: (v) => {
    const bri = Math.min(1, Math.max(0.6, v));
    writePref(BRI_KEY, bri);
    set({ brightness: bri });
  },

  openSwitcher: (index) => set({ switcher: { open: true, index }, overlay: null }),
  cycleSwitcher: (count) => {
    const sw = get().switcher;
    if (!sw.open || count <= 0) return;
    set({ switcher: { open: true, index: (sw.index + 1) % count } });
  },
  closeSwitcher: () => set({ switcher: { open: false, index: 0 } }),

  lock: () => set({ locked: true, overlay: null }),
  unlock: () => set({ locked: false }),
}));
