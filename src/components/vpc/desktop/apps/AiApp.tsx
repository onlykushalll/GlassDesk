"use client";

// ============================================================
// GlassDesk — Glass AI: the OS assistant, macOS-Siri /
// Windows-Copilot style but real. Runs in its own window and
// its conversation lives in the window PAYLOAD, so both seats
// see the exact same thread live (one shared brain).
//
//  • payload contract (seeded by Dock DEFAULT_PAYLOADS):
//      { thread: AiMsg[], busy: boolean, draft: string }
//    every change goes through app:patch (top-level shallow
//    merge — arrays are replaced WHOLE).
//  • perf: the composer keeps its draft in LOCAL state —
//    keystrokes re-render only the composer, never the thread.
//    ThreadView/Composer are memo()ed; thread array identity
//    only changes when a message actually lands.
//  • motion: springs only, transform/opacity only.
// ============================================================

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { ArrowUp, RotateCcw, Sparkles } from "lucide-react";
import { SPRING, pop, riseIn, stagger } from "@/lib/vpc/motion";
import { pushToast } from "@/lib/vpc/toast";
import { useGlassDesk } from "@/lib/vpc/store";
import type { WindowState } from "@/lib/vpc/types";

// ---------------- payload contract ----------------

interface AiMsg {
  role: "user" | "ai";
  text: string;
  at: number;
  by?: string;
  err?: boolean;
}
interface P {
  thread: AiMsg[];
  busy: boolean;
  draft: string;
}

const THREAD_CAP = 100;
const ASK_WINDOW = 12; // messages sent to the model
const EMPTY_THREAD: AiMsg[] = [];

const SUGGESTIONS = [
  "What can this PC do?",
  "Explain WebRTC like I'm five",
  "Write a haiku about glass",
  "Fun things to do here with a friend?",
];

/** Suggested-prompt chips: pop in staggered, springy hover/tap. */
const chipV: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.92 },
  show: { opacity: 1, y: 0, scale: 1, transition: SPRING.playful },
  hover: { scale: 1.05, y: -1, transition: SPRING.snappy },
  tap: { scale: 0.95, transition: SPRING.snappy },
};

// live reads (never stale across awaits) — same pattern as WeatherApp
function readThread(winId: string): AiMsg[] {
  const st = useGlassDesk.getState().state;
  const w = st?.windows.find((x) => x.id === winId);
  const p = (w?.payload ?? {}) as Partial<P>;
  return Array.isArray(p.thread) ? (p.thread as AiMsg[]) : EMPTY_THREAD;
}
function isBusy(winId: string): boolean {
  const st = useGlassDesk.getState().state;
  const w = st?.windows.find((x) => x.id === winId);
  return (w?.payload as Partial<P> | undefined)?.busy === true;
}

function fmtTime(at: number): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ============================================================
// main component
// ============================================================

export default function AiApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const name = useGlassDesk((s) => s.name);
  const seat = useGlassDesk((s) => s.seat);

  const p = win.payload as unknown as P;
  const thread = Array.isArray(p.thread) ? p.thread : EMPTY_THREAD;
  const busy = p.busy === true;

  // bumped when a suggested prompt fires from the thread area →
  // the Composer wipes its LOCAL draft (render-time adjust pattern)
  const [flushKey, setFlushKey] = useState(0);

  const patch = useCallback(
    (o: Partial<P>) => dispatch({ t: "app:patch", id: win.id, patch: o }),
    [dispatch, win.id],
  );

  /** POST the last turns, then land the reply (or an error bubble) in the
   *  shared thread. Reads the LIVE thread before appending so a message
   *  a co-seat added while we awaited is never clobbered. */
  const runCompletion = useCallback(
    async (base: AiMsg[]) => {
      const messages = base
        .filter((m) => !m.err)
        .slice(-ASK_WINDOW)
        .map((m) => ({
          role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
          content: m.text,
        }));
      try {
        const res = await fetch("/api/vpc/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages }),
          signal: AbortSignal.timeout(60_000),
        });
        const j = (await res.json().catch(() => null)) as { reply?: string } | null;
        const reply = typeof j?.reply === "string" ? j.reply.trim() : "";
        if (!res.ok || !reply) throw new Error("no_reply");
        const aiMsg: AiMsg = { role: "ai", text: reply, at: Date.now() };
        patch({
          thread: [...readThread(win.id), aiMsg].slice(-THREAD_CAP),
          busy: false,
        });
      } catch {
        const errMsg: AiMsg = {
          role: "ai",
          text: "That reply didn't make it through — the model service didn't answer. Tap retry and I'll take another swing.",
          at: Date.now(),
          err: true,
        };
        patch({
          thread: [...readThread(win.id), errMsg].slice(-THREAD_CAP),
          busy: false,
        });
        pushToast({
          title: "Glass AI hiccup",
          body: "The model didn't reply — retry from the rose bubble.",
          kind: "warn",
        });
      }
    },
    [patch, win.id],
  );

  /** Send: append the user's message, flip busy ON (both seats see the
   *  typing indicator), then ask the model. */
  const send = useCallback(
    (text: string) => {
      const clean = text.trim().slice(0, 2000);
      if (!clean || isBusy(win.id)) return;
      const userMsg: AiMsg = { role: "user", text: clean, at: Date.now(), by: name || "you" };
      const next = [...readThread(win.id), userMsg].slice(-THREAD_CAP);
      patch({ thread: next, busy: true, draft: "" });
      void runCompletion(next);
    },
    [name, patch, runCompletion, win.id],
  );

  const handleSuggest = useCallback(
    (text: string) => {
      setFlushKey((k) => k + 1); // fill + send → clear the composer
      send(text);
    },
    [send],
  );

  /** Retry: drop the trailing error bubble(s), re-ask the last user turn. */
  const retry = useCallback(() => {
    if (isBusy(win.id)) return;
    const live = readThread(win.id);
    let cut = live.length;
    while (cut > 0 && live[cut - 1].err === true) cut--;
    if (cut === 0 || live[cut - 1].role !== "user") return;
    const base = live.slice(0, cut);
    patch({ thread: base, busy: true });
    void runCompletion(base);
  }, [patch, runCompletion, win.id]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ---------------- header strip ---------------- */}
      <header className="shrink-0 border-b border-white/70 bg-white/35 px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <motion.div
            variants={pop}
            initial="rest"
            animate="rest"
            whileHover="hover"
            whileTap="tap"
            className="gd-accent-gradient grid h-9 w-9 shrink-0 place-items-center rounded-xl shadow-sm shadow-teal-600/30"
            aria-hidden
          >
            <Sparkles className="h-4 w-4 text-white" />
          </motion.div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold leading-tight text-stone-800">Glass AI</h2>
            <p className="text-[10px] leading-tight text-stone-400">the PC&apos;s built-in assistant</p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-teal-200/70 bg-teal-50/70 px-2.5 py-1 text-[10px] font-medium text-teal-700">
            <motion.span
              className="h-1.5 w-1.5 rounded-full bg-emerald-500"
              animate={{ opacity: [1, 0.35, 1] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
              aria-hidden
            />
            on-machine · shared thread
          </span>
        </div>
      </header>

      {/* ---------------- shared thread ---------------- */}
      <ThreadView
        thread={thread}
        busy={busy}
        myName={name}
        seat={seat}
        onSuggest={handleSuggest}
        onRetry={retry}
      />

      {/* ---------------- composer ---------------- */}
      <Composer busy={busy} flushKey={flushKey} onSend={send} />
    </div>
  );
}

// ============================================================
// thread (memoized — payload identity only changes on messages)
// ============================================================

const ThreadView = memo(function ThreadView({
  thread,
  busy,
  myName,
  seat,
  onSuggest,
  onRetry,
}: {
  thread: AiMsg[];
  busy: boolean;
  myName: string;
  seat: "host" | "guest" | null;
  onSuggest: (text: string) => void;
  onRetry: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // stick to the newest turn — rAF so the bubble lays out first
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight });
    });
    return () => cancelAnimationFrame(raf);
  }, [thread, busy]);

  return (
    <div
      ref={scrollerRef}
      role="log"
      aria-live="polite"
      aria-label="Glass AI conversation"
      className="gd-scroll min-h-0 flex-1 overflow-y-auto px-3.5 py-3"
    >
      {thread.length === 0 && !busy ? (
        <EmptyState onSuggest={onSuggest} />
      ) : (
        <motion.div
          variants={stagger(0.05, 0.04)}
          initial="hidden"
          animate="show"
          className="flex flex-col gap-3"
        >
          {thread.map((m) => (
            <Bubble
              key={`${m.at}|${m.role}|${m.text.slice(0, 12)}`}
              msg={m}
              mine={!!myName && m.by === myName}
              seat={seat}
              onRetry={onRetry}
            />
          ))}
          <AnimatePresence>{busy ? <TypingRow key="typing" /> : null}</AnimatePresence>
        </motion.div>
      )}
    </div>
  );
});

// ============================================================
// bubbles
// ============================================================

function Bubble({
  msg,
  mine,
  seat,
  onRetry,
}: {
  msg: AiMsg;
  mine: boolean;
  seat: "host" | "guest" | null;
  onRetry: () => void;
}) {
  const time = fmtTime(msg.at);

  if (msg.role === "user") {
    return (
      <motion.div variants={riseIn} className="flex flex-col items-end">
        <span className="mb-1 pr-1.5 text-[10px] font-medium text-stone-400">
          {msg.by ?? "you"}
          {mine && seat ? ` · via ${seat}` : ""}
        </span>
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-br from-teal-400/90 to-emerald-500/90 px-3.5 py-2.5 text-[13px] leading-relaxed text-white shadow-sm shadow-emerald-600/20">
          {msg.text}
        </div>
        {time ? <span className="mt-0.5 pr-1.5 text-[10px] text-stone-400/70">{time}</span> : null}
      </motion.div>
    );
  }

  return (
    <motion.div variants={riseIn} className="flex flex-col items-start">
      <div className="flex w-full items-start gap-2">
        <div
          className="gd-accent-gradient mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg shadow-sm shadow-teal-600/25"
          aria-hidden
        >
          <Sparkles className="h-3.5 w-3.5 text-white" />
        </div>
        <div
          className={`min-w-0 max-w-[85%] rounded-2xl rounded-tl-md px-3.5 py-2.5 text-[13px] leading-relaxed ${
            msg.err
              ? "border border-rose-200/80 bg-rose-50/70 text-rose-700 shadow-sm shadow-rose-400/10"
              : "glass text-stone-700"
          }`}
        >
          {msg.err ? (
            <p className="whitespace-pre-wrap">{msg.text}</p>
          ) : (
            mdLite(msg.text)
          )}
          {msg.err ? (
            <motion.button
              type="button"
              variants={pop}
              initial="rest"
              animate="rest"
              whileHover="hover"
              whileTap="tap"
              onClick={onRetry}
              className="mt-2 flex min-h-11 min-w-11 items-center gap-1.5 rounded-full border border-rose-300/70 bg-white/80 px-4 text-[11px] font-medium text-rose-600"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Retry
            </motion.button>
          ) : null}
        </div>
      </div>
      {time ? <span className="mt-0.5 pl-9 text-[10px] text-stone-400/70">{time}</span> : null}
    </motion.div>
  );
}

/** Typing indicator: 3 dots waving (translateY) + a shimmering line. */
function TypingRow() {
  return (
    <motion.div variants={riseIn} className="flex items-start gap-2">
      <div
        className="gd-accent-gradient mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg shadow-sm shadow-teal-600/25"
        aria-hidden
      >
        <Sparkles className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="glass rounded-2xl rounded-tl-md px-3.5 py-2.5">
        <div className="flex items-center gap-1.5" aria-hidden>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="block h-1.5 w-1.5 rounded-full bg-teal-500"
              animate={{ y: [0, -5, 0] }}
              transition={{ duration: 0.8, repeat: Infinity, ease: "easeInOut", delay: i * 0.14 }}
            />
          ))}
        </div>
        <motion.p
          className="mt-1.5 text-[10px] font-medium text-stone-400"
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        >
          Glass AI is thinking…
        </motion.p>
      </div>
    </motion.div>
  );
}

// ============================================================
// empty state
// ============================================================

function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-2 py-6 text-center">
      <motion.div
        className="gd-accent-gradient grid h-16 w-16 place-items-center rounded-3xl shadow-lg shadow-teal-600/25"
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 4.4, repeat: Infinity, ease: "easeInOut" }}
        aria-hidden
      >
        <Sparkles className="h-7 w-7 text-white" />
      </motion.div>
      <motion.h3
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SPRING.window, delay: 0.08 }}
        className="mt-5 text-[15px] font-semibold text-stone-800"
      >
        Ask Glass AI anything
      </motion.h3>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SPRING.window, delay: 0.16 }}
        className="mt-1.5 max-w-[300px] text-[11px] leading-relaxed text-stone-500"
      >
        This thread is shared — your co-pilot sees every question and answer, live.
      </motion.p>
      <motion.div
        variants={stagger(0.055, 0.24)}
        initial="hidden"
        animate="show"
        className="mt-6 flex max-w-[330px] flex-wrap justify-center gap-2"
      >
        {SUGGESTIONS.map((s) => (
          <motion.button
            key={s}
            type="button"
            variants={chipV}
            whileHover="hover"
            whileTap="tap"
            onClick={() => onSuggest(s)}
            className="glass rounded-full px-4 py-3.5 text-xs font-medium text-stone-600"
          >
            {s}
          </motion.button>
        ))}
      </motion.div>
    </div>
  );
}

// ============================================================
// composer (memoized; draft is LOCAL — keystrokes never touch
// the shared store, only sends do)
// ============================================================

const Composer = memo(function Composer({
  busy,
  flushKey,
  onSend,
}: {
  busy: boolean;
  flushKey: number;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [seenFlush, setSeenFlush] = useState(flushKey);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // a suggestion fired elsewhere → wipe the local draft
  // (documented "adjust state when a prop changes" render pattern)
  if (flushKey !== seenFlush) {
    setSeenFlush(flushKey);
    setDraft("");
  }

  // auto-grow 1..3 lines (pure DOM sizing — never animated)
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 72)}px`;
  }, [draft]);

  const canSend = !busy && draft.trim().length > 0;

  const fire = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-1.5">
      <form
        className="glass-strong flex items-end gap-2 rounded-2xl p-2"
        onSubmit={(e) => {
          e.preventDefault();
          fire();
        }}
      >
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              fire();
            }
          }}
          rows={1}
          placeholder="Ask Glass AI — Enter to send, Shift+Enter for a new line"
          aria-label="Message Glass AI"
          className="gd-scroll min-h-11 max-h-[72px] flex-1 resize-none rounded-xl bg-transparent px-2.5 py-2.5 text-[13px] leading-6 text-stone-700 outline-none placeholder:text-stone-400 focus:placeholder:text-stone-400/60"
        />
        <motion.button
          type="submit"
          variants={pop}
          initial="rest"
          animate="rest"
          whileHover="hover"
          whileTap="tap"
          disabled={!canSend}
          aria-label="Send message"
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${
            canSend
              ? "gd-accent-gradient text-white shadow-md shadow-teal-600/30"
              : "bg-stone-300/50 text-stone-500/60"
          }`}
        >
          <ArrowUp className="h-5 w-5" aria-hidden />
        </motion.button>
      </form>
    </div>
  );
});

// ============================================================
// markdown-lite renderer (**bold**, `code`, - lists, line breaks)
// ============================================================

type Tok = { k: "p" | "b" | "c"; s: string };

function tokenizeInline(text: string): Tok[] {
  const toks: Tok[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m = re.exec(text);
  while (m) {
    if (m.index > last) toks.push({ k: "p", s: text.slice(last, m.index) });
    const tok = m[0];
    toks.push(tok.startsWith("**") ? { k: "b", s: tok.slice(2, -2) } : { k: "c", s: tok.slice(1, -1) });
    last = m.index + tok.length;
    m = re.exec(text);
  }
  if (last < text.length) toks.push({ k: "p", s: text.slice(last) });
  return toks;
}

function InlineRuns({ text, kb }: { text: string; kb: string }) {
  return (
    <>
      {tokenizeInline(text).map((t, i) => {
        const key = `${kb}-${i}`;
        if (t.k === "b")
          return (
            <strong key={key} className="font-semibold text-stone-800">
              {t.s}
            </strong>
          );
        if (t.k === "c")
          return (
            <code key={key} className="gd-mono rounded-md bg-stone-900/[0.055] px-1 py-px text-[0.82em] text-teal-700">
              {t.s}
            </code>
          );
        return <span key={key}>{t.s}</span>;
      })}
    </>
  );
}

/** Render a Glass AI reply: paragraphs (line breaks kept), bullet
 *  lists, **bold** and `code` runs. Pure — no hooks, no mutation. */
function mdLite(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let bullets: string[] = [];
  let paras: string[] = [];
  let bi = 0;
  let pi = 0;

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const idx = bi++;
    nodes.push(
      <ul key={`u${idx}`} className="my-1 ml-0.5 list-disc space-y-0.5 pl-4 marker:text-teal-500/70">
        {bullets.map((b, i) => (
          <li key={i}>
            <InlineRuns text={b} kb={`u${idx}-${i}`} />
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  const flushParas = () => {
    if (paras.length === 0) return;
    const idx = pi++;
    nodes.push(
      <p key={`p${idx}`} className="leading-relaxed">
        {paras.map((ln, i) => (
          <span key={i}>
            {i > 0 ? <br /> : null}
            <InlineRuns text={ln} kb={`p${idx}-${i}`} />
          </span>
        ))}
      </p>,
    );
    paras = [];
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) {
      flushParas();
      bullets.push(line.replace(/^[-*•]\s+/, ""));
    } else if (line.length === 0) {
      flushParas();
      flushBullets();
    } else {
      flushBullets();
      paras.push(line);
    }
  }
  flushParas();
  flushBullets();

  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  return <div className="space-y-1">{nodes}</div>;
}
