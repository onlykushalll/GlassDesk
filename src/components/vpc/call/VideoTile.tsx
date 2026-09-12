"use client";

// ============================================================
// GlassDesk — VideoTile: one media surface for the call sidebar.
// Remote tile (aspect-video) + local self-view (small, mirrored).
// Overlays cover the "no frames yet" reality of P2P: waiting,
// connecting, camera-off (derived client-side when the stream has
// zero live video tracks), and call-failed.
// ============================================================

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Clock, Loader2, VideoOff, WifiOff, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type VideoTileState = "waiting" | "connecting" | "live" | "no-media" | "failed";

export interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  state: VideoTileState;
  small?: boolean;
  mirrored?: boolean;
  className?: string;
}

type OverlayState = Exclude<VideoTileState, "live">;

const OVERLAYS: Record<OverlayState, { icon: LucideIcon; text: string; iconClass: string; scrim: string }> = {
  waiting: {
    icon: Clock,
    text: "waiting…",
    iconClass: "animate-pulse text-stone-500",
    scrim: "bg-stone-900/35",
  },
  connecting: {
    icon: Loader2,
    text: "connecting…",
    iconClass: "animate-spin text-teal-600",
    scrim: "bg-stone-900/35",
  },
  "no-media": {
    icon: VideoOff,
    text: "camera off",
    iconClass: "text-stone-500",
    scrim: "bg-stone-900/70",
  },
  failed: {
    icon: WifiOff,
    text: "call failed",
    iconClass: "text-rose-500",
    scrim: "bg-stone-900/50",
  },
};

export default function VideoTile({
  stream,
  label,
  muted = false,
  state,
  small = false,
  mirrored = false,
  className,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // srcObject plumbing — guarded so React re-renders never re-bind the track.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
  }, [stream]);

  const hasVideo = (stream?.getVideoTracks().length ?? 0) > 0;

  // Overlay logic:
  //  • live + frames → clean video, no overlay
  //  • any non-live state → that state's overlay (even if frames arrived early)
  //  • live but zero video tracks → derived "no-media" (camera off)
  let overlay: OverlayState | null = null;
  if (state !== "live") overlay = state;
  else if (!hasVideo) overlay = "no-media";

  const cfg = overlay ? OVERLAYS[overlay] : null;

  return (
    <div
      className={cn(
        "glass relative overflow-hidden rounded-2xl",
        small ? "h-24 aspect-auto" : "aspect-video",
        className
      )}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={cn("h-full w-full bg-stone-950 object-cover", mirrored && "scale-x-[-1]")}
      />
      {cfg && (
        <div className={cn("absolute inset-0 z-10 flex items-center justify-center", cfg.scrim)}>
          <motion.span
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 480, damping: 32 }}
            className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-stone-600"
          >
            <cfg.icon className={cn("size-3.5", cfg.iconClass)} />
            {cfg.text}
          </motion.span>
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 z-20 max-w-[75%] truncate rounded-full bg-black/25 px-2 py-0.5 text-[10px] text-white backdrop-blur">
        {label}
      </span>
    </div>
  );
}
