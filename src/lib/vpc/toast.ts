"use client";

// ============================================================
// GlassDesk — notifications. LOCAL only (never synced): every
// seat renders its own toasts from the ops it applies, so no
// new op type is needed. `pushToast()` is the public API used
// by apps (files/terminal/etc.); the bell badge + NotifCenter
// read the same store.
// ============================================================

import { create } from "zustand";

export type ToastKind = "info" | "success" | "warn" | "danger";

export interface GdToast {
  id: number;
  title: string;
  body?: string;
  kind: ToastKind;
  at: number;
}

const VISIBLE_CAP = 3; // stacked on screen at once
const HISTORY_CAP = 40; // kept in the notification center

let nextId = 1;

interface ToastStore {
  visible: GdToast[]; // on-screen stack (newest last)
  history: GdToast[]; // newest first, capped
  seenCount: number; // how many the user has read in the center
  push: (t: { title: string; body?: string; kind?: ToastKind }) => void;
  dismiss: (id: number) => void;
  clearAll: () => void;
  markSeen: () => void;
}

export const useToasts = create<ToastStore>((set) => ({
  visible: [],
  history: [],
  seenCount: 0,

  push: ({ title, body, kind = "info" }) => {
    const toast: GdToast = { id: nextId++, title, body, kind, at: Date.now() };
    set((s) => ({
      visible: [...s.visible, toast].slice(-VISIBLE_CAP),
      history: [toast, ...s.history].slice(0, HISTORY_CAP),
    }));
  },

  dismiss: (id) => set((s) => ({ visible: s.visible.filter((t) => t.id !== id) })),

  clearAll: () => set({ history: [], seenCount: 0 }),

  markSeen: () => set((s) => ({ seenCount: s.history.length })),
}));

/** Fire-and-forget toast from anywhere (apps, watchers, …). */
export function pushToast(t: { title: string; body?: string; kind?: ToastKind }): void {
  useToasts.getState().push(t);
}

/** Unread count for the taskbar bell. */
export function toastUnread(history: GdToast[], seenCount: number): number {
  return Math.max(0, history.length - seenCount);
}
