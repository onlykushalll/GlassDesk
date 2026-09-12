"use client";

// ============================================================
// GlassDesk — YouTube watch-party theater (Nova's yt:<id> page).
// Real IFrame-API player + co-control sync stored in the shared
// browser payload: ytPlaying / ytT (seconds) / ytAt (epoch ms) /
// ytBy / ytByName. Whoever last touches playback becomes the
// controller and publishes the playhead at 2 Hz; the other seat
// corrects on drift > 1.2 s. A 1.5 s programmatic guard suppresses
// event echoes so control hand-offs stay clean. All state lives in
// the payload, so sync survives reloads and rejoins.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, Film, Link2, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGlassDesk } from "@/lib/vpc/store";
import type { WindowState } from "@/lib/vpc/types";

// ---------- minimal strict-TS typings for the YouTube IFrame API ----------

interface YTPlayerInstance {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
  getIframe?(): HTMLIFrameElement;
}
interface YTPlayerEvent {
  data: number;
  target: YTPlayerInstance;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId?: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayerInstance }) => void;
        onStateChange?: (e: YTPlayerEvent) => void;
        onError?: (e: YTPlayerEvent) => void;
      };
    },
  ) => YTPlayerInstance;
}
type YTGlobal = { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void };

const STATE_ENDED = 0;
const STATE_PLAYING = 1;
const STATE_PAUSED = 2;
const STATE_BUFFERING = 3;

const PUBLISH_MS = 500; // controller publishes the playhead at 2 Hz
const GUARD_MS = 1500; // programmatic echo suppression window
const DRIFT_S = 1.2; // follower corrects beyond this
const SEEK_JUMP_S = 1.5; // poll-to-poll jump means a user seek
const APPLY_DRIFT_S = 1.2; // follower seek threshold on payload change
const API_TIMEOUT_MS = 12000;

// ---------- one-time iframe_api loader (module level) ----------

let ytApiPromise: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (!ytApiPromise) {
    ytApiPromise = new Promise<YTNamespace>((resolve, reject) => {
      const w = window as unknown as YTGlobal;
      if (w.YT && w.YT.Player) {
        resolve(w.YT);
        return;
      }
      const prev = w.onYouTubeIframeAPIReady;
      w.onYouTubeIframeAPIReady = () => {
        if (prev) prev();
        if (w.YT && w.YT.Player) resolve(w.YT);
        else reject(new Error("api missing"));
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => reject(new Error("script blocked"));
      document.head.appendChild(script);
      window.setTimeout(() => {
        if (!(w.YT && w.YT.Player)) reject(new Error("timeout"));
      }, API_TIMEOUT_MS);
    });
    // a failed load must stay retryable
    ytApiPromise.catch(() => {
      ytApiPromise = null;
    });
  }
  return ytApiPromise;
}

// ---------- the theater ----------

interface YtPayload {
  ytPlaying?: boolean;
  ytT?: number;
  ytAt?: number;
  ytBy?: string;
  ytByName?: string;
}

export default function YTTheater({
  win,
  videoId,
  onBack,
}: {
  win: WindowState;
  videoId: string;
  onBack: () => void;
}) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const selfId = useGlassDesk((s) => s.selfId);
  const myName = useGlassDesk((s) => s.name);

  const [apiError, setApiError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false); // autoplay blocked → join overlay
  const [correcting, setCorrecting] = useState(false);

  const y = win.payload as unknown as YtPayload;

  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const readyRef = useRef(false);
  const guardUntilRef = useRef(0);
  const lastObservedTRef = useRef<number | null>(null);

  // ---- shared helpers — always read the freshest store payload ----

  const readPayload = useCallback((): YtPayload => {
    const st = useGlassDesk.getState().state;
    const w = st?.windows.find((x) => x.id === win.id);
    return (w?.payload ?? {}) as unknown as YtPayload;
  }, [win.id]);

  const patchYt = useCallback(
    (patch: YtPayload) => {
      dispatch({ t: "app:patch", id: win.id, patch: patch as unknown as Record<string, unknown> });
    },
    [dispatch, win.id],
  );

  const takeControl = useCallback(
    (playing: boolean, t: number) => {
      if (!selfId) return;
      patchYt({ ytPlaying: playing, ytT: t, ytAt: Date.now(), ytBy: selfId, ytByName: myName });
    },
    [patchYt, selfId, myName],
  );

  const withinGuard = useCallback(() => Date.now() < guardUntilRef.current, []);
  const setGuard = useCallback(() => {
    guardUntilRef.current = Date.now() + GUARD_MS;
  }, []);

  const playerTime = useCallback((): number | null => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return null;
    try {
      return p.getCurrentTime();
    } catch {
      return null;
    }
  }, []);

  const playerStateNum = useCallback((): number => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return -1;
    try {
      return p.getPlayerState();
    } catch {
      return -1;
    }
  }, []);

  const playerIsPlaying = useCallback(
    () => playerStateNum() === STATE_PLAYING || playerStateNum() === STATE_BUFFERING,
    [playerStateNum],
  );

  const expectedOf = useCallback((pl: YtPayload): number | null => {
    if (typeof pl.ytT !== "number") return null;
    if (pl.ytPlaying !== true) return Math.max(0, pl.ytT); // paused → playhead is frozen
    const at = typeof pl.ytAt === "number" ? pl.ytAt : Date.now();
    return Math.max(0, pl.ytT + (Date.now() - at) / 1000);
  }, []);

  /** Push the shared playhead into our player (seek + play-state). */
  const applyRemote = useCallback(
    (restore: boolean) => {
      const p = playerRef.current;
      if (!p || !readyRef.current) return;
      const pl = readPayload();
      if (!restore && (!pl.ytBy || pl.ytBy === selfId)) return; // own publish or no controller
      const expected = expectedOf(pl);
      if (expected === null) return;
      const cur = playerTime();
      const wantPlay = pl.ytPlaying === true;
      const needSeek = cur === null || Math.abs(cur - expected) > APPLY_DRIFT_S;
      const needToggle = wantPlay !== playerIsPlaying();
      if (!needSeek && !needToggle) return; // steady state: no guard → local input stays free
      setGuard();
      if (needSeek) p.seekTo(expected, true);
      if (wantPlay) p.playVideo();
      else p.pauseVideo();
      // no setState here — the 2Hz interval derives `correcting` from live
      // drift, which keeps this effect purely external-system (player API)
    },
    [expectedOf, playerIsPlaying, playerTime, readPayload, selfId],
  );

  const handleStateChange = useCallback(
    (state: number) => {
      if (withinGuard()) return; // echo of our own programmatic change
      if (state !== STATE_PLAYING && state !== STATE_PAUSED && state !== STATE_ENDED) return;
      const t = playerTime();
      if (t === null) return;
      takeControl(state === STATE_PLAYING, Math.max(0, t));
    },
    [playerTime, takeControl, withinGuard],
  );

  // ---- player lifecycle (keyed by videoId / retryKey) ----

  useEffect(() => {
    let cancelled = false;
    readyRef.current = false;
    lastObservedTRef.current = null;

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !mountRef.current) return;
        setPlayerError(null);
        setPlayerReady(false);
        // YT replaces this host node with an iframe — create a fresh one
        // each run and clear the mount on cleanup (re-mount safe)
        const host = document.createElement("div");
        mountRef.current.replaceChildren(host);
        const player = new YT.Player(host, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: (e) => {
              if (cancelled) return;
              readyRef.current = true;
              playerRef.current = e.target;
              const frame = e.target.getIframe?.();
              if (frame) {
                frame.style.position = "absolute";
                frame.style.inset = "0";
                frame.style.width = "100%";
                frame.style.height = "100%";
                frame.style.border = "0";
              }
              setPlayerReady(true);
              lastObservedTRef.current = playerTime();
              applyRemote(true); // restore the shared playhead (rejoin)
            },
            onStateChange: (e) => {
              if (cancelled) return;
              handleStateChange(e.data);
            },
            onError: () => {
              if (cancelled) return;
              setPlayerError("YouTube refused this video — it may be private, deleted or region-blocked.");
            },
          },
        });
        playerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) setApiError(true);
      });

    return () => {
      cancelled = true;
      readyRef.current = false;
      const p = playerRef.current;
      playerRef.current = null;
      try {
        p?.destroy();
      } catch {
        // iframe already gone (strict-mode double mount etc.)
      }
      mountRef.current?.replaceChildren();
    };
  }, [videoId, retryKey, applyRemote, handleStateChange, playerTime]);

  // ---- 2 Hz loop: publish / detect user seeks / chip state ----

  useEffect(() => {
    const iv = window.setInterval(() => {
      const cur = playerTime();
      if (cur === null) return;
      const pl = readPayload();
      const st = playerStateNum();

      // autoplay blocked: shared playback is rolling but not here
      const nextBlocked = pl.ytPlaying === true && readyRef.current && st !== STATE_PLAYING && st !== STATE_BUFFERING;
      setBlocked((b) => (b === nextBlocked ? b : nextBlocked));

      // a jump between polls outside the guard = a local seek → take control
      const prev = lastObservedTRef.current;
      if (prev !== null && Math.abs(cur - prev) > SEEK_JUMP_S && !withinGuard()) {
        takeControl(playerIsPlaying(), Math.max(0, cur));
        lastObservedTRef.current = cur;
        return;
      }
      lastObservedTRef.current = cur;

      // the controller publishes the playhead while playing
      if (pl.ytBy === selfId && pl.ytPlaying === true) {
        patchYt({ ytT: cur, ytAt: Date.now() });
      }

      // chip: amber while off the shared playhead
      if (pl.ytBy && pl.ytBy !== selfId && typeof pl.ytT === "number") {
        const expected = expectedOf(pl) ?? 0;
        const desynced = Math.abs(cur - expected) > DRIFT_S || playerIsPlaying() !== (pl.ytPlaying === true);
        setCorrecting((c) => (c === desynced ? c : desynced));
      } else {
        setCorrecting((c) => (c ? false : c));
      }
    }, PUBLISH_MS);
    return () => window.clearInterval(iv);
  }, [expectedOf, patchYt, playerIsPlaying, playerStateNum, playerTime, readPayload, selfId, takeControl, withinGuard]);

  // ---- follower: apply payload changes to our player ----

  useEffect(() => {
    applyRemote(false);
  }, [applyRemote, y.ytBy, y.ytT, y.ytAt, y.ytPlaying]);

  // ---- actions ----

  const joinPlayback = useCallback(() => {
    const p = playerRef.current;
    if (!p || !readyRef.current) return;
    const expected = expectedOf(readPayload()) ?? 0;
    setGuard();
    p.seekTo(expected, true);
    p.playVideo(); // inside a user gesture → autoplay is allowed
    setBlocked(false);
  }, [expectedOf, readPayload, setGuard]);

  const retryLoad = useCallback(() => {
    setApiError(false);
    setRetryKey((k) => k + 1);
  }, []);

  const copyLink = useCallback(() => {
    try {
      void navigator.clipboard?.writeText(`https://youtu.be/${videoId}`);
    } catch {
      // clipboard unavailable — nothing to do
    }
  }, [videoId]);

  // ---- render ----

  const controllerLabel =
    y.ytBy && y.ytBy === selfId
      ? "controlled by you"
      : typeof y.ytByName === "string" && y.ytByName
        ? `controlled by ${y.ytByName}`
        : "nobody driving — press play";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-white/50 bg-white/30 px-2 py-1.5">
        <Button variant="ghost" size="icon" onClick={onBack} title="Back to Nova" className="h-9 w-9 shrink-0">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="flex h-6 w-9 shrink-0 items-center justify-center rounded-md bg-red-500 shadow-sm" title="YouTube">
          <Play className="h-3 w-3 fill-white text-white" />
        </span>
        <span className="shrink-0 text-sm font-semibold tracking-tight">YouTube</span>
        <span
          title="Watch-party sync"
          className={`gd-mono ml-auto inline-flex min-w-0 items-center gap-1.5 truncate rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-wide ${
            correcting
              ? "border-amber-500/30 bg-amber-500/10 text-amber-600"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
          }`}
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
          <span className="truncate">watching together · {controllerLabel}</span>
        </span>
      </header>

      <div className="gd-scroll min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-3xl space-y-3">
          {/* player */}
          <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-stone-900/5">
            <div ref={mountRef} className="absolute inset-0" />

            {!playerReady && !apiError && !playerError && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/80 border-t-transparent shadow-sm" />
              </div>
            )}

            {blocked && !playerError && !apiError && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/50 backdrop-blur-md">
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={joinPlayback}
                  className="gd-accent-gradient flex h-12 items-center gap-2 rounded-full px-6 text-sm font-semibold text-white shadow-lg"
                >
                  <Play className="h-4 w-4 fill-white" />
                  Tap to join playback
                </motion.button>
                <p className="max-w-xs text-center text-xs text-stone-500">
                  autoplay is blocked — one tap syncs you to the shared playhead
                </p>
              </div>
            )}

            {playerError && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 p-4 backdrop-blur-md">
                <div className="glass max-w-sm rounded-2xl p-5 text-center">
                  <Film className="mx-auto h-7 w-7 text-stone-400" />
                  <p className="mt-2 text-sm font-medium">{playerError}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={onBack}>
                    <ChevronLeft className="h-3.5 w-3.5" /> Try another link
                  </Button>
                </div>
              </div>
            )}

            {apiError && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 p-4 backdrop-blur-md">
                <div className="glass max-w-sm rounded-2xl p-5 text-center">
                  <Film className="mx-auto h-7 w-7 text-stone-400" />
                  <p className="mt-2 text-sm font-medium">YouTube player failed to load</p>
                  <p className="mt-1 text-xs text-stone-500">the virtual PC&apos;s network may be blocked</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={retryLoad}>
                    <RotateCcw className="h-3.5 w-3.5" /> Retry
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* co-control explainer */}
          <div className="glass flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5">
            <span className="gd-mono shrink-0 rounded-md bg-white/70 px-2 py-1 text-[10px] text-stone-600">
              youtu.be/{videoId}
            </span>
            <p className="min-w-[10rem] flex-1 text-xs text-stone-500">
              Both seats co-control playback — play, pause and seek from either side; the last touch drives the
              shared playhead.
            </p>
            <Button variant="outline" size="sm" onClick={copyLink} className="shrink-0">
              <Link2 className="h-3.5 w-3.5" /> Copy link
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
