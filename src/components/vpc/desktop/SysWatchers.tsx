"use client";

// ============================================================
// GlassDesk — SysWatchers: invisible system-event → toast bridge.
// Renders null; mounted ONCE by the shell (SessionView).
//
// Architecture (per the effect rules): every watcher registers a
// zustand store.subscribe() and pushes toasts ONLY from a timeout
// callback — never synchronously inside an effect body. Each
// watcher:
//   1. snapshots the INITIAL value at mount (mount happens after
//      join:ack, so the first peers/host/wallpaper state is the
//      "skip" baseline — nothing fires for it), and
//   2. DEBOUNCES 300 ms with a deferred diff: bursts that land
//      back on the same value (snapshot applies, reconnects)
//      never fire, and A→B→C bursts coalesce into A→C.
//
// Watched:
//   • peers  → "X joined" / "X left"   (name-set diff, self skipped)
//   • host   → "X is now host"         (host flag rides the peers map)
//   • media  → "♪ Now playing: <track>" (media rides the media WINDOW
//              payload {track,playing,t,medBy} — DesktopState has no
//              media field; see types.ts / MediaApp)
//   • wallpaper → "Wallpaper changed"  (only when already loaded)
// ============================================================

import { useEffect } from "react";
import { useGlassDesk, type PeerInfo } from "@/lib/vpc/store";
import { pushToast, type ToastKind } from "@/lib/vpc/toast";
import { TRACKS } from "@/lib/vpc/media";
import { WALLPAPERS } from "@/lib/vpc/types";

const WATCH_DEBOUNCE_MS = 300;

type Desk = ReturnType<typeof useGlassDesk.getState>;
type ToastSpec = { title: string; body?: string; kind?: ToastKind };

/**
 * Register a debounced store watcher. `select` picks the watched
 * slice (reference/value compared), `diff` turns a settled change
 * into toasts. Returns an unsubscribe+disarm function.
 */
function watch<T>(select: (s: Desk) => T, diff: (prev: T, next: T) => ToastSpec[]): () => void {
  let last: T = select(useGlassDesk.getState()); // initial snapshot — never fires
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    const cur = select(useGlassDesk.getState());
    const prev = last;
    last = cur;
    if (cur === prev) return; // burst landed back where it started
    for (const t of diff(prev, cur)) pushToast(t);
  };

  const unsub = useGlassDesk.subscribe((s) => {
    if (select(s) === last) return; // irrelevant mutation (cursors, ops, …)
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS); // (re)arm the debounce
  });

  return () => {
    unsub();
    if (timer !== null) clearTimeout(timer); // disarms pending toasts on unmount
  };
}

// ---------------- selectors ----------------

const peersOf = (s: Desk) => s.peers;

const hostOf = (s: Desk): string | null => {
  const host = Object.values(s.peers).find((p) => p.host);
  return host?.name ?? null;
};

const mediaTrackOf = (s: Desk): number | null => {
  const win = s.state?.windows.find((w) => w.app === "media");
  const track = win?.payload?.track;
  return typeof track === "number" ? track : null;
};

const wallpaperOf = (s: Desk): string | null => s.state?.wallpaper ?? null;

// ---------------- diffs ----------------

/** Peer display names, minus ourself (own join/leave is not news). */
function peerNames(p: Record<string, PeerInfo>): Set<string> {
  const selfId = useGlassDesk.getState().selfId;
  const names = new Set<string>();
  for (const peer of Object.values(p)) {
    if (selfId && peer.id === selfId) continue;
    if (peer.name) names.add(peer.name);
  }
  return names;
}

const peersDiff = (prev: Record<string, PeerInfo>, next: Record<string, PeerInfo>): ToastSpec[] => {
  const before = peerNames(prev);
  const after = peerNames(next);
  const out: ToastSpec[] = [];
  for (const n of after) if (!before.has(n)) out.push({ title: `${n} joined`, kind: "info" });
  for (const n of before) if (!after.has(n)) out.push({ title: `${n} left`, kind: "info" });
  return out;
};

const hostDiff = (prev: string | null, next: string | null): ToastSpec[] =>
  prev !== null && next !== null && next !== prev
    ? [{ title: `${next} is now host`, kind: "info" }]
    : [];

const mediaDiff = (prev: number | null, next: number | null): ToastSpec[] => {
  if (next === null || next === prev) return [];
  const track = TRACKS[next];
  return track
    ? [{ title: `♪ Now playing: ${track.title}`, body: track.artist, kind: "info" }]
    : [];
};

const wallpaperDiff = (prev: string | null, next: string | null): ToastSpec[] => {
  // only fire once the desktop is loaded AND the value actually moved
  if (prev === null || next === null || prev === next) return [];
  const label = WALLPAPERS.find((w) => w.id === next)?.label;
  return [{ title: "Wallpaper changed", body: label, kind: "info" }];
};

// ---------------- component ----------------

export default function SysWatchers() {
  useEffect(() => {
    const stoppers = [
      watch(peersOf, peersDiff),
      watch(hostOf, hostDiff),
      watch(mediaTrackOf, mediaDiff),
      watch(wallpaperOf, wallpaperDiff),
    ];
    return () => {
      for (const stop of stoppers) stop();
    };
  }, []);

  return null; // invisible — effects only
}
