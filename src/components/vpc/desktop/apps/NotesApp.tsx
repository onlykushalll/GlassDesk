"use client";

// ============================================================
// GlassDesk — Notes. A shared fridge door: every note (max 60)
// lives in payload.notes and autosaves via app:patch, so both
// seats see live edits. While a textarea is focused, remote
// patches never clobber the caret — local draft wins (LWW).
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Pin, Plus, Search, StickyNote, Trash2, X } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { uid, type WindowState } from "@/lib/vpc/types";

type NoteColor = "amber" | "rose" | "teal" | "emerald" | "violet" | "stone";

interface Note {
  id: string;
  title: string;
  text: string;
  color: NoteColor;
  pinned: boolean;
  updatedAt: number;
}

const NOTES_CAP = 60;
const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;
const SOFT_SPRING = { type: "spring", stiffness: 380, damping: 28 } as const;

const COLOR_KEYS: NoteColor[] = ["amber", "rose", "teal", "emerald", "violet", "stone"];

const NOTE_COLORS: Record<NoteColor, { label: string; bg: string; swatch: string }> = {
  amber: { label: "Amber", bg: "linear-gradient(150deg,#fef3c7 0%,#fde68a 100%)", swatch: "#f59e0b" },
  rose: { label: "Rose", bg: "linear-gradient(150deg,#ffe4e6 0%,#fecdd3 100%)", swatch: "#f43f5e" },
  teal: { label: "Teal", bg: "linear-gradient(150deg,#ccfbf1 0%,#99f6e4 100%)", swatch: "#14b8a6" },
  emerald: { label: "Emerald", bg: "linear-gradient(150deg,#d1fae5 0%,#a7f3d0 100%)", swatch: "#10b981" },
  violet: { label: "Violet", bg: "linear-gradient(150deg,#ede9fe 0%,#ddd6fe 100%)", swatch: "#8b5cf6" },
  stone: { label: "Stone", bg: "linear-gradient(150deg,#f5f5f4 0%,#e7e5e4 100%)", swatch: "#78716c" },
};

function isNoteColor(v: unknown): v is NoteColor {
  return typeof v === "string" && (COLOR_KEYS as string[]).includes(v);
}

/** Defensive payload → notes (old windows may lack the field entirely). */
function parseNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  const out: Note[] = [];
  for (const item of raw.slice(0, NOTES_CAP)) {
    if (typeof item !== "object" || item === null) continue;
    const n = item as Record<string, unknown>;
    out.push({
      id: typeof n.id === "string" ? n.id : uid(),
      title: typeof n.title === "string" ? n.title.slice(0, 300) : "",
      text: typeof n.text === "string" ? n.text.slice(0, 8000) : "",
      color: isNoteColor(n.color) ? n.color : "amber",
      pinned: n.pinned === true,
      updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : Date.now(),
    });
  }
  return out;
}

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 5_000) return "just now";
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  const days = Math.floor(d / 86_400_000);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

// first-run content (deterministic ids → a double seed from both
// seats simply overwrites itself, never duplicates)
function seedNotes(): Note[] {
  const now = Date.now();
  return [
    {
      id: "note-welcome",
      title: "Welcome to shared notes",
      text: "This is the fridge door 🧲 — everything you pin here syncs live to the other seat.\n\n• Type together (autosaves as you go)\n• Color-code by mood\n• Pin what matters",
      color: "teal",
      pinned: true,
      updatedAt: now,
    },
    {
      id: "note-groceries",
      title: "Groceries",
      text: "oat milk\nsourdough\ncoffee beans\nsparkling water\ntomatoes\nsomething green",
      color: "amber",
      pinned: false,
      updatedAt: now - 1000,
    },
    {
      id: "note-watchlist",
      title: "Watch list",
      text: "Rewatch: Perfect Days\nThat octopus documentary\nAnything with subtitles and rain",
      color: "rose",
      pinned: false,
      updatedAt: now - 2000,
    },
  ];
}

export default function NotesApp({ win }: { win: WindowState }) {
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  // keystroke mirroring — the peer's editor mirrors our draft live
  const sendInputEvt = useGlassDesk((s) => s.sendInput);
  const inputs = useGlassDesk((s) => s.inputs);
  const w = liveWin ?? win;

  const notes = useMemo(() => parseNotes(w.payload.notes), [w.payload.notes]);

  const patch = useCallback(
    (p: Record<string, unknown>) => dispatch({ t: "app:patch", id: win.id, patch: p }),
    [dispatch, win.id],
  );

  /** Freshest notes straight from the store (beats stale closures). */
  const currentNotes = useCallback((): Note[] => {
    const s = useGlassDesk.getState();
    const live = s.state?.windows.find((x) => x.id === win.id);
    return parseNotes(live?.payload.notes ?? win.payload.notes);
  }, [win.id, win.payload.notes]);

  // ---- first-run seed -------------------------------------------------
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (w.payload.notes !== undefined) return;
    patch({ notes: seedNotes() });
  }, [w.payload.notes, patch]);

  // ---- local ui state -------------------------------------------------
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", text: "" });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirtyRef = useRef(false);
  const focusedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sorted = useMemo(
    () =>
      [...notes].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
      ),
    [notes],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? sorted.filter(
            (n) => n.title.toLowerCase().includes(q) || n.text.toLowerCase().includes(q),
          )
        : sorted,
    [sorted, q],
  );

  const editingNote = editingId ? notes.find((n) => n.id === editingId) : undefined;

  // ---- saving ---------------------------------------------------------
  const saveNow = useCallback(
    (title: string, text: string) => {
      if (!editingId) return;
      const current = currentNotes();
      const existing = current.find((n) => n.id === editingId);
      if (!existing) return; // deleted remotely meanwhile
      if (existing.title === title && existing.text === text) {
        dirtyRef.current = false;
        return;
      }
      const next = current.map((n) =>
        n.id === editingId
          ? { ...n, title: title.slice(0, 300), text: text.slice(0, 8000), updatedAt: Date.now() }
          : n,
      );
      patch({ notes: next });
      dirtyRef.current = false;
      setSavedAt(Date.now());
    },
    [editingId, currentNotes, patch],
  );

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (dirtyRef.current) saveNow(draft.title, draft.text);
  }, [saveNow, draft.title, draft.text]);

  // flush-on-unmount via latest-ref (a direct [flush] cleanup would
  // fire the debounce on every keystroke instead of only at unmount)
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => () => flushRef.current(), []);

  // 400ms debounce autosave
  useEffect(() => {
    if (!dirtyRef.current || !editingId) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      saveNow(draft.title, draft.text);
    }, 400);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [draft, editingId, saveNow]);

  // "Saved · just now" fades away
  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => setSavedAt(null), 1600);
    return () => clearTimeout(t);
  }, [savedAt]);

  /** Live draft mirroring key — `note:<id>` in the ephemeral inputs. */
  const draftKey = editingId ? `note:${editingId}` : null;

  // watch mode: subscribe to the sync store — while the editor is open
  // but NOT focused, remote edits mirror live into the draft (both
  // seats see the same words appear). Prefers the FRESH keystroke ghost
  // (≤4s old, keystroke-level) over the debounced saved payload — that's
  // the 0-latency path. While focused, local wins so the caret never
  // jumps (last-write-wins resolves on next save).
  useEffect(() => {
    if (!editingId) return;
    const unsub = useGlassDesk.subscribe((s) => {
      if (focusedRef.current) return;
      const live = s.state?.windows.find((x) => x.id === win.id);
      const remote = parseNotes(live?.payload.notes).find((n) => n.id === editingId);
      if (!remote) return; // deleted remotely — overlay unmounts on its own
      const ghost = s.inputs[`note:${editingId}`];
      if (ghost && Date.now() - ghost.at < 4000) {
        // freshest: the peer's in-progress keystrokes
        try {
          const parsed = JSON.parse(ghost.text) as { title?: string; text?: string };
          setDraft((d) =>
            d.title === (parsed.title ?? "") && d.text === (parsed.text ?? "")
              ? d
              : { title: parsed.title ?? "", text: parsed.text ?? "" },
          );
          return;
        } catch {
          /* malformed ghost — fall through to the saved payload */
        }
      }
      setDraft((d) =>
        d.title === remote.title && d.text === remote.text
          ? d
          : { title: remote.title, text: remote.text },
      );
    });
    return () => unsub();
  }, [editingId, win.id]);

  // Escape closes the editor (flush first)
  useEffect(() => {
    if (!editingId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        flushRef.current();
        setEditingId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId]);

  // ---- actions --------------------------------------------------------
  const openNote = (n: Note) => {
    if (dirtyRef.current) flushRef.current();
    dirtyRef.current = false;
    setEditingId(n.id);
    setDraft({ title: n.title, text: n.text });
    setSavedAt(null);
  };

  const createNote = () => {
    if (dirtyRef.current) flushRef.current();
    const current = currentNotes();
    if (current.length >= NOTES_CAP) {
      pushToast({
        title: "Note limit reached",
        body: "The fridge door holds 60 notes — recycle one first.",
        kind: "warn",
      });
      return;
    }
    const note: Note = {
      id: uid(),
      title: "",
      text: "",
      color: COLOR_KEYS[current.length % COLOR_KEYS.length],
      pinned: false,
      updatedAt: Date.now(),
    };
    patch({ notes: [note, ...current] });
    dirtyRef.current = false;
    setEditingId(note.id);
    setDraft({ title: "", text: "" });
    setSavedAt(null);
  };

  const deleteNote = (id: string) => {
    patch({ notes: currentNotes().filter((n) => n.id !== id) });
    if (editingId === id) setEditingId(null);
    dirtyRef.current = false;
    pushToast({ title: "Note deleted", body: "Torn off the fridge door.", kind: "info" });
  };

  const togglePin = (id: string) => {
    patch({
      notes: currentNotes().map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n)),
    });
  };

  const setColor = (id: string, color: NoteColor) => {
    patch({ notes: currentNotes().map((n) => (n.id === id ? { ...n, color } : n)) });
  };

  // responsive grid columns from the LIVE window width
  const cols = w.w < 560 ? 2 : w.w < 780 ? 3 : 4;

  const editColor: NoteColor = editingNote?.color ?? "amber";

  /** A note card shows a live "editing…" breath while the peer's
   *  keystroke ghost for it is fresh (mirrored input stream). */
  const editingBy = (id: string): string | null => {
    const g = inputs[`note:${id}`];
    if (!g || Date.now() - g.at > 4000) return null;
    return g.name;
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white/25">
      {/* ------------------------- toolbar ------------------------- */}
      <header className="flex shrink-0 items-center gap-2 border-b border-white/60 bg-white/35 px-3 py-2.5">
        <div className="flex items-center gap-1.5 pl-0.5">
          <StickyNote className="size-4 text-amber-500" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-stone-700">Notes</h2>
          <span className="text-xs tabular-nums text-stone-400">
            {notes.length} / {NOTES_CAP}
          </span>
        </div>
        <div className="relative ml-auto">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-stone-400"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes"
            aria-label="Search notes"
            className="glass h-8 w-36 rounded-lg pl-8 pr-7 text-xs text-stone-700 outline-none placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-stone-300"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          transition={SPRING}
          onClick={createNote}
          className="gd-accent-gradient flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-stone-300"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          New note
        </motion.button>
      </header>

      {/* ------------------------- note grid ------------------------- */}
      <div className="gd-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {visible.length === 0 && q ? (
          <div className="grid h-full place-items-center">
            <div className="glass flex flex-col items-center gap-2 rounded-2xl px-8 py-6 text-center">
              <Search className="size-6 text-stone-300" aria-hidden="true" />
              <p className="text-sm font-medium text-stone-600">
                No notes match “{query.trim()}”
              </p>
              <p className="text-xs text-stone-400">Try a shorter word.</p>
            </div>
          </div>
        ) : notes.length === 0 ? (
          <div className="grid h-full place-items-center">
            <div className="glass flex flex-col items-center gap-3 rounded-2xl px-10 py-8 text-center">
              <div className="grid size-14 place-items-center rounded-full bg-amber-100/80">
                <StickyNote className="size-7 text-amber-500" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-stone-700">No notes yet</p>
              <p className="max-w-[220px] text-xs text-stone-400">
                The fridge door is bare — pin your first thought.
              </p>
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                transition={SPRING}
                onClick={createNote}
                className="gd-accent-gradient mt-1 flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:brightness-105"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                New note
              </motion.button>
            </div>
          </div>
        ) : (
          <div
            className="grid gap-2.5"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            <motion.button
              type="button"
              layout
              transition={SOFT_SPRING}
              whileTap={{ scale: 0.97 }}
              onClick={createNote}
              aria-label="Create a new note"
              className="flex h-40 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-stone-300/90 bg-white/20 text-stone-400 outline-none transition-colors hover:border-teal-400/80 hover:bg-white/50 hover:text-teal-600 focus-visible:ring-2 focus-visible:ring-teal-400"
            >
              <span className="grid size-9 place-items-center rounded-full bg-white/60">
                <Plus className="size-5" aria-hidden="true" />
              </span>
              <span className="text-xs font-medium">New note</span>
            </motion.button>

            <AnimatePresence mode="popLayout">
              {visible.map((n) => (
                <motion.button
                  key={n.id}
                  type="button"
                  layout
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={SOFT_SPRING}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => openNote(n)}
                  aria-label={`Open note ${n.title.trim() || "Untitled"}`}
                  className="group relative flex h-40 flex-col rounded-2xl p-3 text-left shadow-sm outline-none transition-shadow hover:shadow-xl focus-visible:ring-2 focus-visible:ring-stone-400"
                  style={{ background: NOTE_COLORS[n.color].bg }}
                >
                  <span className="flex items-start gap-1.5">
                    <span className="min-w-0 flex-1 break-words text-sm font-semibold leading-tight text-stone-800">
                      {n.title.trim() || "Untitled"}
                    </span>
                    {editingBy(n.id) ? (
                      <span
                        className="mt-0.5 flex shrink-0 items-center gap-1 rounded-full bg-white/80 px-1.5 py-0.5 text-[9px] font-medium text-stone-500"
                        aria-label={`${editingBy(n.id)} is editing`}
                      >
                        <span className="size-1.5 animate-pulse rounded-full" style={{ background: "var(--gd-accent)" }} aria-hidden />
                        {editingBy(n.id)}
                      </span>
                    ) : (
                      n.pinned && (
                        <Pin
                          className="mt-0.5 size-3.5 shrink-0 text-stone-500"
                          fill="currentColor"
                          aria-label="Pinned"
                        />
                      )
                    )}
                  </span>
                  <span className="mt-1.5 line-clamp-6 flex-1 overflow-hidden whitespace-pre-wrap break-words text-[12.5px] leading-snug text-stone-600">
                    {n.text}
                  </span>
                  <span className="pt-1 text-[10px] font-medium uppercase tracking-wide text-stone-500/80">
                    {relTime(n.updatedAt)}
                  </span>
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ------------------------- editor overlay ------------------------- */}
      <AnimatePresence>
        {editingNote && (
          <motion.div
            key="editor"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={SOFT_SPRING}
            className="absolute inset-0 z-30 flex flex-col p-2"
            role="dialog"
            aria-label={`Editing note ${editingNote.title.trim() || "Untitled"}`}
          >
            <div className="absolute inset-0 bg-stone-950/25 backdrop-blur-[2px]" />
            <motion.div
              initial={{ y: 26, opacity: 0, scale: 0.98 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: 26, opacity: 0, scale: 0.98 }}
              transition={SPRING}
              className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/60"
              style={{ background: NOTE_COLORS[editColor].bg }}
            >
              {/* editor toolbar */}
              <div className="flex shrink-0 flex-col gap-1.5 border-b border-white/50 bg-white/35 px-2.5 py-2 backdrop-blur-xl">
                <div className="flex items-center gap-1.5">
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.92 }}
                    transition={SPRING}
                    onClick={() => {
                      flush();
                      if (draftKey) sendInputEvt(draftKey, ""); // clear the ghost
                      setEditingId(null);
                    }}
                    aria-label="Back to notes"
                    className="glass flex size-7 items-center justify-center rounded-lg text-stone-600 hover:bg-white/80"
                  >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                  </motion.button>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.92 }}
                    transition={SPRING}
                    onClick={() => togglePin(editingNote.id)}
                    aria-label={editingNote.pinned ? "Unpin note" : "Pin note"}
                    aria-pressed={editingNote.pinned}
                    className={`flex size-7 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-stone-300 ${
                      editingNote.pinned
                        ? "bg-white/85 text-stone-700 shadow-sm"
                        : "text-stone-500 hover:bg-white/60"
                    }`}
                  >
                    <Pin
                      className="size-4"
                      fill={editingNote.pinned ? "currentColor" : "none"}
                      aria-hidden="true"
                    />
                  </motion.button>

                  <span className="ml-auto flex h-7 items-center" aria-live="polite">
                    <AnimatePresence>
                      {savedAt !== null && (
                        <motion.span
                          key={savedAt}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={SOFT_SPRING}
                          className="flex items-center gap-1 text-[10px] font-medium text-emerald-600"
                        >
                          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                          Saved · just now
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>

                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.92 }}
                    transition={SPRING}
                    onClick={() => deleteNote(editingNote.id)}
                    aria-label="Delete note"
                    className="flex size-7 items-center justify-center rounded-lg text-stone-500 outline-none hover:bg-rose-100 hover:text-rose-600 focus-visible:ring-2 focus-visible:ring-rose-300"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </motion.button>
                </div>

                <div className="flex items-center gap-1.5">
                  {COLOR_KEYS.map((c) => (
                    <motion.button
                      key={c}
                      type="button"
                      whileTap={{ scale: 0.85 }}
                      transition={SPRING}
                      onClick={() => setColor(editingNote.id, c)}
                      aria-label={`${NOTE_COLORS[c].label} note color`}
                      aria-pressed={editColor === c}
                      className={`size-5 rounded-full outline-none ring-offset-1 transition-transform focus-visible:ring-2 focus-visible:ring-stone-400 ${
                        editColor === c ? "ring-2 ring-stone-500 scale-110" : "hover:scale-110"
                      }`}
                      style={{ background: NOTE_COLORS[c].swatch }}
                    />
                  ))}
                  <span className="ml-auto pr-1 text-[10px] font-medium uppercase tracking-wide text-stone-500/80">
                    {relTime(editingNote.updatedAt)}
                  </span>
                </div>
              </div>

              {/* title + body */}
              <div className="gd-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
                <input
                  value={draft.title}
                  onChange={(e) => {
                    dirtyRef.current = true;
                    const merged = { ...draft, title: e.target.value };
                    setDraft(merged);
                    if (draftKey) sendInputEvt(draftKey, JSON.stringify(merged));
                  }}
                  onFocus={() => {
                    focusedRef.current = true;
                  }}
                  onBlur={() => {
                    focusedRef.current = false;
                    if (dirtyRef.current) flush();
                  }}
                  placeholder="Title"
                  aria-label="Note title"
                  maxLength={300}
                  className="shrink-0 bg-transparent px-4 pb-1 pt-3 text-lg font-bold leading-snug text-stone-800 outline-none placeholder:text-stone-400/60"
                />
                <textarea
                  value={draft.text}
                  onChange={(e) => {
                    dirtyRef.current = true;
                    const merged = { ...draft, text: e.target.value };
                    setDraft(merged);
                    if (draftKey) sendInputEvt(draftKey, JSON.stringify(merged));
                  }}
                  onFocus={() => {
                    focusedRef.current = true;
                  }}
                  onBlur={() => {
                    focusedRef.current = false;
                    if (dirtyRef.current) flush();
                  }}
                  placeholder="Start writing — it syncs to the other seat live…"
                  aria-label="Note text"
                  maxLength={8000}
                  spellCheck
                  className="min-h-[120px] flex-1 resize-none bg-transparent px-4 pb-4 text-sm leading-relaxed text-stone-700 outline-none placeholder:text-stone-400/60"
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
