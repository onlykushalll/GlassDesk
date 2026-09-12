"use client";

// ============================================================
// GlassDesk — VideoMini (12-e): the picture-in-picture tile that
// keeps a LIVE call present after the call panel is dismissed.
//
//   • The <video> is UNMUTED on purpose: while the panel is closed
//     this tile is the call's ONLY remote-audio owner. The panel's
//     VideoTile takes the audio back the moment it opens — this
//     component unmounts on callOpen, so exactly ONE element ever
//     plays remote audio.
//   • Draggable anywhere in the viewport (no momentum, bounded by
//     a measurement-only overlay that clears the dock). Position
//     persists in a module-level ref — NOT a store, never synced —
//     so a panel open/close round-trip puts the tile back where
//     you left it.
//   • Tap the video body (or PanelRight) to re-open the full panel;
//     post-drag clicks are swallowed so a fling never fires a tap.
// ============================================================

import { useEffect, useRef } from "react";
import { motion, useMotionValue } from "framer-motion";
import { Mic, MicOff, PanelRight, PhoneOff, Video, VideoOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { SPRING } from "@/lib/vpc/motion";
import type { CallApi } from "@/lib/vpc/useCall";

const W = 176; // w-44
const H = 120; // h-[120px]
const MARGIN = 8;
// drag bounds: the viewport minus the dock strip (bottom-20). The
// tile's home anchor (bottom-[84px] right-4) clears the dock top
// (≈68px) with room to breathe.
const BOUNDS_BOTTOM = 80;

// PiP position across mounts — module scope, deliberately NOT a
// store (local-only, no persistence, no sync traffic)
let pipPos: { x: number; y: number } | null = null;

export interface VideoMiniProps {
  call: CallApi;
  onExpand: () => void;
}

export default function VideoMini({ call, onExpand }: VideoMiniProps) {
  const boundsRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const suppressClickRef = useRef(false);
  const x = useMotionValue(pipPos?.x ?? 0);
  const y = useMotionValue(pipPos?.y ?? 0);

  // srcObject plumbing — guarded so re-renders never re-bind the track
  // (same pattern as VideoTile)
  useEffect(() => {
    const el = videoRef.current;
    if (!el || el.srcObject === call.remoteStream) return;
    el.srcObject = call.remoteStream;
  }, [call.remoteStream]);

  // Viewport heal: clamp the persisted offset on mount + resize so the
  // tile can never end up off-screen after the window shrinks. The drag
  // itself is bounded by boundsRef (measured live at gesture start).
  useEffect(() => {
    const clamp = (): void => {
      const minX = -(window.innerWidth - W - MARGIN * 2);
      const minY = -(window.innerHeight - BOUNDS_BOTTOM - H - MARGIN);
      x.set(Math.min(0, Math.max(minX, x.get())));
      y.set(Math.min(0, Math.max(minY, y.get())));
      pipPos = { x: x.get(), y: y.get() };
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [x, y]);

  // Persist on unmount too (e.g. expanding the panel remounts later)
  useEffect(() => {
    return () => {
      pipPos = { x: x.get(), y: y.get() };
    };
  }, [x, y]);

  const persist = (): void => {
    pipPos = { x: x.get(), y: y.get() };
  };

  // camera-off derivation (same rule as VideoTile): a live stream
  // with zero video tracks renders the peer's initials instead
  const noVideo = (call.remoteStream?.getVideoTracks().length ?? 0) === 0;

  const pillBtn =
    "grid size-8 place-items-center rounded-full text-stone-600 transition-colors hover:bg-white/70 active:scale-90";

  return (
    <>
      {/* measurement-only drag bounds: the viewport above the dock.
          Invisible, untouchable — framer measures its box per gesture. */}
      <div
        ref={boundsRef}
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 bottom-20"
      />

      <motion.div
        drag
        dragConstraints={boundsRef}
        dragMomentum={false}
        style={{ x, y }}
        initial={{ opacity: 0, scale: 0.88 }}
        animate={{ opacity: 1, scale: 1, transition: SPRING.snappy }}
        exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.12 } }}
        onDragStart={() => {
          suppressClickRef.current = true;
        }}
        onDragEnd={() => {
          persist();
          // the browser may still dispatch one synthetic click after a
          // drag — let it hit the capture guard below, then re-arm
          window.setTimeout(() => {
            suppressClickRef.current = false;
          }, 120);
        }}
        onClickCapture={(e) => {
          if (suppressClickRef.current) {
            e.preventDefault();
            e.stopPropagation();
            suppressClickRef.current = false;
          }
        }}
        role="region"
        aria-label={`Call picture-in-picture — ${call.peerName ?? "peer"}`}
        className="glass-strong fixed bottom-[84px] right-4 z-[85] flex h-[120px] w-44 cursor-grab touch-none flex-col overflow-hidden rounded-2xl shadow-2xl active:cursor-grabbing"
      >
        {/* video body — tap to re-open the full call panel */}
        <div
          role="button"
          tabIndex={0}
          onClick={onExpand}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onExpand();
            }
          }}
          aria-label={`Show call panel — ${call.peerName ?? "peer"}`}
          className="relative min-h-0 flex-1 cursor-pointer overflow-hidden"
        >
          {/* UNMUTED — this tile owns the remote audio while the panel
              is closed (it unmounts when the panel opens) */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="h-full w-full bg-stone-950 object-cover"
          />
          {/* camera-off: no live video tracks → the peer's face stands
              in for the feed (same derivation VideoTile uses) */}
          {noVideo && (
            <div className="absolute inset-0 flex items-center justify-center bg-stone-900/70">
              <span className="grid size-10 place-items-center rounded-full bg-gradient-to-br from-amber-400 to-rose-400 text-sm font-semibold text-white shadow-md">
                {(call.peerName ?? "C").trim().charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <span className="absolute left-1.5 top-1.5 flex max-w-[70%] items-center gap-1 rounded-full bg-black/30 px-2 py-0.5 text-[10px] text-white backdrop-blur">
            <span className="size-1 shrink-0 rounded-full bg-emerald-400" aria-hidden />
            <span className="truncate">{call.peerName ?? "Co-pilot"}</span>
          </span>
        </div>

        {/* compact control row */}
        <div
          className="flex h-10 shrink-0 select-none items-center justify-center gap-1 border-t border-white/50 bg-white/30"
          role="toolbar"
          aria-label="Call controls"
        >
          <button
            type="button"
            onClick={call.toggleMic}
            aria-label={call.micOn ? "Mute microphone" : "Unmute microphone"}
            aria-pressed={!call.micOn}
            className={cn(
              pillBtn,
              !call.micOn && "bg-rose-400/20 text-rose-600 ring-1 ring-rose-400/50"
            )}
          >
            {call.micOn ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={call.toggleCam}
            aria-label={call.camOn ? "Turn camera off" : "Turn camera on"}
            aria-pressed={!call.camOn}
            className={cn(
              pillBtn,
              !call.camOn && "bg-rose-400/20 text-rose-600 ring-1 ring-rose-400/50"
            )}
          >
            {call.camOn ? <Video className="size-3.5" /> : <VideoOff className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onExpand}
            aria-label="Open call panel"
            className={pillBtn}
          >
            <PanelRight className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={call.endCall}
            aria-label="End call"
            className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-rose-400 to-rose-600 text-white shadow-md shadow-rose-500/30 transition-transform hover:from-rose-500 active:scale-90"
          >
            <PhoneOff className="size-3.5" />
          </button>
        </div>
      </motion.div>
    </>
  );
}
