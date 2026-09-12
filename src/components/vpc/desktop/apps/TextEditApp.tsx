"use client";

// ============================================================
// GlassDesk — TextEdit. Payload: { fileId: string | null, value: string }.
// Keystroke-level co-editing: every keystroke patches { value }
// (local-apply-first, store relays instantly). Autosave to the
// GlassDesk HD volume is debounced 700 ms after the last
// keystroke. fileId === null means "not on disk yet".
// ============================================================

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, Save } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { fsPathOf, uid, type WindowState } from "@/lib/vpc/types";

function nameFor(value: string): string {
  const first = (value.split("\n")[0] ?? "").trim();
  const name = first.slice(0, 40);
  return name.length > 0 ? name : "Untitled.txt";
}

export default function TextEditApp({ win }: { win: WindowState }) {
  // the LIVE window — value arrives fresh from the store on every keystroke
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const fs = useGlassDesk((s) => s.state?.fs);
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;

  const fileId = typeof w.payload.fileId === "string" && w.payload.fileId.length > 0 ? w.payload.fileId : null;
  const value = typeof w.payload.value === "string" ? w.payload.value : "";

  const loadedFileId = useRef<string | null>(null);
  // What's on disk, from this seat's point of view. It advances ONLY in
  // async callbacks (autosave timer) and event handlers (saveNew) — never
  // synchronously in an effect — and `saveState` is fully derived from it.
  const [savedValue, setSavedValue] = useState<string | null>(null);

  // When the window is (re)pointed at a file, load its content from the
  // volume. The ref guard keeps live co-typing from being clobbered — we
  // only load when the fileId actually changes. (dispatches only — no
  // local setState in the effect body.)
  useEffect(() => {
    if (!fileId) return;
    if (loadedFileId.current === fileId) return;
    loadedFileId.current = fileId;
    const node = useGlassDesk.getState().state?.fs[fileId];
    dispatch({ t: "app:set", id: win.id, payload: { fileId, value: node?.content ?? "" } });
    if (node) dispatch({ t: "win:title", id: win.id, title: node.name });
  }, [fileId, dispatch, win.id]);

  const saveState: "saving" | "saved" =
    fileId !== null && value !== (savedValue ?? "") ? "saving" : "saved";

  // Debounced autosave — 700 ms after the last keystroke lands on disk.
  useEffect(() => {
    if (fileId === null) return;
    if (value === savedValue) return; // clean — nothing to flush
    const timer = setTimeout(() => {
      const node = useGlassDesk.getState().state?.fs?.[fileId];
      const name = node?.name ?? nameFor(value);
      dispatch({
        t: "fs:upsert",
        node: {
          id: fileId,
          name,
          kind: "file",
          parent: node?.parent ?? null,
          content: value,
          updatedAt: Date.now(),
        },
      });
      setSavedValue(value);
    }, 700);
    return () => clearTimeout(timer);
  }, [value, fileId, savedValue, dispatch]);

  const saveNew = () => {
    const name = nameFor(value);
    const id = uid();
    dispatch({
      t: "fs:upsert",
      node: { id, name, kind: "file", parent: null, content: value, updatedAt: Date.now() },
    });
    loadedFileId.current = id;
    setSavedValue(value);
    dispatch({ t: "app:patch", id: win.id, patch: { fileId: id } });
    dispatch({ t: "win:title", id: win.id, title: name });
  };

  const path = fileId && fs?.[fileId] ? fsPathOf(fs, fileId) : null;

  return (
    <div className="flex h-full flex-col">
      <textarea
        value={value}
        onChange={(e) => dispatch({ t: "app:patch", id: win.id, patch: { value: e.target.value } })}
        placeholder="Start typing — both of you can edit at once…"
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-transparent p-4 font-sans text-sm leading-relaxed text-stone-700 outline-none placeholder:text-stone-400"
        aria-label="Document"
      />
      <div className="flex items-center gap-3 border-t border-white/50 bg-white/30 px-3 py-2 text-xs">
        <span className="gd-mono shrink-0 text-stone-500">{value.length} chars</span>
        {path && (
          <span className="gd-mono hidden min-w-0 truncate text-stone-400 sm:block">{path}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {fileId === null ? (
            <>
              <span className="hidden text-stone-400 sm:inline">Not on disk yet</span>
              <button
                type="button"
                onClick={saveNew}
                className="glass-sheen gd-accent-gradient flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-medium text-white transition-[filter,transform] hover:brightness-105 active:scale-[0.98]"
              >
                <Save className="size-4" />
                Save to GlassDesk HD
              </button>
            </>
          ) : saveState === "saved" ? (
            <motion.span
              key="saved"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-1.5 text-emerald-600"
            >
              <Check className="size-3.5" />
              Saved to GlassDesk HD
            </motion.span>
          ) : (
            <span className="animate-pulse text-stone-500">Saving…</span>
          )}
        </div>
      </div>
    </div>
  );
}
