"use client";

// ============================================================
// GlassDesk — Call sidebar (12-e): an OVERLAY panel for ALL
// sizes — the desktop NEVER reflows when it opens (it used to be
// a permanent w-80 flex column on ≥768px). Source of truth is
// uiStore.callOpen; the entry point is the floating call pill
// (top-right, live status dot), and a live call keeps playing in
// the draggable VideoMini PiP while the panel is closed.
//
// ONE useCall() instance drives everything this tree renders:
//   • the pill (always mounted, hidden while the panel is open —
//     the panel's own X takes over closing)
//   • the slide-in panel (video tiles · controls · Chat/People)
//   • the PiP (only when the panel is closed AND the call is
//     live — the PiP's <video> is the call's ONLY remote-audio
//     owner while the panel is closed; the panel's VideoTile
//     takes the audio back when it opens, and the PiP unmounts,
//     so exactly ONE element ever plays remote audio)
// ============================================================

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CameraOff,
  Crown,
  Loader2,
  MessageCircle,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Users,
  Video,
  VideoOff,
  WifiOff,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { useCall } from "@/lib/vpc/useCall";
import { SPRING } from "@/lib/vpc/motion";
import Chat from "./Chat";
import VideoMini from "./VideoMini";
import VideoTile, { type VideoTileState } from "./VideoTile";

type Tab = "chat" | "people";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

export default function CallSidebar() {
  const call = useCall();
  const peers = useGlassDesk((s) => s.peers);
  const selfId = useGlassDesk((s) => s.selfId);
  const myName = useGlassDesk((s) => s.name);
  const unread = useGlassDesk((s) => s.unread);
  const markChatRead = useGlassDesk((s) => s.markChatRead);
  const connected = useGlassDesk((s) => s.connected);

  const callOpen = useShellUi((s) => s.callOpen);
  const setCallOpen = useShellUi((s) => s.setCallOpen);
  const toggleCall = useShellUi((s) => s.toggleCall);
  // only to pick the panel's anchor (side-by-side with the chat panel
  // on ≥md) — the chat flags themselves stay fully independent
  const chatOpen = useShellUi((s) => s.chatOpen);

  const [tab, setTab] = useState<Tab>("chat");

  // Opening — or simply VIEWING — the chat tab clears the badge. The
  // callOpen gate matters: this component stays mounted (pill + PiP)
  // while the panel is closed, and a closed panel must not eat the
  // unread badge the tray pill shows.
  useEffect(() => {
    if (callOpen && tab === "chat" && unread > 0) markChatRead();
  }, [callOpen, tab, unread, markChatRead]);

  const peerList = useMemo(
    () =>
      Object.values(peers).sort((a, b) =>
        a.host === b.host ? a.name.localeCompare(b.name) : a.host ? -1 : 1
      ),
    [peers]
  );

  // "idle" only happens after endCall / leaving — no media is flowing then.
  const remoteState: VideoTileState = call.status === "idle" ? "no-media" : call.status;
  const localState: VideoTileState = call.camOn ? "live" : "no-media";
  const localLabel = myName ? `${myName} (you)` : "You";

  const dotClass = call.ended
    ? "bg-stone-400"
    : call.status === "live"
      ? "bg-emerald-500"
      : call.status === "failed"
        ? "bg-rose-500"
        : call.status === "waiting" || call.status === "connecting"
          ? "animate-pulse bg-amber-400"
          : "bg-stone-400";

  const dotLabel =
    call.ended || call.status === "idle"
      ? "call ended"
      : call.status === "live"
        ? "call live"
        : call.status === "failed"
          ? "call failed"
          : "connecting…";

  let statusNotice: ReactNode = null;
  if (call.ended) {
    statusNotice = (
      <div className="glass rounded-lg px-3 py-2 text-xs text-stone-600">
        <p className="font-medium">Call ended</p>
        <p className="text-[10px] text-stone-400">Reload the page to restart the call.</p>
      </div>
    );
  } else if (call.status === "waiting") {
    statusNotice = (
      <div className="glass rounded-lg px-3 py-2 text-xs text-stone-500">
        Waiting for your co-pilot to join…
      </div>
    );
  } else if (call.status === "connecting") {
    statusNotice = (
      <div className="glass flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-stone-600">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-teal-600" />
        Connecting P2P…
      </div>
    );
  } else if (call.status === "live") {
    statusNotice = (
      <div className="glass flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-stone-600">
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        Live · peer-to-peer
      </div>
    );
  } else if (call.status === "failed") {
    statusNotice = (
      <div className="glass flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-stone-600">
        <WifiOff className="size-3.5 shrink-0 text-rose-500" />
        Call failed — chat still works
      </div>
    );
  }

  const renderBody = () => (
    <div className="glass-strong flex h-full flex-1 flex-col overflow-hidden rounded-2xl shadow-xl">
      {/* header */}
      <header className="flex flex-none items-center gap-2 border-b border-white/50 px-3 py-2">
        <Phone className="size-4 shrink-0 text-teal-600" />
        <h2 className="shrink-0 text-sm font-semibold tracking-tight">Call</h2>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <span className="glass gd-mono max-w-[92px] truncate rounded-full px-2.5 py-0.5 text-xs text-stone-500">
            {call.peerName ?? "waiting"}
          </span>
          <span className={cn("size-2 shrink-0 rounded-full", dotClass)} aria-hidden />
          {/* the panel is an overlay on every size now — it always
              carries its own close (Esc works too, via SessionView) */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCallOpen(false)}
            aria-label="Close call panel"
            className="size-11 rounded-full text-stone-500 hover:bg-white/50 hover:text-stone-700"
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>

      {/* video tiles + status notices — one flexible region that
          SCROLLS on short viewports instead of crushing the chat tab
          (min-h floors keep both regions usable down to ~500px) */}
      <div className="gd-scroll flex min-h-[120px] flex-col overflow-y-auto">
        {/* video tiles */}
        <div className="space-y-2 p-3">
          <VideoTile
            stream={call.remoteStream}
            label={call.peerName ?? "Co-pilot"}
            state={remoteState}
          />
          <VideoTile
            stream={call.localStream}
            label={localLabel}
            muted
            small
            mirrored
            state={localState}
          />
        </div>

        {/* status + media notices */}
        {(statusNotice !== null || call.mediaError !== null) && (
          <div className="space-y-1.5 px-3 pb-2">
            {statusNotice}
            {call.mediaError !== null && (
              <div
                className="flex items-start gap-2 rounded-lg border border-amber-300/50 px-3 py-2 text-xs text-amber-700 backdrop-blur-md"
                style={{ background: "rgba(245, 158, 11, 0.15)" }}
              >
                <CameraOff className="mt-0.5 size-3.5 shrink-0" />
                <p>{call.mediaError}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* controls */}
      <div className="flex flex-none items-center justify-center gap-2 p-2">
        <Button
          variant="ghost"
          onClick={call.toggleMic}
          aria-label={call.micOn ? "Mute microphone" : "Unmute microphone"}
          className={cn(
            "glass size-11 rounded-full p-0 text-stone-600 hover:bg-white/40 active:scale-95",
            !call.micOn && "text-rose-600 ring-2 ring-rose-400/60"
          )}
          style={!call.micOn ? { background: "rgba(244, 63, 94, 0.16)" } : undefined}
        >
          {call.micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}
        </Button>
        <Button
          variant="ghost"
          onClick={call.toggleCam}
          aria-label={call.camOn ? "Turn camera off" : "Turn camera on"}
          className={cn(
            "glass size-11 rounded-full p-0 text-stone-600 hover:bg-white/40 active:scale-95",
            !call.camOn && "text-rose-600 ring-2 ring-rose-400/60"
          )}
          style={!call.camOn ? { background: "rgba(244, 63, 94, 0.16)" } : undefined}
        >
          {call.camOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}
        </Button>
        <Button
          variant="ghost"
          onClick={call.endCall}
          aria-label="End call"
          className="size-11 rounded-full bg-gradient-to-br from-rose-400 to-rose-600 p-0 text-white shadow-lg shadow-rose-500/30 hover:from-rose-500 hover:text-white hover:to-rose-700 active:scale-95"
        >
          <PhoneOff className="size-5" />
        </Button>
      </div>

      {/* tabs */}
      <nav className="flex-none px-3 pb-2" aria-label="Call sidebar tabs">
        <div className="glass relative flex rounded-full p-1">
          {(["chat", "people"] as const).map((t) => {
            const active = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-pressed={active}
                className="relative flex h-11 flex-1 items-center justify-center rounded-full"
              >
                {active && (
                  <motion.span
                    layoutId="call-tab-pill"
                    transition={{ type: "spring", stiffness: 520, damping: 38 }}
                    className="gd-accent-gradient absolute inset-0 rounded-full shadow-md shadow-teal-500/25"
                  />
                )}
                <span
                  className={cn(
                    "relative z-10 flex items-center gap-1.5 text-xs font-medium",
                    active ? "text-white" : "text-stone-500"
                  )}
                >
                  {t === "chat" ? <MessageCircle className="size-3.5" /> : <Users className="size-3.5" />}
                  {t === "chat" ? "Chat" : "People"}
                  {t === "chat" && unread > 0 && (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-bold text-white">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* tab content — flex-1 with a floor so a short viewport can
          never collapse it to zero (the tiles region scrolls first) */}
      {tab === "chat" ? (
        <div className="flex min-h-[140px] flex-1 flex-col">
          <Chat />
        </div>
      ) : (
        <div className="gd-scroll min-h-[140px] flex-1 space-y-1 overflow-y-auto px-2 py-1">
          {peerList.map((p) => {
            const isSelf = p.id === selfId;
            const online = isSelf ? connected : true;
            return (
              <div key={p.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                <div className="relative shrink-0">
                  <div
                    className={cn(
                      "flex size-9 items-center justify-center rounded-full text-[11px] font-semibold text-white shadow-sm",
                      p.host ? "gd-accent-gradient" : "bg-gradient-to-br from-amber-400 to-rose-400"
                    )}
                  >
                    {initialsOf(p.name)}
                  </div>
                  {p.host && (
                    <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-white shadow-sm">
                      <Crown className="size-2.5 text-amber-500" />
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium text-stone-700">{p.name}</span>
                    {isSelf && <span className="shrink-0 text-[10px] font-medium text-stone-400">(you)</span>}
                  </div>
                  <span className="gd-mono text-[10px] uppercase tracking-wider text-stone-400">{p.seat}</span>
                </div>
                <span
                  title={online ? "connected" : "reconnecting"}
                  className={cn("size-2 shrink-0 rounded-full", online ? "bg-emerald-500" : "animate-pulse bg-amber-400")}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* floating call pill — the panel's entry point, top-right on
          every size. Carries the live status dot; hidden while the
          panel is open (the panel's X owns closing, and the pill
          would sit buried underneath it anyway). While the CHAT panel
          is open it shifts left of it on ≥md so it stays reachable
          (the chat panel is z-92 and would otherwise bury it). */}
      <AnimatePresence>
        {!callOpen && (
          <Tooltip key="call-pill">
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                onClick={toggleCall}
                aria-label="Toggle call panel"
                aria-pressed={callOpen}
                initial={{ opacity: 0, scale: 0.55, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.55, y: -8 }}
                transition={SPRING.snappy}
                whileTap={{ scale: 0.92 }}
                className={cn(
                  "glass-strong fixed top-3 z-[85] grid size-11 place-items-center rounded-full text-stone-600 shadow-lg transition-[right] duration-300 ease-out hover:bg-white/60",
                  chatOpen ? "right-[356px] max-md:right-3" : "right-3"
                )}
              >
                <Video className="size-5" aria-hidden />
                <span
                  className={cn(
                    "absolute top-2 right-2 size-2 rounded-full ring-2 ring-white/80",
                    dotClass
                  )}
                  role="img"
                  aria-label={dotLabel}
                />
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Call panel · {dotLabel}</TooltipContent>
          </Tooltip>
        )}
      </AnimatePresence>

      {/* the panel — a right-side overlay for ALL sizes; the desktop
          layout never reflows (it used to be a permanent w-80 flex
          column on ≥768px). Same slide-in spring the mobile overlay
          always had. When the chat panel is open too, the call panel
          docks to its LEFT on ≥md screens (they'd otherwise cover each
          other — chat is z-92 and would win); below md they stack with
          chat on top, which the z-ladder already encodes. */}
      <AnimatePresence>
        {callOpen && (
          <motion.aside
            key="call-sidebar"
            initial={{ x: 320, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 320, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            role="complementary"
            aria-label="Call panel"
            className={cn(
              "fixed top-3 bottom-20 z-[90] flex w-80 max-w-[calc(100vw-1.5rem)] transition-[right] duration-300 ease-out",
              chatOpen ? "right-[356px] max-md:right-3" : "right-3"
            )}
          >
            {renderBody()}
          </motion.aside>
        )}
      </AnimatePresence>

      {/* PiP — only while the panel is closed AND the call is live.
          It unmounts the instant the panel opens, so exactly ONE
          element ever plays the remote audio (panel tile XOR PiP). */}
      <AnimatePresence>
        {!callOpen && call.status === "live" && (
          <VideoMini key="call-pip" call={call} onExpand={() => setCallOpen(true)} />
        )}
      </AnimatePresence>
    </>
  );
}
