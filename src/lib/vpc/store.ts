"use client";

// ============================================================
// GlassDesk sync core — zustand store + socket.io lifecycle.
//
// MODEL (wave 12 — AnyDesk-grade):
//  • local-apply-first: dispatch(op) mutates own state instantly
//    (0 perceived latency), then relays the op to the service.
//  • SERVER-AUTHORITATIVE state: the service applies every op to
//    its own copy too, so join/resume acks are always the newest
//    truth — reconnecting can never regress or lose peer edits.
//  • SESSION TOKENS: every participant gets a resume token. On
//    socket.io reconnect we send `resume` — the service re-attaches
//    the same seat (host role included) and evicts ghost sockets.
//    No seat shuffling, no "two people" rejections, no host flap.
//  • OFFLINE OP QUEUE: ops dispatched while disconnected are queued
//    and flushed after a successful resume — typing made during a
//    network blip is NEVER lost (socket.io's own buffer is useless
//    here because the server drops pre-join packets).
//  • EPHEMERAL CHANNELS: pointer, keystroke mirroring (`input`) and
//    chat typing indicators relay like pointer events — instant,
//    never persisted, never part of DesktopState.
//  • RETENTION: the token+code live in sessionStorage; a reload
//    auto-resumes the same session, same seat, newest state.
// ============================================================

import { create } from "zustand";
import { io, type Socket } from "socket.io-client";
import { applyOp, uid, type ChatMessage, type DesktopState, type Op, type RamMB, type Seat } from "./types";

export type PeerInfo = { id: string; name: string; seat: Seat; host: boolean };
export type CursorInfo = { id: string; name: string; x: number; y: number; at: number };
export type InputGhost = { key: string; text: string; from: string; name: string; at: number };
export type Phase = "landing" | "session";

const SNAP_DEBOUNCE_MS = 1500;
const NAME_KEY = "gd:name";
const SESSION_KEY = "gd:session"; // { code, token, name }
const POINTER_MIN_MS = 16; // ~60Hz
const INPUT_MIN_MS = 16; // keystroke mirroring at most every 16ms
const TYPING_MIN_MS = 400;
const GHOST_TTL_MS = 5000;

type SocketLike = Socket;

interface AckPayload {
  ok: boolean;
  error?: string;
  code: string;
  seat: Seat;
  selfId: string;
  token?: string;
  hostId: string;
  peers: PeerInfo[];
  state: DesktopState | null;
  resumed?: boolean;
}

interface GlassDeskStore {
  phase: Phase;
  code: string;
  name: string;
  seat: Seat | null;
  selfId: string | null;
  connected: boolean;
  status: "idle" | "connecting" | "live" | "reconnecting";
  error: string | null;
  peers: Record<string, PeerInfo>; // ALL seats incl. self (selfId marks own)
  cursors: Record<string, CursorInfo>;
  state: DesktopState | null;
  unread: number;
  /** keystroke mirroring — ephemeral, keyed by app-chosen ids */
  inputs: Record<string, InputGhost>;
  /** chat typing indicator for the peer seat */
  peerTyping: { name: string; at: number } | null;

  create: (code: string, name: string, opts?: { ramMB?: RamMB }) => void;
  join: (code: string, name: string) => void;
  leave: () => void;
  dispatch: (op: Op) => void;
  nextZ: () => number;
  sendChat: (text: string) => void;
  sendPointer: (x: number, y: number) => void;
  sendInput: (key: string, text: string) => void;
  sendTyping: () => void;
  markChatRead: () => void;
  clearError: () => void;
}

// module-level mutable refs (never reactive)
let socket: SocketLike | null = null;
let dirty = false;
let firstDirtyAt = 0; // flush-starvation guard — see scheduleFlush
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastPointerAt = 0;
let lastInputAt = 0;
let lastTypingAt = 0;
let currentCode = "";
let currentName = "";
let currentRam: RamMB | undefined;
let resumeToken: string | null = null; // session token for reconnects
let resuming = false; // a resume attempt is in flight

// ---------------------------------------------------------------------
// RELIABLE INPUT CHANNEL (AnyDesk-style retransmission).
// Every dispatched op / sent chat lives in `inflight` until the
// SERVICE acknowledges it (socket.io per-emit callbacks). Anything
// un-acknowledged — typed during an outage the client hadn't noticed
// (packets written into a dead transport simply vanish), typed while
// disconnected, or typed mid-auth — is RETRANSMITTED right after the
// resume ack lands. Ops are idempotent (absolute patches, id-deduped
// opens/chats), so replays are always safe.
// ---------------------------------------------------------------------
interface InflightOp {
  op: Op;
  at: number;
}
const inflightOps: InflightOp[] = [];
const inflightChats: ChatMessage[] = [];
const INFLIGHT_CAP = 300;
const INFLIGHT_STALE_MS = 60_000; // don't retransmit ancient history

/** Queue an op for reliable delivery. Returns the (identity-stable)
 *  record so ack callbacks can remove exactly their own op. */
function queueOp(op: Op): InflightOp {
  const rec = { op, at: Date.now() };
  inflightOps.push(rec);
  if (inflightOps.length > INFLIGHT_CAP) inflightOps.splice(0, inflightOps.length - INFLIGHT_CAP);
  return rec;
}

function queueChat(msg: ChatMessage): ChatMessage {
  inflightChats.push(msg);
  if (inflightChats.length > INFLIGHT_CAP) inflightChats.splice(0, inflightChats.length - INFLIGHT_CAP);
  return msg;
}

/** Emit an op with a per-emit acknowledgement — the callback removes
 *  the record from the inflight queue the moment the service confirms
 *  receipt+application. Lost acks are harmless (the replay is a
 *  deduped no-op on the server). */
function emitOp(sock: SocketLike, rec: InflightOp): void {
  sock.emit("op", { op: rec.op }, () => {
    const i = inflightOps.indexOf(rec);
    if (i >= 0) inflightOps.splice(i, 1);
  });
}

function emitChat(sock: SocketLike, msg: ChatMessage): void {
  sock.emit("chat", { msg }, () => {
    const i = inflightChats.indexOf(msg);
    if (i >= 0) inflightChats.splice(i, 1);
  });
}

function persistName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode etc */
  }
}

export function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Saved session identity — survives reloads for auto-resume. */
function loadSavedSession(): { code: string; token: string; name: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { code?: string; token?: string; name?: string };
    if (typeof parsed.code === "string" && typeof parsed.token === "string" && typeof parsed.name === "string") {
      return { code: parsed.code, token: parsed.token, name: parsed.name };
    }
  } catch {
    /* corrupted — ignore */
  }
  return null;
}

function saveSession(code: string, token: string, name: string) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, token, name }));
  } catch {
    /* private mode */
  }
}

function clearSavedSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}

/** Auto-resume on reload: the saved session wins only when no URL
 *  deep-link is fighting for attention (App.tsx decides). */
export function savedSession(): { code: string; token: string; name: string } | null {
  return loadSavedSession();
}

function scheduleFlush(get: () => GlassDeskStore) {
  if (flushTimer) clearTimeout(flushTimer);
  // MAX-WAIT debounce: continuous op streams (2Hz playhead publishers)
  // would starve a plain debounce forever — cap the total wait so a flush
  // lands at most SNAP_DEBOUNCE_MS after the FIRST dirty op.
  const sinceFirst = firstDirtyAt ? Date.now() - firstDirtyAt : 0;
  const wait = Math.max(0, Math.min(SNAP_DEBOUNCE_MS, SNAP_DEBOUNCE_MS - sinceFirst));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const s = get();
    if (!dirty) {
      firstDirtyAt = 0;
      return;
    }
    if (s.seat !== "host" || !s.connected || !s.state || !socket) {
      // can't flush right now — retry soon (host migration may hand us duty)
      firstDirtyAt = Date.now();
      scheduleFlush(get);
      return;
    }
    socket.emit("snap:save", { code: s.code, state: s.state });
    dirty = false;
    firstDirtyAt = 0;
  }, wait);
}

function markDirty(get: () => GlassDeskStore) {
  dirty = true;
  if (!firstDirtyAt) firstDirtyAt = Date.now();
  const s = get();
  if (s.seat === "host") scheduleFlush(get);
}

export const useGlassDesk = create<GlassDeskStore>((set, get) => {
  /** Shared ack handling for join + resume — the newest authoritative
   *  state replaces local, then every UNACKNOWLEDGED op/chat (typed
   *  during an outage, or in flight when it hit) is re-applied and
   *  retransmitted — the reliable-input-channel replay. */
  const onAck = (ack: AckPayload, sock: SocketLike) => {
    if (!ack.ok) return false;
    resuming = false; // auth complete — dispatches emit directly again
    // splice the replay set: only FRESH unacked work (stale history
    // would needlessly overwrite newer peer edits)
    const now = Date.now();
    const replayOps = inflightOps.filter((r) => now - r.at < INFLIGHT_STALE_MS);
    const replayChats = inflightChats.filter(
      (m) => now - m.at < INFLIGHT_STALE_MS,
    );
    inflightOps.length = 0;
    inflightChats.length = 0;
    let next: DesktopState | null = ack.state ?? null;
    // replay: these edits were local-only until now
    for (const r of replayOps) {
      if (next) next = applyOp(next, r.op);
    }
    for (const msg of replayChats) {
      if (next) next = applyOp(next, { t: "chat", msg });
    }
    set({
      phase: "session",
      code: ack.code,
      seat: ack.seat,
      selfId: ack.selfId,
      peers: Object.fromEntries(ack.peers.map((p) => [p.id, p])),
      state: next,
      connected: true,
      status: "live",
      error: null,
      unread: 0,
    });
    if (ack.token) {
      resumeToken = ack.token;
      saveSession(ack.code, ack.token, get().name);
    }
    // retransmit — each emit re-arms its own ack-based removal
    for (const r of replayOps) {
      inflightOps.push(r);
      emitOp(sock, r);
    }
    for (const msg of replayChats) {
      inflightChats.push(msg);
      emitChat(sock, msg);
    }
    if (ack.seat === "host") markDirty(get); // guarantee fresh state lands in SQLite
    return true;
  };

  const attach = (sock: SocketLike) => {
    sock.on("connect", () => {
      set({ connected: true });
      // auth in flight (resume or join) — until the ack lands, every
      // dispatch is QUEUED, never emitted: the server drops pre-auth
      // packets, so emitting during this window would lose them
      resuming = true;
      // discard socket.io's own offline buffer — our reliable inflight
      // queue (ack-driven retransmission) is the real offline bridge
      try {
        sock.sendBuffer = [];
      } catch {
        /* older socket.io typings */
      }
      // session identity: resume the same seat when we hold a token,
      // otherwise a plain join. Failed resumes fall back to join below.
      if (resumeToken) {
        sock.emit("resume", { code: currentCode, token: resumeToken, name: currentName });
      } else {
        sock.emit("join", { code: currentCode, name: currentName, ramMB: currentRam });
      }
    });

    sock.on("join:ack", (ack: AckPayload) => {
      if (!ack.ok) {
        resuming = false;
        inflightOps.length = 0;
        inflightChats.length = 0;
        set({ error: ack.error ?? "Could not join that session.", status: "idle", phase: "landing" });
        sock.disconnect();
        return;
      }
      onAck(ack, sock);
    });

    sock.on("resume:ack", (ack: AckPayload) => {
      if (!ack.ok) {
        // token forgotten (service restart / eviction) → plain join; the
        // volume already revived the room server-side. resuming STAYS
        // true — the join is now the auth in flight
        resumeToken = null;
        sock.emit("join", { code: currentCode, name: currentName, ramMB: currentRam });
        return;
      }
      onAck(ack, sock);
    });

    sock.on("op", ({ op }: { op: Op }) => {
      const s = get();
      if (!s.state) return;
      set({ state: applyOp(s.state, op) });
      markDirty(get); // ANY op dirties — peer edits must survive rejoin
    });

    sock.on("chat", ({ msg }: { msg: ChatMessage }) => {
      const s = get();
      if (!s.state) return;
      set({ state: applyOp(s.state, { t: "chat", msg }), unread: s.unread + 1 });
      markDirty(get);
      if (msg.fromId !== s.selfId) set({ peerTyping: null });
    });

    sock.on("peers", ({ peers }: { peers: PeerInfo[] }) => {
      const s = get();
      const nextPeers = Object.fromEntries(peers.map((p) => [p.id, p]));
      const me = s.selfId ? nextPeers[s.selfId] : undefined;
      const nextCursors = { ...s.cursors };
      for (const id of Object.keys(nextCursors)) if (!nextPeers[id]) delete nextCursors[id];
      set({ peers: nextPeers, cursors: nextCursors, seat: me?.seat ?? s.seat });
      if (me && me.seat !== s.seat) {
        // host migration — new host must pick up the flusher duty
        markDirty(get);
      }
    });

    sock.on("pointer", ({ id, name, x, y }: { id: string; name: string; x: number; y: number }) => {
      const s = get();
      set({ cursors: { ...s.cursors, [id]: { id, name, x, y, at: Date.now() } } });
    });

    // keystroke mirroring — ephemeral drafts from the peer seat
    sock.on("input", ({ key, text, from, name }: { key: string; text: string; from: string; name?: string }) => {
      if (typeof key !== "string" || typeof text !== "string") return;
      const s = get();
      if (from === s.selfId) return;
      set({ inputs: { ...s.inputs, [key]: { key, text, from, name: name ?? "peer", at: Date.now() } } });
    });

    // chat typing indicator
    sock.on("typing", ({ from, name }: { from: string; name?: string }) => {
      const s = get();
      if (from === s.selfId) return;
      set({ peerTyping: { name: name ?? "peer", at: Date.now() } });
    });

    sock.on("disconnect", () => {
      // nothing to rescue: un-acked ops are already tracked in the
      // inflight queue — they retransmit after the resume ack
      const s = get();
      if (s.phase === "session") set({ connected: false, status: "reconnecting" });
    });

    sock.on("connect_error", () => {
      const s = get();
      if (s.phase === "session") set({ status: "reconnecting" });
    });
  };

  const connect = (code: string, name: string, ramMB?: RamMB) => {
    const cleanCode = code.trim().replace(/\D/g, "");
    const cleanName = name.trim();
    if (!cleanName) {
      set({ error: "Add your name first — your co-pilot sees it in the call." });
      return;
    }
    if (cleanCode.length !== 6) {
      set({ error: "Session codes are 6 digits." });
      return;
    }
    persistName(cleanName);
    currentCode = cleanCode;
    currentName = cleanName;
    currentRam = ramMB;
    inflightOps.length = 0;
    inflightChats.length = 0;

    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    set({ status: "connecting", error: null, name: cleanName, code: cleanCode });

    // resume identity: a saved token for THIS code re-attaches our seat
    const saved = loadSavedSession();
    resumeToken = saved && saved.code === cleanCode ? saved.token : null;

    // IMPORTANT: relative URL + XTransformPort query so the Caddy gateway
    // routes us to the session-service on :3030. Never an absolute URL.
    socket = io("/?XTransformPort=3030", {
      path: "/",
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 2500,
      timeout: 8000,
    });
    attach(socket);
  };

  return {
    phase: "landing",
    code: "",
    name: "",
    seat: null,
    selfId: null,
    connected: false,
    status: "idle",
    error: null,
    peers: {},
    cursors: {},
    state: null,
    unread: 0,
    inputs: {},
    peerTyping: null,

    create: (code, name, opts) => connect(code, name, opts?.ramMB),
    join: (code, name) => connect(code, name, undefined),

    leave: () => {
      // flush now if we are the host — don't lose the last 1.5s
      const s = get();
      if (s.seat === "host" && s.state && socket?.connected) {
        socket.emit("snap:save", { code: s.code, state: s.state });
      }
      // explicit leave: free the seat immediately + freeze the volume
      if (socket?.connected) socket.emit("leave", {});
      dirty = false;
      firstDirtyAt = 0;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      inflightOps.length = 0;
      inflightChats.length = 0;
      resumeToken = null;
      resuming = false;
      clearSavedSession();
      if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
      }
      currentCode = "";
      currentName = "";
      currentRam = undefined;
      set({
        phase: "landing",
        code: "",
        seat: null,
        selfId: null,
        connected: false,
        status: "idle",
        error: null,
        peers: {},
        cursors: {},
        state: null,
        unread: 0,
        inputs: {},
        peerTyping: null,
      });
    },

    dispatch: (op) => {
      const s = get();
      if (!s.state) return;
      set({ state: applyOp(s.state, op) }); // local-apply-first → 0 latency feel
      markDirty(get);
      // reliable input channel: the op is tracked until the service
      // ACKS it. Emitted now when we're post-auth; otherwise it rides
      // the queue and retransmits after the resume ack. Ops written
      // into a dead-but-undetected transport stay un-acked → replayed.
      const rec = queueOp(op);
      if (socket?.connected && !resuming) emitOp(socket, rec);
    },

    nextZ: () => {
      const s = get();
      if (!s.state) return 10;
      return s.state.windows.reduce((m, w) => Math.max(m, w.z), 0) + 10;
    },

    sendChat: (text) => {
      const s = get();
      const clean = text.trim();
      if (!clean || !s.selfId) return;
      const msg: ChatMessage = {
        id: uid(),
        fromId: s.selfId,
        from: s.name,
        text: clean.slice(0, 500),
        at: Date.now(),
      };
      if (s.state) set({ state: applyOp(s.state, { t: "chat", msg }) });
      markDirty(get);
      // same reliable channel as ops — acked or retransmitted after resume
      const queued = queueChat(msg);
      if (socket?.connected && !resuming) emitChat(socket, queued);
      set({ peerTyping: null });
    },

    sendPointer: (x, y) => {
      if (!socket?.connected) return; // ephemeral — no point buffering
      const now = Date.now();
      if (now - lastPointerAt < POINTER_MIN_MS) return; // ~60Hz cap
      lastPointerAt = now;
      socket.emit("pointer", { x, y });
    },

    sendInput: (key, text) => {
      if (!socket?.connected) return; // ephemeral keystroke mirroring
      const now = Date.now();
      if (now - lastInputAt < INPUT_MIN_MS) return;
      lastInputAt = now;
      socket.emit("input", { key, text, name: get().name });
    },

    sendTyping: () => {
      if (!socket?.connected) return;
      const now = Date.now();
      if (now - lastTypingAt < TYPING_MIN_MS) return;
      lastTypingAt = now;
      socket.emit("typing", { name: get().name });
    },

    markChatRead: () => set({ unread: 0 }),
    clearError: () => set({ error: null }),
  };
});

// ghost sweep: drop stale ephemeral inputs/typing so the record never
// grows unbounded (freshness is additionally checked by consumers).
if (typeof window !== "undefined") {
  window.setInterval(() => {
    const s = useGlassDesk.getState();
    const cutoff = Date.now() - GHOST_TTL_MS;
    let changed = false;
    const inputs: Record<string, InputGhost> = {};
    for (const [k, v] of Object.entries(s.inputs)) {
      if (v.at >= cutoff) inputs[k] = v;
      else changed = true;
    }
    const peerTyping = s.peerTyping && s.peerTyping.at >= cutoff - 1000 ? s.peerTyping : null;
    if (changed || peerTyping !== s.peerTyping) useGlassDesk.setState({ inputs, peerTyping });
  }, 2000);
}

// QA hook: window.__gd.getState().state.machine — used by browser evals.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__gd = useGlassDesk;
}

// Access to the live session socket for co-modules (WebRTC signaling).
// The peers map is derived from THIS socket, so if a peer is listed,
// their socket is in the room — signaling relays can never race.
export function sessionSocket(): SocketLike | null {
  return socket;
}
