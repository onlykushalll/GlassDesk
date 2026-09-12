"use client";

// ============================================================
// GlassDesk — call chat. Messages live in the shared DesktopState
// (state.chat), so they ride the snapshot and survive reloads.
// Own bubbles right (teal→emerald gradient), peer bubbles left
// (frosted white + initial avatar). Day dividers between
// different local days. Auto-scroll sticks to the bottom unless
// the reader scrolled up — then a "New messages" pill pins
// instead. Rendered by BOTH the call sidebar's chat tab and the
// standalone ChatPanel — same store messages, zero duplication.
// ============================================================

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { ArrowDown, MessageCircle, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGlassDesk } from "@/lib/vpc/store";
import type { ChatMessage } from "@/lib/vpc/types";

const NO_CHAT: ChatMessage[] = [];
const NAME_GAP_MS = 3 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;
const MAX_LEN = 500;

function fmtTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// local-day key (not UTC — dividers must match what the reader sees)
function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const diffDays = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Centered hairline divider between messages from different days. */
function DayDivider({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-2 py-1.5">
      <span className="h-px flex-1 rounded-full bg-stone-300/70" aria-hidden />
      <span className="text-[10px] font-medium tracking-wide text-stone-400">{label}</span>
      <span className="h-px flex-1 rounded-full bg-stone-300/70" aria-hidden />
    </div>
  );
}

function MessageBubble({
  msg,
  own,
  showName,
  isLast,
}: {
  msg: ChatMessage;
  own: boolean;
  showName: boolean;
  isLast: boolean;
}) {
  return (
    <motion.div
      initial={isLast ? { opacity: 0, y: 10, scale: 0.96 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 520, damping: 34 }}
      className={cn("flex items-start", own ? "justify-end" : "justify-start gap-1.5")}
    >
      {/* peer face — initial avatar on the run head; invisible spacer
          keeps the run's bubbles aligned (Slack-style grouping) */}
      {!own && (
        <span
          aria-hidden
          className={cn(
            "mt-0.5 grid size-6 shrink-0 select-none place-items-center rounded-full bg-gradient-to-br from-amber-400 to-rose-400 text-[10px] font-semibold text-white shadow-sm",
            !showName && "invisible"
          )}
        >
          {(msg.from.trim().charAt(0) || "?").toUpperCase()}
        </span>
      )}
      <div className="flex max-w-[85%] flex-col">
        {!own && showName && (
          <span className="mb-0.5 ml-1 text-[10px] font-medium text-stone-400">{msg.from}</span>
        )}
        <div
          className={cn(
            "px-3 py-1.5 text-sm",
            own
              ? "gd-accent-gradient rounded-2xl rounded-br-md text-white shadow-sm shadow-teal-500/20"
              : "rounded-2xl rounded-bl-md border border-white/60 bg-white/80 text-stone-700"
          )}
        >
          <p className="whitespace-pre-wrap break-words">{msg.text}</p>
          <span
            className={cn(
              "mt-0.5 block text-right text-[9px] leading-none",
              own ? "text-white/70" : "text-stone-400"
            )}
          >
            {fmtTime(msg.at)}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

export default function Chat() {
  const messages = useGlassDesk((s) => s.state?.chat ?? NO_CHAT);
  const selfId = useGlassDesk((s) => s.selfId);
  const sendChat = useGlassDesk((s) => s.sendChat);
  const sendTyping = useGlassDesk((s) => s.sendTyping);
  const peerTyping = useGlassDesk((s) => s.peerTyping);

  const [text, setText] = useState("");
  // "new messages" pill is fully DERIVED: nearBottom + the last message
  // id the reader has caught up to (both advance from event handlers only)
  const [nearBottom, setNearBottom] = useState(true);
  const [seenLastId, setSeenLastId] = useState<string>("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const firstRunRef = useRef(true);

  // typing indicator expiry — a 500ms tick while a peer is typing
  const [tick, setTick] = useState(0);
  const typingFresh = peerTyping !== null && Date.now() - peerTyping.at < 1600;
  useEffect(() => {
    if (!typingFresh) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [typingFresh, peerTyping?.at]);
  void tick;

  const lastId = messages.length > 0 ? messages[messages.length - 1].id : "";
  const showPill = !nearBottom && seenLastId !== lastId && messages.length > 0;

  // Stick to the bottom on new messages — only if the reader is near it.
  // DOM-only effect (no setState): the pill state advances via events.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (firstRunRef.current || nearBottom) {
      firstRunRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [lastId, nearBottom]);

  const handleScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    setNearBottom(near);
    if (near) setSeenLastId(lastId);
  };

  const scrollToBottom = (): void => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNearBottom(true);
    setSeenLastId(lastId);
  };

  const handleTextChange = (value: string): void => {
    setText(value.slice(0, MAX_LEN));
    if (value.trim().length > 0) sendTyping();
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const clean = text.trim().slice(0, MAX_LEN);
    if (!clean) return;
    sendChat(clean);
    setText("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={handleScroll}
          className="gd-scroll h-full space-y-2 overflow-y-auto px-3 py-2"
        >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <MessageCircle className="size-8 text-stone-300" />
              <p className="text-xs text-stone-400">
                Say hi — messages live in the snapshot and survive reloads.
              </p>
            </div>
          ) : (
            messages.map((m, i) => {
              const own = m.fromId === selfId;
              const prev = i > 0 ? messages[i - 1] : null;
              const showName =
                !own && (prev === null || prev.fromId !== m.fromId || m.at - prev.at > NAME_GAP_MS);
              const newDay = prev === null || dayKey(prev.at) !== dayKey(m.at);
              return (
                <Fragment key={m.id}>
                  {newDay && <DayDivider label={dayLabel(m.at)} />}
                  <MessageBubble
                    msg={m}
                    own={own}
                    showName={showName}
                    isLast={i === messages.length - 1}
                  />
                </Fragment>
              );
            })
          )}
        </div>
        {showPill && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="glass absolute bottom-2 left-1/2 z-10 flex min-h-8 -translate-x-1/2 items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-medium text-stone-600 shadow-md"
          >
            New messages
            <ArrowDown className="size-3" />
          </button>
        )}
        {/* peer typing indicator — driven by the ephemeral typing channel */}
        {typingFresh && peerTyping && (
          <div className="pointer-events-none absolute bottom-2 left-3 z-10 flex items-center gap-1.5 rounded-full bg-white/85 px-2.5 py-1 text-[11px] text-stone-500 shadow-sm backdrop-blur-sm">
            <span className="flex items-end gap-[2px]" aria-hidden>
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="size-1 rounded-full bg-stone-400"
                  animate={{ y: [0, -2.5, 0] }}
                  transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.12, ease: "easeInOut" }}
                />
              ))}
            </span>
            {peerTyping.name} is typing…
          </div>
        )}
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-white/50 p-2">
        <Input
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          placeholder="Message…"
          maxLength={MAX_LEN}
          aria-label="Chat message"
          className="h-10 flex-1 rounded-xl border-white/70 bg-white/70 text-sm focus-visible:border-teal-400/70 focus-visible:ring-teal-400/25"
        />
        <Button
          type="submit"
          size="icon"
          disabled={!text.trim()}
          aria-label="Send message"
          className="gd-accent-gradient size-10 shrink-0 rounded-xl text-white shadow-md shadow-teal-500/25 hover:opacity-90 hover:text-white disabled:opacity-40"
        >
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}
