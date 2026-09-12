"use client";

// ============================================================
// GlassDesk — Voice Memos. The memo LIST (metadata + transcripts
// + selection) lives in the shared payload, so both seats see
// the same memos and the same expanded card. Audio blobs stay
// LOCAL to the seat that recorded them (by design — the remote
// seat reads the transcript; cards without local audio show a
// "recorded on the other seat" lock chip).
// Hardware path: MediaRecorder + AnalyserNode → 28-bar live
// waveform (rAF writing scaleY on refs — zero setState/frame),
// then POST /api/vpc/asr for transcription.
// No-mic path (headless QA): graceful "type mode" — a typed
// memo flows through the exact same synced memo shape.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Gauge, Lock, Mic, Pause, PenLine, Play, RefreshCw, Sparkles, Square, TriangleAlert, X } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { SPRING, riseIn, stagger, pop } from "@/lib/vpc/motion";
import { uid, type WindowState } from "@/lib/vpc/types";

// ---------------- shapes ----------------

interface VoiceMemo {
  id: string;
  name: string;
  dur: number;
  at: number;
  by?: string;
  text: string;
  pending?: boolean;
}

type VoiceP = { memos: VoiceMemo[]; sel: string | null };

const MEMO_CAP = 30;
const BAR_COUNT = 28;

/** LOCAL-seat audio only — memo id → object URL. Never synced. */
const localAudioUrls = new Map<string, string>();

function readMemos(w: WindowState | undefined): VoiceMemo[] {
  const raw = (w?.payload as Partial<VoiceP> | undefined)?.memos;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is VoiceMemo =>
      !!m && typeof m === "object" && typeof (m as VoiceMemo).id === "string" && typeof (m as VoiceMemo).name === "string",
  );
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------- memo card ----------------

function MemoCard({
  memo,
  expanded,
  url,
  onToggle,
  onRename,
  onDelete,
}: {
  memo: VoiceMemo;
  expanded: boolean;
  url: string | undefined;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const timeLabelRef = useRef<HTMLSpanElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 1.5 | 2>(1);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memo.name);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.playbackRate = speed;
      a.play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    } else {
      a.pause();
      setPlaying(false);
    }
  };

  const commitRename = () => {
    setEditing(false);
    const v = draft.trim().slice(0, 60);
    if (v && v !== memo.name) onRename(v);
  };

  const cycleSpeed = () => setSpeed((s) => (s === 1 ? 1.5 : s === 1.5 ? 2 : 1));

  return (
    <motion.div
      layout
      variants={riseIn}
      initial="hidden"
      animate="show"
      exit="exit"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className="glass cursor-pointer rounded-xl p-3 outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
    >
      <div className="flex items-center gap-2">
        {url ? (
          <motion.button
            type="button"
            whileTap={{ scale: 0.88 }}
            transition={SPRING.snappy}
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            aria-label={playing ? `Pause ${memo.name}` : `Play ${memo.name}`}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-fuchsia-400 to-rose-500 text-white shadow-sm"
          >
            {playing ? <Pause className="size-3.5" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
          </motion.button>
        ) : memo.dur > 0 || memo.pending ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-stone-100/90 px-2.5 py-1 text-[10px] font-medium text-stone-400"
            title="Audio stays on the seat that recorded it — the transcript is shared"
          >
            <Lock className="size-3" aria-hidden="true" /> other seat
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-stone-100/90 px-2.5 py-1 text-[10px] font-medium text-stone-400">
            <PenLine className="size-3" aria-hidden="true" /> typed
          </span>
        )}

        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(memo.name);
                setEditing(false);
              }
            }}
            onBlur={commitRename}
            aria-label="Memo name"
            className="min-w-0 flex-1 rounded-md border border-teal-300 bg-white/80 px-1.5 py-0.5 text-sm font-semibold text-stone-700 outline-none"
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-sm font-semibold text-stone-700"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(memo.name);
              setEditing(true);
            }}
            title="Double-click to rename"
          >
            {memo.name}
          </span>
        )}

        {memo.dur > 0 && (
          <span className="gd-mono shrink-0 rounded-full bg-stone-100/90 px-2 py-0.5 text-[10px] tabular-nums text-stone-500">
            {fmtDur(memo.dur)}
          </span>
        )}
        <span className="shrink-0 text-[10px] text-stone-400">{ago(memo.at)}</span>
        {memo.by && (
          <span className="max-w-[86px] shrink-0 truncate rounded-full bg-rose-50/90 px-2 py-0.5 text-[10px] font-medium text-rose-500">
            by {memo.by}
          </span>
        )}
        <motion.button
          type="button"
          whileTap={{ scale: 0.88 }}
          transition={SPRING.snappy}
          onClick={(e) => {
            e.stopPropagation();
            if (confirming) {
              onDelete();
            } else {
              setConfirming(true);
              window.setTimeout(() => setConfirming(false), 2600);
            }
          }}
          aria-label={confirming ? `Confirm delete ${memo.name}` : `Delete ${memo.name}`}
          className={`grid h-6 shrink-0 place-items-center rounded-full outline-none transition-colors ${
            confirming ? "bg-rose-100 px-2 text-[10px] font-semibold text-rose-600" : "size-6 text-stone-400 hover:bg-rose-100 hover:text-rose-500"
          }`}
        >
          {confirming ? "Sure?" : <X className="size-3.5" aria-hidden="true" />}
        </motion.button>
      </div>

      {memo.pending ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="gd-shimmer h-2.5 w-[78%] rounded-full bg-stone-200/80" aria-hidden="true" />
          <div className="gd-shimmer h-2.5 w-[54%] rounded-full bg-stone-200/80" aria-hidden="true" />
          <span className="mt-0.5 flex items-center text-[10px] font-medium text-stone-400">
            Transcribing
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                animate={{ opacity: [0.25, 1, 0.25] }}
                transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
                aria-hidden="true"
              >
                .
              </motion.span>
            ))}
          </span>
        </div>
      ) : expanded ? (
        <motion.div
          variants={riseIn}
          initial="hidden"
          animate="show"
          className="mt-2 rounded-lg border border-white/60 bg-white/50 p-2"
        >
          <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-stone-600">{memo.text}</p>
        </motion.div>
      ) : (
        <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-stone-500">{memo.text}</p>
      )}

      {url && (
        <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <audio
            ref={audioRef}
            src={url}
            preload="metadata"
            className="hidden"
            onEnded={() => setPlaying(false)}
            onTimeUpdate={(e) => {
              const a = e.currentTarget;
              const d = isFinite(a.duration) && a.duration > 0 ? a.duration : memo.dur || 0;
              const ratio = d > 0 ? a.currentTime / d : 0;
              if (progressRef.current) {
                progressRef.current.style.transform = `scaleX(${Math.max(0.005, Math.min(1, ratio)).toFixed(4)})`;
              }
              if (timeLabelRef.current) {
                timeLabelRef.current.textContent = `${fmtDur(a.currentTime)} / ${fmtDur(d)}`;
              }
            }}
          />
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-stone-200/80">
            <div
              ref={progressRef}
              className="h-full origin-left rounded-full bg-gradient-to-r from-fuchsia-400 to-rose-400"
              style={{ transform: "scaleX(0.005)" }}
            />
          </div>
          <span ref={timeLabelRef} className="gd-mono shrink-0 text-[10px] tabular-nums text-stone-400">
            0:00 / {fmtDur(memo.dur)}
          </span>
          <motion.button
            type="button"
            variants={pop}
            initial="rest"
            animate="rest"
            whileHover="hover"
            whileTap="tap"
            onClick={cycleSpeed}
            aria-label={`Playback speed ${speed}x — tap to cycle`}
            className="gd-mono shrink-0 rounded-full bg-stone-100/90 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-stone-500 hover:bg-stone-200/90"
          >
            {speed}x
          </motion.button>
        </div>
      )}
    </motion.div>
  );
}

// ---------------- empty state ----------------

function EmptyVoice() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <motion.div
        animate={{ y: [0, -7, 0] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        className="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-fuchsia-400 to-rose-500 shadow-lg shadow-rose-200"
      >
        <Mic className="size-7 text-white" aria-hidden="true" />
      </motion.div>
      <p className="text-sm font-semibold text-stone-600">Hit record — it transcribes itself</p>
      <div className="flex flex-wrap justify-center gap-2">
        <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-stone-500">
          <Sparkles className="size-3 text-rose-400" aria-hidden="true" /> AI transcription
        </span>
        <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-stone-500">
          <RefreshCw className="size-3 text-teal-500" aria-hidden="true" /> Synced list
        </span>
        <span className="glass flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium text-stone-500">
          <Gauge className="size-3 text-amber-500" aria-hidden="true" /> 1x–2x speed
        </span>
      </div>
    </div>
  );
}

// ---------------- main ----------------

export default function VoiceApp({ win }: { win: WindowState }) {
  // LIVE window so remote memo patches land instantly on this seat
  const liveWin = useGlassDesk((s) => s.state?.windows.find((x) => x.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const myName = useGlassDesk((s) => s.name);
  const w = liveWin ?? win;

  const p = w.payload as Partial<VoiceP>;
  const memos = readMemos(w);
  const sel = typeof p.sel === "string" ? p.sel : null;
  const pendingCount = memos.filter((m) => m.pending).length;

  const patch = (o: Partial<VoiceP>) => dispatch({ t: "app:patch", id: win.id, patch: o });

  const [micMode, setMicMode] = useState<"unknown" | "mic" | "type">("unknown");
  const [rec, setRec] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");
  const [, setTick] = useState(0); // 30s nudge so "time ago" stays fresh

  const barsRef = useRef<(HTMLDivElement | null)[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);
  const timerRef = useRef(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef("audio/webm");
  const startedAtRef = useRef(0);

  // keep "time ago" honest without per-card timers
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // hard teardown if the window dies mid-recording
  useEffect(() => {
    return () => {
      window.clearInterval(timerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      analyserRef.current = null;
      try {
        if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
      } catch {
        /* already gone */
      }
      recRef.current = null;
    };
  }, []);

  // fresh-read memo mutator (async callbacks must never see stale memos)
  const patchMemo = (id: string, upd: (m: VoiceMemo) => VoiceMemo) => {
    const s = useGlassDesk.getState();
    const wd = s.state?.windows.find((x) => x.id === win.id);
    dispatch({
      t: "app:patch",
      id: win.id,
      patch: { memos: readMemos(wd).map((m) => (m.id === id ? upd(m) : m)) },
    });
  };

  const transcribe = async (id: string, blob: Blob) => {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const res = await fetch("/api/vpc/asr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: btoa(bin) }),
      });
      const j = (await res.json()) as { text?: string; error?: string };
      if (!res.ok || typeof j.text !== "string") throw new Error(j.error ?? `HTTP ${res.status}`);
      const text = j.text.trim();
      patchMemo(id, (m) => ({ ...m, text: text || "(empty recording)", pending: false }));
    } catch {
      patchMemo(id, (m) => ({ ...m, text: "(transcription unavailable)", pending: false }));
      pushToast({
        title: "Transcription unavailable",
        body: "The memo and its audio are saved — the text service didn't answer.",
        kind: "warn",
      });
    }
  };

  // fired by MediaRecorder.onstop
  const finishRec = () => {
    const durSec = Math.max(1, Math.round((Date.now() - (startedAtRef.current || Date.now())) / 1000));
    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    chunksRef.current = [];
    if (blob.size === 0) return;
    const s = useGlassDesk.getState();
    const wd = s.state?.windows.find((x) => x.id === win.id);
    const cur = readMemos(wd);
    const memo: VoiceMemo = {
      id: uid(),
      name: `Memo ${cur.length + 1}`,
      dur: durSec,
      at: Date.now(),
      by: s.name || "this seat",
      text: "",
      pending: true,
    };
    localAudioUrls.set(memo.id, URL.createObjectURL(blob));
    dispatch({ t: "app:patch", id: win.id, patch: { memos: [memo, ...cur].slice(0, MEMO_CAP), sel: memo.id } });
    void transcribe(memo.id, blob);
  };

  const stopRec = () => {
    const mr = recRef.current;
    if (mr && mr.state !== "inactive") mr.stop(); // → onstop → finishRec
    window.clearInterval(timerRef.current);
    timerRef.current = 0;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    analyserRef.current = null;
    setRec(false);
    for (const el of barsRef.current) if (el) el.style.transform = "scaleY(0.09)";
  };

  const startRec = async () => {
    if (rec) return;
    try {
      const md = navigator.mediaDevices;
      if (!md) throw new Error("no media devices");
      const stream = await md.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      ctx.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;

      const mime =
        ["audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      mimeRef.current = mime || "audio/webm";
      const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        finishRec();
      };
      mr.start(250);

      startedAtRef.current = Date.now();
      setRec(true);
      setElapsed(0);
      setMicMode("mic");
      timerRef.current = window.setInterval(() => {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }, 250);

      // live waveform: rAF writes scaleY on bar refs — never setState
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        const a = analyserRef.current;
        if (!a) return;
        a.getByteFrequencyData(data);
        const bars = barsRef.current;
        const usable = Math.min(48, data.length);
        for (let i = 0; i < BAR_COUNT; i++) {
          const el = bars[i];
          if (!el) continue;
          const lo = Math.floor((i * usable) / BAR_COUNT);
          const hi = Math.max(lo + 1, Math.floor(((i + 1) * usable) / BAR_COUNT));
          let sum = 0;
          for (let j = lo; j < hi; j++) sum += data[j];
          const v = sum / (hi - lo) / 255;
          el.style.transform = `scaleY(${Math.max(0.07, Math.min(1, v * 1.6)).toFixed(3)})`;
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch {
      setMicMode("type");
      pushToast({
        title: "Microphone unavailable",
        body: "Type mode active — typed memos still sync to both seats.",
        kind: "warn",
      });
    }
  };

  const saveTypedMemo = () => {
    const text = draftText.trim();
    if (!text) return;
    const s = useGlassDesk.getState();
    const wd = s.state?.windows.find((x) => x.id === win.id);
    const cur = readMemos(wd);
    const memo: VoiceMemo = {
      id: uid(),
      name: draftName.trim().slice(0, 60) || `Memo ${cur.length + 1}`,
      dur: 0,
      at: Date.now(),
      by: s.name || "this seat",
      text,
      pending: false,
    };
    dispatch({ t: "app:patch", id: win.id, patch: { memos: [memo, ...cur].slice(0, MEMO_CAP), sel: memo.id } });
    setSheetOpen(false);
    setDraftName("");
    setDraftText("");
    pushToast({ title: "Memo saved", body: "Typed memo landed in the shared list.", kind: "success" });
  };

  const deleteMemo = (id: string) => {
    const url = localAudioUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      localAudioUrls.delete(id);
    }
    const s = useGlassDesk.getState();
    const wd = s.state?.windows.find((x) => x.id === win.id);
    const cur = readMemos(wd).filter((m) => m.id !== id);
    const selNext = cur.some((m) => m.id === sel) ? sel : null;
    dispatch({ t: "app:patch", id: win.id, patch: { memos: cur, sel: selNext } });
    pushToast({ title: "Memo deleted", kind: "info" });
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* ---------------- header ---------------- */}
      <header className="flex shrink-0 items-center gap-3 px-3 pb-2 pt-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-fuchsia-400 to-rose-500 shadow-sm">
          <Mic className="size-4 text-white" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-stone-700">Voice Memos</h2>
          <p className="truncate text-[11px] text-stone-400">
            {memos.length} {memos.length === 1 ? "memo" : "memos"}
            {pendingCount > 0 ? ` · ${pendingCount} transcribing` : ""} · transcripts synced
          </p>
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50/80 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
          <span className="relative flex size-1.5" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
          synced
        </span>
      </header>

      {/* ---------------- no-mic fallback banner ---------------- */}
      <AnimatePresence>
        {micMode === "type" && (
          <motion.div
            variants={riseIn}
            initial="hidden"
            animate="show"
            exit="exit"
            className="mx-3 mb-1 flex shrink-0 items-center gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-1.5 text-[11px] font-medium text-amber-700"
          >
            <TriangleAlert className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            Microphone unavailable — type mode. Memos + transcripts still sync to both seats.
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------------- record zone ---------------- */}
      <div className="flex shrink-0 flex-col items-center gap-1.5 border-b border-white/60 bg-white/25 px-3 pb-3 pt-1.5">
        <div className="flex h-9 items-center justify-center gap-[3px]" aria-hidden="true">
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <div
              key={i}
              ref={(el) => {
                barsRef.current[i] = el;
              }}
              className={`w-[3px] rounded-full transition-colors duration-300 ${rec ? "bg-rose-400" : "bg-stone-300/80"}`}
              style={{ height: "2rem", transform: "scaleY(0.09)" }}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="gd-mono w-14 text-right text-xs tabular-nums text-stone-500">
            {rec ? fmtDur(elapsed) : "0:00"}
          </span>
          <motion.button
            type="button"
            whileTap={{ scale: 0.9 }}
            whileHover={{ scale: 1.06 }}
            transition={SPRING.snappy}
            onClick={rec ? stopRec : micMode === "type" ? () => setSheetOpen(true) : () => void startRec()}
            aria-label={rec ? "Stop recording" : micMode === "type" ? "New typed memo" : "Record a voice memo"}
            className="relative grid size-14 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          >
            {rec && (
              <motion.span
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-rose-400/50"
                animate={{ scale: [1, 1.35], opacity: [0.55, 0] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
              />
            )}
            {rec ? (
              <span className="grid size-full place-items-center rounded-full bg-rose-500 text-white shadow-lg">
                <Square className="size-5" fill="currentColor" aria-hidden="true" />
              </span>
            ) : (
              <span className="grid size-full place-items-center rounded-full bg-gradient-to-br from-fuchsia-400 to-rose-500 text-white shadow-lg">
                {micMode === "type" ? (
                  <PenLine className="size-5" aria-hidden="true" />
                ) : (
                  <Mic className="size-6" aria-hidden="true" />
                )}
              </span>
            )}
          </motion.button>
          <span
            className={`w-14 text-left text-[10px] font-semibold uppercase tracking-wider ${
              rec ? "text-rose-500" : "text-stone-400"
            }`}
          >
            {rec ? "REC" : micMode === "type" ? "Type" : "Ready"}
          </span>
        </div>
      </div>

      {/* ---------------- memo list ---------------- */}
      {memos.length === 0 ? (
        <div className="gd-scroll min-h-0 flex-1 overflow-y-auto">
          <EmptyVoice />
        </div>
      ) : (
        <motion.div
          variants={stagger(0.05, 0.04)}
          initial="hidden"
          animate="show"
          className="gd-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
        >
          <div className="flex flex-col gap-2">
            <AnimatePresence mode="popLayout" initial={false}>
              {memos.map((m) => (
                <MemoCard
                  key={m.id}
                  memo={m}
                  expanded={sel === m.id}
                  url={localAudioUrls.get(m.id)}
                  onToggle={() => patch({ sel: sel === m.id ? null : m.id })}
                  onRename={(name) => patchMemo(m.id, (mm) => ({ ...mm, name }))}
                  onDelete={() => deleteMemo(m.id)}
                />
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}

      {/* ---------------- local-audio note ---------------- */}
      <footer className="flex shrink-0 items-center gap-1.5 border-t border-white/60 bg-white/30 px-3 py-1.5 text-[10px] text-stone-400">
        <Lock className="size-3 shrink-0" aria-hidden="true" />
        Audio stays on the seat that recorded it — transcripts + the memo list sync live.
      </footer>

      {/* ---------------- typed-memo sheet ---------------- */}
      <AnimatePresence>
        {sheetOpen && (
          <motion.div
            key="typed-sheet"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 z-30 flex items-center justify-center bg-stone-950/25 p-4 backdrop-blur-[2px]"
            onClick={() => setSheetOpen(false)}
          >
            <motion.div
              variants={riseIn}
              initial="hidden"
              animate="show"
              exit="exit"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label="New typed memo"
              className="glass-strong w-full max-w-[360px] rounded-2xl p-4 shadow-xl"
            >
              <div className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-400 to-rose-500 text-white">
                  <PenLine className="size-3.5" aria-hidden="true" />
                </span>
                <h3 className="text-sm font-semibold text-stone-700">New typed memo</h3>
                <motion.button
                  type="button"
                  variants={pop}
                  initial="rest"
                  animate="rest"
                  whileHover="hover"
                  whileTap="tap"
                  onClick={() => setSheetOpen(false)}
                  aria-label="Close"
                  className="ml-auto grid size-7 place-items-center rounded-full text-stone-400 hover:bg-stone-200/70 hover:text-stone-600"
                >
                  <X className="size-4" aria-hidden="true" />
                </motion.button>
              </div>
              <label htmlFor={`vn-${win.id}`} className="mt-3 block text-[11px] font-medium text-stone-500">
                Name
              </label>
              <input
                id={`vn-${win.id}`}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={`Memo ${memos.length + 1}`}
                className="mt-1 w-full rounded-lg border border-white/70 bg-white/70 px-2.5 py-1.5 text-sm text-stone-700 outline-none placeholder:text-stone-400 focus:border-teal-300"
              />
              <label htmlFor={`vt-${win.id}`} className="mt-2 block text-[11px] font-medium text-stone-500">
                Text
              </label>
              <textarea
                id={`vt-${win.id}`}
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                rows={4}
                placeholder="Type it out — it lands in the shared memo list like a transcript."
                className="mt-1 w-full resize-none rounded-lg border border-white/70 bg-white/70 px-2.5 py-1.5 text-sm text-stone-700 outline-none placeholder:text-stone-400 focus:border-teal-300"
              />
              <div className="mt-3 flex items-center justify-end gap-2">
                <span className="mr-auto text-[10px] text-stone-400">Syncs instantly · by {myName || "you"}</span>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  transition={SPRING.snappy}
                  onClick={saveTypedMemo}
                  disabled={!draftText.trim()}
                  className="rounded-full bg-gradient-to-br from-fuchsia-400 to-rose-500 px-4 py-1.5 text-xs font-semibold text-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:opacity-40"
                >
                  Save memo
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
