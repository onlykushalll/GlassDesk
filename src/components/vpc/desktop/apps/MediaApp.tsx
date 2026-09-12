"use client";

// ============================================================
// GlassDesk — Music 2.0 (component name stays MediaApp; the dock
// label is "Media"). Apple-Music-style shell wrapped around the
// UNCHANGED synced synth radio engine (lib/vpc/media.ts):
//
//   payload { track, playing, t, medBy }
//   · whoever last interacted (medBy) is the drift authority and
//     re-publishes t at 2 Hz while playing
//   · the follower seat hard-jumps when local drifts > 1.5 s
//   · useSynthRadio renders each track live from the shared
//     playhead — both seats hear the same second, audible
//   · volume is LOCAL (own speakers), never synced
//
// UI: Library sidebar (collapses to an icon rail when narrow) +
// now-playing hero with a 24-bar visualizer that FREEZES on pause
// (CSS keyframes + animation-play-state) + big transport with
// spring taps + seek + per-seat volume.
// ============================================================

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { motion } from "framer-motion";
import { ListMusic, Music, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { TRACKS, useSynthRadio } from "@/lib/vpc/media";
import { accentOf, type WindowState } from "@/lib/vpc/types";

interface MediaPayload {
  track?: number;
  playing?: boolean;
  t?: number;
  medBy?: string;
}

const DISPLAY_TICK_MS = 1000; // local display ticker
const PUBLISH_MS = 500; // authority publishes t at 2 Hz
const FOLLOWER_JUMP_S = 1.5; // follower jumps when local drifts this far

const RAIL_AT_W = 600; // below this width the library collapses to an icon rail
const HERO_ROW_AT_W = 380; // main-pane width where art+info sit side by side

const VIS_BARS = 24;

/** Per-track genre theater (UI-level mapping; media.ts stays untouched). */
const GENRES = ["Ambient", "Downtempo", "Dream Pop", "Lo-Fi", "Neo-Classical", "IDM"];

/** Visualizer keyframes: scaleY loop + FREEZE on pause via play-state. */
const VIS_CSS = `
@keyframes gd-vis {
  0% { transform: scaleY(0.14); }
  100% { transform: scaleY(var(--gd-s, 0.7)); }
}
.gd-vis-bar {
  transform-origin: bottom center;
  border-radius: 999px;
  animation: gd-vis var(--gd-d, 0.9s) ease-in-out var(--gd-dl, 0s) infinite alternate;
  will-change: transform;
  transition: opacity 0.3s ease;
}
.gd-vis-idle .gd-vis-bar {
  animation-play-state: paused;
  opacity: 0.4;
}
`;

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function clampTrack(raw: unknown): number {
  const n = typeof raw === "number" ? Math.floor(raw) : 0;
  return Math.max(0, Math.min(n, TRACKS.length - 1));
}

/** Measure the app's own pane (not the viewport) — windows resize freely. */
function useMeasure<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  { w: number; h: number },
] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number, h: number) =>
      setSize((prev) => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }));
    const r = el.getBoundingClientRect();
    apply(r.width, r.height);
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) apply(e.contentRect.width, e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export default function MediaApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const selfId = useGlassDesk((s) => s.selfId);
  const myName = useGlassDesk((s) => s.name);
  const peers = useGlassDesk((s) => s.peers);
  const accentId = useGlassDesk((s) => s.state?.accent) ?? "teal";
  const volume = useShellUi((s) => s.volume);
  const setVolume = useShellUi((s) => s.setVolume);

  const [rootRef, { w, h }] = useMeasure<HTMLDivElement>();
  const rail = w > 0 && w < RAIL_AT_W;
  const heroRow = Math.max(0, w - (rail ? 60 : 216)) >= HERO_ROW_AT_W;
  const short = h > 0 && h < 460; // compact vertical rhythm at min window height

  const p = win.payload as unknown as MediaPayload;
  const track = clampTrack(p.track);
  const playing = p.playing === true;
  const remoteT = typeof p.t === "number" ? p.t : 0;
  const medBy = typeof p.medBy === "string" ? p.medBy : null;
  const medName = medBy ? (medBy === selfId ? myName : (peers[medBy]?.name ?? null)) : null;

  const cur = TRACKS[track];
  const acc = accentOf(accentId);

  const [displayT, setDisplayT] = useState(() => remoteT);
  const [dragT, setDragT] = useState<number | null>(null);

  // local playhead anchor — advanced by the wall clock while playing
  const anchorRef = useRef({ at: Date.now(), t: remoteT, playing });
  const lastTrackRef = useRef(track);

  const localT = useCallback(() => {
    const a = anchorRef.current;
    const dur = TRACKS[track]?.dur ?? 0;
    const raw = a.playing ? a.t + (Date.now() - a.at) / 1000 : a.t;
    return Math.max(0, Math.min(raw, dur));
  }, [track]);

  // payload → local anchor (jump on drift > 1.5 s, track or play-state change)
  useEffect(() => {
    const trackChanged = lastTrackRef.current !== track;
    lastTrackRef.current = track;
    const a = anchorRef.current;
    const computed = a.playing ? a.t + (Date.now() - a.at) / 1000 : a.t;
    if (trackChanged || a.playing !== playing || Math.abs(computed - remoteT) > FOLLOWER_JUMP_S) {
      anchorRef.current = { at: Date.now(), t: remoteT, playing };
      setDisplayT(remoteT);
    }
  }, [remoteT, playing, track]);

  // local display ticker (1 Hz, display only)
  useEffect(() => {
    const iv = window.setInterval(() => setDisplayT(localT()), DISPLAY_TICK_MS);
    return () => window.clearInterval(iv);
  }, [localT]);

  // ---- AUDIO: the shared synth radio follows localT ----
  const getPos = useCallback(() => localT(), [localT]);
  const radio = useSynthRadio({ track, playing, getPos, volume });

  // any interaction claims the playhead and snapshots all fields
  const interact = useCallback(
    (next: { track?: number; t?: number; playing?: boolean }) => {
      const st = useGlassDesk.getState().state;
      const winRow = st?.windows.find((x) => x.id === win.id);
      const curp = (winRow?.payload ?? {}) as unknown as MediaPayload;
      dispatch({
        t: "app:patch",
        id: win.id,
        patch: {
          track: typeof next.track === "number" ? next.track : clampTrack(curp.track),
          playing: typeof next.playing === "boolean" ? next.playing : curp.playing === true,
          t: typeof next.t === "number" ? next.t : typeof curp.t === "number" ? curp.t : 0,
          medBy: selfId ?? "self",
        },
      });
    },
    [dispatch, selfId, win.id],
  );

  // drift authority: re-publish t at 2 Hz while playing, auto-advance tracks
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (!selfId || medBy !== selfId || !playing) return;
      const t = localT();
      const dur = TRACKS[track]?.dur ?? 0;
      if (t >= dur - 0.4) {
        interact({ track: (track + 1) % TRACKS.length, t: 0, playing: true });
        return;
      }
      dispatch({ t: "app:patch", id: win.id, patch: { t } });
    }, PUBLISH_MS);
    return () => window.clearInterval(iv);
  }, [dispatch, interact, localT, medBy, playing, selfId, track, win.id]);

  const shownT = dragT ?? Math.min(displayT, cur.dur);
  const driveLabel = !medBy
    ? "idle — first touch claims the playhead"
    : medBy === selfId
      ? "you drive the playhead"
      : `${medName ?? "the other seat"} drives the playhead`;

  // local volume with mute memory — never synced (own speakers)
  const lastVolRef = useRef(0.75);
  const muted = volume <= 0.001;
  const toggleMute = useCallback(() => {
    if (muted) {
      setVolume(lastVolRef.current > 0.05 ? lastVolRef.current : 0.75);
    } else {
      lastVolRef.current = volume;
      setVolume(0);
    }
  }, [muted, setVolume, volume]);

  const tapSpring = { type: "spring" as const, stiffness: 450, damping: 26 };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 overflow-hidden">
      <style>{VIS_CSS}</style>

      {/* ---------------- Library sidebar / icon rail ---------------- */}
      <nav
        aria-label="Music library"
        className={`gd-scroll shrink-0 overflow-y-auto border-r border-white/50 bg-white/25 ${
          rail ? "w-[60px] px-2 py-3" : "w-[216px] px-3 py-3"
        }`}
      >
        {!rail && (
          <div className="flex items-center gap-2 px-1.5 pb-2">
            <ListMusic className="h-3.5 w-3.5 text-stone-400" />
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">Library</h2>
            <span className="gd-mono ml-auto text-[10px] text-stone-400">{TRACKS.length}</span>
          </div>
        )}
        <ul className={rail ? "flex flex-col items-center gap-2" : "space-y-1"} role="list">
          {TRACKS.map((tr, i) => {
            const active = i === track;
            const label = `${GENRES[i] ?? "Electronic"} · ${tr.title} by ${tr.artist}`;
            return (
              <li key={tr.title} className="w-full">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  transition={tapSpring}
                  onClick={() => interact({ track: i, t: 0 })}
                  aria-current={active ? "true" : undefined}
                  title={label}
                  aria-label={`Play ${tr.title}`}
                  className={`group flex w-full items-center gap-2.5 rounded-xl text-left transition-colors ${
                    rail ? "h-11 w-11 justify-center p-0" : "px-2 py-1.5"
                  } ${active ? "bg-white/80 shadow-sm" : "hover:bg-white/55"}`}
                >
                  <span
                    className={`relative block shrink-0 overflow-hidden rounded-lg bg-gradient-to-br ${tr.gradient} shadow-sm ${
                      rail ? "h-10 w-10" : "h-9 w-9"
                    } ${active ? "" : "opacity-80"}`}
                    style={active ? { boxShadow: `0 0 0 2px #fff, 0 0 0 3.5px ${acc.hex}` } : undefined}
                  >
                    {active && (
                      <>
                        <span className="absolute inset-0 bg-black/25" />
                        {playing ? (
                          <MiniEq />
                        ) : (
                          <span className="absolute inset-0 grid place-items-center">
                            <Pause className="h-3.5 w-3.5 fill-white text-white" />
                          </span>
                        )}
                      </>
                    )}
                  </span>
                  {!rail && (
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-xs font-medium"
                        style={active ? { color: acc.hex } : undefined}
                      >
                        {tr.title}
                      </span>
                      <span className="block truncate text-[10px] text-stone-400">
                        {GENRES[i] ?? "Electronic"}
                      </span>
                    </span>
                  )}
                  {!rail && (
                    <span className="gd-mono shrink-0 text-[10px] tabular-nums text-stone-400">
                      {fmtTime(tr.dur)}
                    </span>
                  )}
                </motion.button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ---------------- Now playing: scrollable stage + fixed control deck ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="gd-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-4">
            {/* hero */}
            <div className={`flex gap-4 ${heroRow ? "items-end" : "flex-col items-center text-center"}`}>
              <motion.div
                key={track}
                initial={{ scale: 0.92, opacity: 0.4, rotate: -1.5 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 420, damping: 28 }}
                className={`glass-sheen relative shrink-0 rounded-2xl bg-gradient-to-br shadow-lg ${
                  cur.gradient
                } ${heroRow ? (short ? "h-32 w-32" : "h-40 w-40") : "h-36 w-36 max-w-full"}`}
              >
                <Music
                  className={`absolute text-white/25 ${heroRow ? "bottom-3 right-3 h-10 w-10" : "bottom-3 right-3 h-9 w-9"}`}
                  strokeWidth={1.25}
                />
                {playing && (
                  <span className="gd-mono absolute left-3 top-3 rounded-full bg-black/15 px-2 py-0.5 text-[9px] uppercase tracking-wider text-white/90 backdrop-blur-sm">
                    on air
                  </span>
                )}
                {radio.locked && playing && (
                  <button
                    type="button"
                    onClick={radio.unlock}
                    className="absolute inset-0 grid place-items-center rounded-2xl bg-white/55 text-xs font-semibold text-stone-700 backdrop-blur-md"
                  >
                    tap to hear audio
                  </button>
                )}
              </motion.div>

              <div className={`min-w-0 flex-1 ${heroRow ? "pb-1" : "pt-1"}`}>
                <h1 className="truncate text-lg font-semibold tracking-tight text-stone-800">{cur.title}</h1>
                <p className="mt-0.5 truncate text-xs text-stone-500">{cur.artist}</p>
                <div className={`mt-2 flex flex-wrap items-center gap-1.5 ${heroRow ? "" : "justify-center"}`}>
                  <span className="rounded-full border border-white/70 bg-white/60 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-stone-500">
                    {GENRES[track] ?? "Electronic"}
                  </span>
                  <span className="gd-mono rounded-full border border-white/70 bg-white/60 px-2.5 py-0.5 text-[10px] text-stone-500">
                    {cur.bpm} bpm
                  </span>
                </div>
              </div>
            </div>

            {/* visualizer — 24 bars, freezes on pause */}
            <div
              className={`flex items-end gap-[3px] px-1 ${playing ? "" : "gd-vis-idle"} ${
                short ? "h-10" : "h-14"
              }`}
              aria-hidden
            >
              {Array.from({ length: VIS_BARS }, (_, i) => {
                const s = 0.3 + (((track * 37 + i * 53) % 62) / 100);
                const d = 0.72 + (((track + i) % 5) * 0.13);
                const dl = ((i * 83 + track * 17) % 700) / 1000;
                return (
                  <span
                    key={i}
                    className={`gd-vis-bar h-full flex-1 bg-gradient-to-t ${cur.gradient}`}
                    style={{
                      "--gd-s": s.toFixed(2),
                      "--gd-d": `${d.toFixed(2)}s`,
                      "--gd-dl": `-${dl.toFixed(2)}s`,
                    } as CSSProperties}
                  />
                );
              })}
            </div>

            {!short && (
              <p className="px-1 text-[10px] leading-relaxed text-stone-400">
                Synthesized live by the virtual PC — every pad, bass and hat is computed from the shared
                playhead, so both seats hear the same music at the same second.
              </p>
            )}
          </div>
        </div>

        {/* control deck — always visible, pinned to the bottom */}
        <div className="shrink-0 border-t border-white/50 bg-white/30 px-4 pb-4 pt-3 backdrop-blur-sm">
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            {/* transport */}
            <div className="flex items-center justify-center gap-4">
              <motion.button
                type="button"
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.9 }}
                transition={tapSpring}
                onClick={() => interact({ track: (track - 1 + TRACKS.length) % TRACKS.length, t: 0 })}
                aria-label="Previous track"
                title="Previous track"
                className="glass grid h-11 w-11 place-items-center rounded-full text-stone-600 transition-colors hover:text-stone-800"
              >
                <SkipBack className="h-4 w-4 fill-stone-600" />
              </motion.button>
              <motion.button
                type="button"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.88 }}
                transition={tapSpring}
                onClick={() => interact({ playing: !playing })}
                aria-label={playing ? "Pause" : "Play"}
                title={playing ? "Pause" : "Play"}
                className="gd-accent-gradient grid h-14 w-14 place-items-center rounded-full text-white"
                style={{ boxShadow: `0 10px 24px ${acc.hex}55` }}
              >
                {playing ? (
                  <Pause className="h-6 w-6 fill-white" />
                ) : (
                  <Play className="h-6 w-6 translate-x-0.5 fill-white" />
                )}
              </motion.button>
              <motion.button
                type="button"
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.9 }}
                transition={tapSpring}
                onClick={() => interact({ track: (track + 1) % TRACKS.length, t: 0 })}
                aria-label="Next track"
                title="Next track"
                className="glass grid h-11 w-11 place-items-center rounded-full text-stone-600 transition-colors hover:text-stone-800"
              >
                <SkipForward className="h-4 w-4 fill-stone-600" />
              </motion.button>
            </div>

            {/* progress + drive state */}
            <div className="space-y-1">
              <Slider
                value={[shownT]}
                max={cur.dur}
                step={1}
                aria-label="Seek position"
                className="[&_[data-slot=slider-range]]:bg-[linear-gradient(90deg,var(--gd-accent),var(--gd-accent-2))] [&_[data-slot=slider-thumb]]:border-stone-200"
                onValueChange={(v) => setDragT(v[0] ?? 0)}
                onValueCommit={(v) => {
                  setDragT(null);
                  interact({ t: v[0] ?? 0 });
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="gd-mono shrink-0 text-[10px] tabular-nums text-stone-500">{fmtTime(shownT)}</span>
                <span className="gd-mono truncate text-[10px] text-stone-400" title={driveLabel}>
                  {driveLabel}
                </span>
                <span className="gd-mono shrink-0 text-[10px] tabular-nums text-stone-500">
                  −{fmtTime(Math.max(0, cur.dur - shownT))}
                </span>
              </div>
            </div>

            {/* local volume — never synced (own speakers) */}
            <div className="glass flex items-center gap-2.5 rounded-xl px-3 py-2">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-stone-500 transition-colors hover:text-stone-700"
              >
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </button>
              <Slider
                value={[Math.round(volume * 100)]}
                min={0}
                max={100}
                step={1}
                aria-label="Volume"
                className="flex-1 [&_[data-slot=slider-range]]:bg-[linear-gradient(90deg,var(--gd-accent),var(--gd-accent-2))] [&_[data-slot=slider-thumb]]:border-stone-200"
                onValueChange={(v) => setVolume((v[0] ?? 0) / 100)}
              />
              <span className="gd-mono w-8 shrink-0 text-right text-[10px] tabular-nums text-stone-500">
                {Math.round(volume * 100)}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 3 tiny framer-motion equalizer bars — overlay on the active track's tile. */
function MiniEq() {
  const heights = useMemo(() => [0.9, 0.5, 0.72], []);
  return (
    <span className="absolute inset-0 grid place-items-center" aria-hidden>
      <span className="flex h-3.5 items-end gap-[2.5px]">
        {heights.map((h, i) => (
          <motion.span
            key={i}
            className="w-[3px] rounded-full bg-white"
            style={{ height: `${h * 100}%`, transformOrigin: "bottom" }}
            animate={{ scaleY: [0.35, 1, 0.5, 0.85, 0.35] }}
            transition={{ duration: 1.05, repeat: Infinity, ease: "easeInOut", delay: i * 0.16 }}
          />
        ))}
      </span>
    </span>
  );
}
