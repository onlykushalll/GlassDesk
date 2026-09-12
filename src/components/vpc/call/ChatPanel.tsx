"use client";

// ============================================================
// GlassDesk — ChatPanel (12-e): the STANDALONE chat surface.
// Independent of the call — chat works with or without a live
// call. Floating right panel in the call sidebar's visual
// language (glass-strong, spring slide from the right), toggled
// from the dock tray (MessageCircle · rose unread dot) or with
// Ctrl/Cmd+Shift+C. The message list is the shared <Chat/> — the
// SAME store messages the in-call tab renders, zero duplication.
// ============================================================

import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGlassDesk, type PeerInfo } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import Chat from "./Chat";

// peers → the co-pilot's name for the header chip (matches how
// useCall resolves the remote peer: first non-self seat)
function peerNameOf(peers: Record<string, PeerInfo>, selfId: string | null): string | null {
  const other = Object.values(peers).find((p) => p.id !== selfId);
  return other?.name ?? null;
}

export default function ChatPanel() {
  const chatOpen = useShellUi((s) => s.chatOpen);
  const setChatOpen = useShellUi((s) => s.setChatOpen);
  const unread = useGlassDesk((s) => s.unread);
  const markChatRead = useGlassDesk((s) => s.markChatRead);
  const peers = useGlassDesk((s) => s.peers);
  const selfId = useGlassDesk((s) => s.selfId);

  // Opening — or simply viewing — the panel always clears the badge
  // (same effect the call sidebar's chat tab runs).
  useEffect(() => {
    if (chatOpen && unread > 0) markChatRead();
  }, [chatOpen, unread, markChatRead]);

  const peerName = peerNameOf(peers, selfId);

  let headerChip: ReactNode = null;
  if (peerName) {
    headerChip = (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="glass gd-mono max-w-[110px] truncate rounded-full px-2.5 py-0.5 text-xs text-stone-500">
            {peerName}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{peerName}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <AnimatePresence>
      {chatOpen && (
        <motion.section
          key="chat-panel"
          initial={{ x: 340, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 340, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 34 }}
          role="complementary"
          aria-label="Chat panel"
          className="glass-strong fixed top-3 right-3 z-[92] flex h-[calc(100dvh-140px)] w-[340px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl shadow-xl"
        >
          <header className="flex items-center gap-2 border-b border-white/50 px-3 py-2">
            <MessageCircle className="size-4 shrink-0 text-teal-600" />
            <h2 className="shrink-0 text-sm font-semibold tracking-tight">Chat</h2>
            {headerChip}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setChatOpen(false)}
              aria-label="Close chat panel"
              className="ml-auto size-11 rounded-full text-stone-500 hover:bg-white/50 hover:text-stone-700"
            >
              <X className="size-4" />
            </Button>
          </header>

          {/* body — the shared Chat (same store messages as the
              in-call tab; Escape closes the panel via SessionView) */}
          <div className="flex min-h-0 flex-1 flex-col">
            <Chat />
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
