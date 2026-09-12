"use client";

// ============================================================
// GlassDesk — Clipboard history (Win+V, GlassDesk edition).
//
// Every text copy made anywhere in this tab lands in a LOCAL,
// never-synced history (max 25 items, 500 chars each, consecutive
// duplicates dropped). Pinned items float to the top and persist
// in sessionStorage ("gd:clipboard-pins") for the tab session.
//
//   • open: Ctrl+Shift+V / Cmd+Shift+V (global keydown, captured
//     before app shortcuts, preventDefault — never synced)
//   • click a row → re-copy via navigator.clipboard + toast
//   • pin / delete per row · Clear all in the footer
//   • popover springs up from above the taskbar, scrim / ESC
//     closes (z-[75], one notch above the widgets board)
//
// Capture uses the document "copy" event: clipboardData is
// WRITE-protected mid-copy in most engines, so the selection
// fallback is the real workhorse (the selection still exists at
// copy time). Mounted once by Desktop.tsx.
// ============================================================

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ClipboardList, Pin, PinOff, Trash2, X } from "lucide-react";
import { create } from "zustand";
import { pushToast } from "@/lib/vpc/toast";
import { useShellUi } from "@/lib/vpc/uiStore";
import { SPRING } from "@/lib/vpc/motion";
import { useGlassDesk } from "@/lib/vpc/store";

const MAX_ITEMS = 25;
const MAX_CHARS = 500;
const PINS_KEY = "gd:clipboard-pins";

interface ClipItem {
  id: number;
  text: string;
  at: number;
  pinned: boolean;
}

interface ClipStore {
  items: ClipItem[];
  push: (text: string) => void;
  togglePin: (id: number) => void;
  remove: (id: number) => void;
  clear: () => void;
}

let nextClipId = 1;

/** Pinned items survive reloads within the tab session (sessionStorage). */
function loadPins(): ClipItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(PINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { text?: unknown; at?: unknown }[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is { text: string; at?: number } => typeof p.text === "string" && p.text.length > 0)
      .slice(0, MAX_ITEMS)
      .map((p) => ({ id: nextClipId++, text: p.text.slice(0, MAX_CHARS), at: typeof p.at === "number" ? p.at : Date.now(), pinned: true }));
  } catch {
    return [];
  }
}

function persistPins(items: ClipItem[]): void {
  try {
    const pins = items.filter((i) => i.pinned).map((i) => ({ text: i.text, at: i.at }));
    sessionStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    /* private mode — pins just won't survive a reload */
  }
}

/** Module-level store — capture happens even while the popover is closed. */
const useClipHistory = create<ClipStore>((set, get) => ({
  items: loadPins(),

  push: (text) => {
    const clean = text.slice(0, MAX_CHARS);
    if (!clean.trim()) return;
    const items = get().items;
    if (items[0]?.text === clean) return; // consecutive duplicate
    const item: ClipItem = { id: nextClipId++, text: clean, at: Date.now(), pinned: false };
    // insert BELOW the pinned block (pins always float to the top)
    const firstUnpinned = items.findIndex((i) => !i.pinned);
    const at = firstUnpinned === -1 ? items.length : firstUnpinned;
    let next = [...items.slice(0, at), item, ...items.slice(at)];
    // cap 25 — never drop pinned items to satisfy the cap
    if (next.length > MAX_ITEMS) {
      let dropped = 0;
      const overflow = next.length - MAX_ITEMS;
      const kept: ClipItem[] = [];
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i];
        if (!it.pinned && dropped < overflow) {
          dropped++;
          continue;
        }
        kept.unshift(it);
      }
      next = kept;
    }
    set({ items: next });
  },

  togglePin: (id) => {
    const marked = get().items.map((i) => (i.id === id ? { ...i, pinned: !i.pinned } : i));
    const next = [...marked.filter((i) => i.pinned), ...marked.filter((i) => !i.pinned)];
    persistPins(next);
    set({ items: next });
  },

  remove: (id) => {
    const next = get().items.filter((i) => i.id !== id);
    persistPins(next);
    set({ items: next });
  },

  clear: () => {
    persistPins([]);
    set({ items: [] });
  },
}));

/** Coarse relative time — "just now" / "4m ago" / "3h ago". */
function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ============================================================
// root — capture listener + hotkey + gated popover
// ============================================================

export default function ClipboardPop() {
  const open = useShellUi((s) => s.clipboardOpen);
  const setClipboardOpen = useShellUi((s) => s.setClipboardOpen);

  // Global capture — runs whether or not the popover is open.
  useEffect(() => {
    function onCopy(e: ClipboardEvent): void {
      // clipboardData is write-protected mid-copy in most engines —
      // the live selection is the reliable source at this instant.
      let text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) {
        text = window.getSelection()?.toString() ?? "";
      }
      if (text) useClipHistory.getState().push(text);
    }
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  // Ctrl/Cmd + Shift + V toggles the popover (capture: never let the
  // browser's paste-as-plain-text shortcut race us). Skipped during
  // boot — the popover must never poke over the boot overlay.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.code !== "KeyV") return;
      if (e.repeat) return;
      if (!useGlassDesk.getState().state?.booted) return;
      e.preventDefault();
      const ui = useShellUi.getState();
      ui.setClipboardOpen(!ui.clipboardOpen);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <AnimatePresence>
      {open && <ClipPanel key="clip-panel" close={() => setClipboardOpen(false)} />}
    </AnimatePresence>
  );
}

// ============================================================
// the popover
// ============================================================

function ClipPanel({ close }: { close: () => void }) {
  const items = useClipHistory((s) => s.items);
  const togglePin = useClipHistory((s) => s.togglePin);
  const removeItem = useClipHistory((s) => s.remove);
  const clearAll = useClipHistory((s) => s.clear);

  // Escape closes from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // time-ago ticker
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  async function recopy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      pushToast({
        title: "Copied",
        body: text.length > 80 ? `${text.slice(0, 80)}…` : text,
        kind: "success",
      });
    } catch {
      pushToast({ title: "Copy failed", body: "Clipboard is unavailable here", kind: "warn" });
    }
    close();
  }

  return (
    <>
      {/* scrim — click closes (below the popover, above the desktop) */}
      <motion.div
        aria-hidden
        onPointerDown={close}
        className="absolute inset-0 z-[73] bg-stone-900/10"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.14 }}
      />

      {/* plain wrapper owns the -translate-x-1/2; the motion child
          animates y/scale/opacity on its own transform */}
      <div className="absolute bottom-[76px] left-1/2 z-[75] w-96 max-w-[calc(100%-1.5rem)] -translate-x-1/2">
        <motion.div
          role="dialog"
          aria-label="Clipboard history"
          className="glass-strong overflow-hidden rounded-2xl"
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.98 }}
          transition={SPRING.window}
        >
          <div className="flex items-center gap-2 border-b border-white/50 p-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/80 text-stone-500">
              <ClipboardList size={14} />
            </span>
            <h2 className="text-sm font-semibold text-stone-700">Clipboard</h2>
            <span className="gd-mono rounded-full bg-white/60 px-1.5 py-0.5 text-[10px] tabular-nums text-stone-400">
              {items.length}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              aria-label="Close clipboard history"
              onClick={close}
              className="grid size-7 place-items-center rounded-lg text-stone-400 transition-colors hover:bg-white/80 hover:text-stone-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
            >
              <X size={15} />
            </button>
          </div>

          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-8 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-stone-100 text-stone-400">
                <ClipboardList size={22} />
              </span>
              <p className="text-xs font-medium text-stone-500">Nothing copied yet</p>
              <p className="text-[10px] leading-relaxed text-stone-400">
                Copy anything in GlassDesk — it lands here. (Ctrl+Shift+V)
              </p>
            </div>
          ) : (
            <div
              role="list"
              aria-label="Copied items"
              className="gd-scroll max-h-80 space-y-0.5 overflow-y-auto p-2"
            >
              {items.map((item) => (
                <div
                  key={item.id}
                  role="listitem"
                  className="group flex items-start gap-1 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-white/70"
                >
                  <button
                    type="button"
                    onClick={() => void recopy(item.text)}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] focus-visible:rounded-lg"
                    aria-label={`Copy: ${item.text.slice(0, 60)}`}
                  >
                    <p className="gd-mono line-clamp-2 break-all text-[11px] leading-snug text-stone-700">
                      {item.text}
                    </p>
                    <p className="mt-0.5 text-[10px] text-stone-400">
                      {relTime(item.at, now)}
                      {item.pinned ? " · pinned" : ""}
                    </p>
                  </button>
                  <span className="flex shrink-0 items-center gap-0.5 pt-0.5">
                    <button
                      type="button"
                      aria-label={item.pinned ? "Unpin item" : "Pin item"}
                      onClick={() => togglePin(item.id)}
                      className={`grid size-6 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)] ${
                        item.pinned
                          ? "text-[var(--gd-accent)]"
                          : "text-stone-400 hover:text-stone-600"
                      } hover:bg-white/90`}
                    >
                      {item.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                    </button>
                    <button
                      type="button"
                      aria-label="Remove item"
                      onClick={() => removeItem(item.id)}
                      className="grid size-6 place-items-center rounded-md text-stone-400 transition-colors hover:bg-white/90 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
                    >
                      <X size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {items.length > 0 && (
            <div className="flex items-center justify-end border-t border-white/50 px-3 py-2">
              <button
                type="button"
                onClick={() => clearAll()}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-stone-500 transition-colors hover:bg-white/80 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--gd-accent)]"
              >
                <Trash2 size={11} />
                Clear all
              </button>
            </div>
          )}
        </motion.div>
      </div>
    </>
  );
}
