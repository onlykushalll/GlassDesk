// ============================================================
// GlassDesk session-service :3030 (bun + socket.io)
//
// WAVE 12 — AnyDesk-grade reliability:
//  • SERVER-SIDE OP APPLICATION: every op AND chat message is
//    applied to room.state IN THE SERVICE (same frozen applyOp
//    reducer the clients run). room.state is therefore always
//    the freshest authoritative state — a rejoining seat can
//    never regress, and nothing typed during a disconnect is
//    lost (ops while a seat was offline are still applied and
//    replayed via the join/resume ack).
//  • SESSION TOKENS + RESUME (AnyDesk session identity): every
//    participant gets a token. Socket.io reconnects create a NEW
//    socket id — instead of "re-joining" (which raced ghosts,
//    shuffled seats and flapped host migration), the client now
//    sends `resume` with its token: the service re-attaches the
//    SAME seat identity, evicts any ghost socket still holding
//    it, and returns the newest state. Host role is bound to the
//    host TOKEN, so the original host reclaims the flusher duty
//    on resume.
//  • RETENTION: empty rooms stay warm for 30 min (in-memory,
//    ops keep applying), and the SQLite volume survives 24 h —
//    rejoining the code revives the same PC. A sweep deletes
//    volumes idle > 24 h.
//  • SERVER-SIDE FLUSH: ops mark the room dirty; a 400 ms
//    debounce persists to SQLite. Host snap:save is honored as
//    a persist trigger (the server state is authoritative). A
//    service crash loses at most 400 ms.
//  • ephemeral input/typing relays (keystroke-level mirroring,
//    exactly like the pointer channel — never persisted).
//
// Rooms keyed by 6-digit code — join-or-create. 2 seats.
// WebRTC signaling relay (rtc:offer/answer/ice → target socket).
// ============================================================

import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { Database } from "bun:sqlite";
import {
  applyOp,
  ensureMachine,
  freshDesktop,
  type ChatMessage,
  type DesktopState,
  type Op,
  type RamMB,
  type Seat,
} from "../../src/lib/vpc/types";

import { join } from "node:path";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3030;
const DB_PATH = process.env.DB_PATH || join(process.cwd(), "..", "..", "db", "custom.db");
const ROOM_TTL_MS = 30 * 60 * 1000; // warm window after everyone leaves
const VOLUME_TTL_MS = 24 * 60 * 60 * 1000; // SQLite volume retention
const GHOST_GRACE_MS = 5 * 60 * 1000; // dead-token eviction grace for new joiners
const FLUSH_DEBOUNCE_MS = 400;
const MAX_SEATS = 2;

// ---------------- database (the "GlassDesk HD" volume) ----------------

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA busy_timeout=5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS DesktopSession (
    code      TEXT PRIMARY KEY,
    state     TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS SessionParticipant (
    id       TEXT PRIMARY KEY,
    code     TEXT NOT NULL,
    name     TEXT NOT NULL,
    seat     TEXT NOT NULL,
    joinedAt TEXT NOT NULL,
    leftAt   TEXT
  )
`);

const upsertSession = db.prepare(
  `INSERT INTO DesktopSession (code, state, createdAt, updatedAt)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(code) DO UPDATE SET state = excluded.state, updatedAt = excluded.updatedAt`,
);
const loadSession = db.prepare(`SELECT state FROM DesktopSession WHERE code = ?`);
const allSessions = db.prepare(`SELECT code, updatedAt FROM DesktopSession`);
const deleteSession = db.prepare(`DELETE FROM DesktopSession WHERE code = ?`);
const insertParticipant = db.prepare(
  `INSERT INTO SessionParticipant (id, code, name, seat, joinedAt) VALUES (?, ?, ?, ?, ?)`,
);
const markLeft = db.prepare(`UPDATE SessionParticipant SET leftAt = ? WHERE id = ?`);

function nowIso(): string {
  return new Date().toISOString();
}

function persist(code: string, state: DesktopState): void {
  upsertSession.run(code, JSON.stringify(state), nowIso(), nowIso());
}

function loadPersisted(code: string): DesktopState | null {
  const row = loadSession.get(code) as { state: string } | null;
  if (!row) return null;
  try {
    return ensureMachine(JSON.parse(row.state) as DesktopState, { code });
  } catch {
    return null;
  }
}

// ---------------- rooms ----------------

interface Member {
  name: string;
  seat: Seat;
  participantId: string;
  token: string; // resume token owned by this member
  sid: string | null; // live socket id (null while disconnected)
  lastSeen: number; // last moment this member was connected
}

interface Room {
  code: string;
  members: Map<string, Member>; // token → member (seat identity survives reconnects)
  hostToken: string | null; // the host SEAT — stable across reconnects
  state: DesktopState | null;
  lastActive: number;
  dirty: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  reapTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, Room>();

/** Apply an op to the room's authoritative state (defensive — a malformed
 *  op can never crash the service or corrupt the state). */
function applyToRoom(room: Room, op: unknown): void {
  if (!room.state) return;
  if (typeof op !== "object" || op === null) return;
  const t = (op as { t?: unknown }).t;
  if (typeof t !== "string") return;
  try {
    room.state = applyOp(room.state, op as Op);
    room.dirty = true;
  } catch (err) {
    console.error(`[op] apply failed for ${room.code}:`, err);
  }
}

function scheduleFlush(room: Room): void {
  if (room.flushTimer) return;
  room.flushTimer = setTimeout(() => {
    room.flushTimer = null;
    if (!room.dirty || !room.state) return;
    try {
      persist(room.code, room.state);
      room.dirty = false;
    } catch (err) {
      console.error(`[flush] persist failed for ${room.code}:`, err);
      room.dirty = true;
      scheduleFlush(room);
    }
  }, FLUSH_DEBOUNCE_MS);
}

function stopFlush(room: Room): void {
  if (room.flushTimer) {
    clearTimeout(room.flushTimer);
    room.flushTimer = null;
  }
}

/** Persist right now (leave / host drop / shutdown paths). */
function flushNow(room: Room): void {
  stopFlush(room);
  if (!room.state) return;
  try {
    persist(room.code, room.state);
    room.dirty = false;
  } catch (err) {
    console.error(`[flush] immediate persist failed for ${room.code}:`, err);
  }
}

function peersOf(room: Room) {
  const hostSid = hostSidOf(room);
  return Array.from(room.members.entries())
    .filter(([, m]) => m.sid !== null)
    .map(([token, m]) => ({
      id: m.sid as string,
      token,
      name: m.name,
      seat: m.seat,
      host: m.sid === hostSid,
    }));
}

/** The live socket that holds the flusher/host DUTY: the host seat's
 *  socket when connected, else any connected member. */
function hostSidOf(room: Room): string | null {
  const host = room.hostToken ? room.members.get(room.hostToken) : null;
  if (host && host.sid) return host.sid;
  for (const m of room.members.values()) if (m.sid) return m.sid;
  return null;
}

function broadcastPeers(io: Server, room: Room) {
  io.to(room.code).emit("peers", { peers: peersOf(room) });
}

function stopReap(room: Room) {
  if (room.reapTimer) {
    clearTimeout(room.reapTimer);
    room.reapTimer = null;
  }
}

function reapRoom(code: string) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.members.size > 0) return; // someone came back — keep living
  stopReap(room);
  flushNow(room); // volume stays on disk for the 24 h retention window
  rooms.delete(code);
  console.log(`[reap] session ${code} went cold — volume retained ${VOLUME_TTL_MS / 3600000}h`);
}

function scheduleReap(room: Room) {
  stopReap(room);
  room.reapTimer = setTimeout(() => reapRoom(room.code), ROOM_TTL_MS);
}

function getOrCreateRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      members: new Map(),
      hostToken: null,
      state: loadPersisted(code), // retention: revive from the volume
      lastActive: Date.now(),
      dirty: false,
      flushTimer: null,
      reapTimer: null,
    };
    rooms.set(code, room);
  }
  stopReap(room);
  return room;
}

/** Evict members whose tokens have been dead past the grace window —
 *  their seat becomes claimable by a fresh joiner. */
function evictStaleMembers(room: Room): boolean {
  const now = Date.now();
  let evicted = false;
  for (const [token, m] of Array.from(room.members.entries())) {
    if (m.sid === null && now - m.lastSeen > GHOST_GRACE_MS) {
      room.members.delete(token);
      evicted = true;
      console.log(`[evict] ${room.code}: seat of "${m.name}" reclaimed (idle ${Math.round((now - m.lastSeen) / 60000)}m)`);
    }
  }
  if (evicted && room.hostToken && !room.members.has(room.hostToken)) {
    room.hostToken = room.members.keys().next().value ?? null;
  }
  return evicted;
}

function liveCount(room: Room): number {
  let n = 0;
  for (const m of room.members.values()) if (m.sid !== null) n++;
  return n;
}

// ---------------- server ----------------

const http = createServer();
const io = new Server(http, {
  path: "/",
  cors: { origin: true, methods: ["GET", "POST"] },
  maxHttpBufferSize: 2_000_000, // snapshots + fat strokes
  pingInterval: 10_000, // fast liveness detection
  pingTimeout: 20_000,
});

interface JoinAck {
  ok: boolean;
  error?: string;
  code: string;
  seat: Seat;
  selfId: string;
  token: string;
  hostId: string;
  peers: { id: string; token: string; name: string; seat: Seat; host: boolean }[];
  state: DesktopState | null;
  resumed?: boolean;
}

function ackFor(socket: Socket, room: Room, member: Member, resumed: boolean): JoinAck {
  return {
    ok: true,
    code: room.code,
    seat: member.seat,
    selfId: socket.id,
    token: member.token,
    hostId: hostSidOf(room) ?? socket.id,
    peers: peersOf(room),
    state: room.state,
    resumed,
  };
}

io.on("connection", (socket: Socket) => {
  let joinedCode: string | null = null;
  let myToken: string | null = null;

  // ---- attach a socket to a member (join or resume) ------------------
  const attach = (room: Room, member: Member): void => {
    // ghost eviction: bind OUR socket first, then cut the old one — its
    // disconnect handler no-ops because member.sid no longer matches
    const ghostSid = member.sid && member.sid !== socket.id ? member.sid : null;
    member.sid = socket.id;
    member.lastSeen = Date.now();
    joinedCode = room.code;
    myToken = member.token;
    socket.join(room.code);
    // reclaim: the host seat reclaims the host duty the moment it's back
    scheduleFlush(room);
    if (ghostSid) {
      const ghost = io.sockets.sockets.get(ghostSid);
      if (ghost) ghost.disconnect(true);
    }
  };

  socket.on("join", (data: { code?: string; name?: string; ramMB?: number; token?: string }) => {
    const code = (data.code ?? "").toString().replace(/\D/g, "").slice(0, 6);
    const name = (data.name ?? "friend").toString().slice(0, 40);
    if (code.length !== 6) {
      socket.emit("join:ack", { ok: false, error: "Session codes are 6 digits." });
      return;
    }

    const room = getOrCreateRoom(code);

    // resume path: a known token means "same seat, new socket" — never
    // a new participant. This is what makes reconnects invisible.
    if (data.token && room.members.has(data.token)) {
      const member = room.members.get(data.token)!;
      attach(room, member);
      socket.emit("join:ack", ackFor(socket, room, member, true));
      broadcastPeers(io, room);
      console.log(`[resume] ${member.name} (${member.seat}) → ${code}`);
      return;
    }

    // seat accounting: evict long-dead tokens, then claim a free seat
    evictStaleMembers(room);
    if (room.members.size >= MAX_SEATS) {
      socket.emit("join:ack", {
        ok: false,
        error: "That PC already has two people on it. Ask for a new code.",
      });
      return;
    }

    const seat: Seat = room.members.size === 0 ? "host" : "guest";
    const participantId = crypto.randomUUID();
    const token = crypto.randomUUID();
    room.members.set(token, { name, seat, participantId, token, sid: socket.id, lastSeen: Date.now() });
    if (seat === "host") room.hostToken = token;
    attach(room, room.members.get(token)!);

    // join-or-create: revive persisted state or build a fresh machine.
    if (!room.state) {
      const ramMB = ([512, 1024, 2048, 4096] as RamMB[]).includes(data.ramMB as RamMB)
        ? (data.ramMB as RamMB)
        : 2048;
      room.state = freshDesktop({ code, ramMB });
      room.dirty = true;
    } else {
      room.state = ensureMachine(room.state, { code });
    }

    insertParticipant.run(participantId, code, name, seat, nowIso());
    room.lastActive = Date.now();

    socket.emit("join:ack", ackFor(socket, room, room.members.get(token)!, false));
    broadcastPeers(io, room);
    console.log(`[join] ${name} (${seat}) → ${code} · seats ${liveCount(room)}/${MAX_SEATS}`);
  });

  // ---- canonical reconnect path --------------------------------------
  socket.on("resume", (data: { code?: string; token?: string; name?: string }) => {
    const code = (data.code ?? "").toString().replace(/\D/g, "").slice(0, 6);
    const token = (data.token ?? "").toString();
    if (code.length !== 6 || token.length === 0) {
      socket.emit("resume:ack", { ok: false, error: "bad resume" });
      return;
    }
    const room = getOrCreateRoom(code);
    const member = room.members.get(token);
    if (!member) {
      // token forgotten (service restart / eviction) → client falls back
      // to a plain join; the volume state still revived the room above.
      socket.emit("resume:ack", { ok: false, error: "stale-token" });
      return;
    }
    attach(room, member);
    socket.emit("resume:ack", ackFor(socket, room, member, true));
    broadcastPeers(io, room);
    console.log(`[resume] ${member.name} (${member.seat}) → ${code}`);
  });

  // ---- ops: relay + apply (authoritative) + ACK ----------------------
  // The per-emit acknowledgement is the reliable-input channel's
  // backbone: the client keeps every op in an inflight queue until
  // this fires. Ops lost in a dead transport (undetected outage) or
  // sent mid-auth therefore stay un-acked and retransmit after the
  // resume ack — typing is never lost. Replays are idempotent.
  socket.on("op", (data: { op?: unknown }, cb?: () => void) => {
    if (!joinedCode || !myToken) return; // pre-auth → NO ack → client replays post-resume
    const room = rooms.get(joinedCode);
    if (!room || !data.op) {
      cb?.();
      return;
    }
    applyToRoom(room, data.op); // server-side authoritative application
    socket.to(joinedCode).emit("op", { op: data.op, by: socket.id });
    room.lastActive = Date.now();
    scheduleFlush(room);
    cb?.();
  });

  socket.on("chat", (data: { msg?: unknown }, cb?: () => void) => {
    if (!joinedCode || !myToken) return; // pre-auth → NO ack → replayed
    const room = rooms.get(joinedCode);
    if (!room) {
      cb?.();
      return;
    }
    if (data.msg && typeof data.msg === "object") {
      applyToRoom(room, { t: "chat", msg: data.msg as ChatMessage });
      scheduleFlush(room);
    }
    socket.to(joinedCode).emit("chat", { msg: data.msg, by: socket.id });
    room.lastActive = Date.now();
    cb?.();
  });

  // ---- ephemeral channels (pointer / keystroke mirroring / typing) ----
  // Never applied to state, never persisted — pure relay.
  const ephemeral = (event: string) => (data: Record<string, unknown>) => {
    if (!joinedCode || !myToken) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    socket.to(joinedCode).emit(event, { ...data, from: socket.id, by: socket.id });
  };
  socket.on("pointer", ephemeral("pointer"));
  socket.on("input", ephemeral("input"));
  socket.on("typing", ephemeral("typing"));

  socket.on("snap:save", (data: { code?: string; state?: DesktopState }) => {
    if (!joinedCode || !myToken) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    // The host seat's flusher still announces durability intent — the
    // server state is at least as fresh (it applied every op), so persist
    // OUR state, never trusting a client payload wholesale.
    const member = room.members.get(myToken);
    const isHostSeat = member?.seat === "host" || room.hostToken === myToken;
    if (!isHostSeat || !room.state) return;
    void data;
    flushNow(room);
  });

  // ---- WebRTC signaling relay (targeted, never broadcast) ----
  const relay = (event: string) => (data: { to?: string; [k: string]: unknown }) => {
    if (!joinedCode || !data?.to) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    // `to` is a socket id — verify it's a live member socket
    const isMember = Array.from(room.members.values()).some((m) => m.sid === data.to);
    if (!isMember) return;
    io.to(data.to).emit(event, { ...data, from: socket.id });
  };
  socket.on("rtc:offer", relay("rtc:offer"));
  socket.on("rtc:answer", relay("rtc:answer"));
  socket.on("rtc:ice", relay("rtc:ice"));

  // ---- explicit leave (user-driven End Session) -----------------------
  socket.on("leave", () => {
    if (!joinedCode || !myToken) return;
    const room = rooms.get(joinedCode);
    if (!room) return;
    const member = room.members.get(myToken);
    if (member) {
      markLeft.run(nowIso(), member.participantId);
      room.members.delete(myToken);
    }
    if (room.hostToken === myToken) {
      room.hostToken = room.members.keys().next().value ?? null;
    }
    socket.leave(joinedCode);
    flushNow(room);
    if (room.members.size === 0) {
      scheduleReap(room);
      console.log(`[leave] ${joinedCode} empty — warm for ${ROOM_TTL_MS / 60000}m`);
    } else {
      broadcastPeers(io, room);
    }
    joinedCode = null;
    myToken = null;
  });

  socket.on("disconnect", () => {
    if (!joinedCode || !myToken) return;
    const room = rooms.get(joinedCode);
    if (!room) return;

    // NOTE: the member (and its token) STAYS — the seat identity now
    // outlives the socket. The resume protocol re-attaches it.
    const member = room.members.get(myToken);
    if (member && member.sid === socket.id) {
      member.sid = null;
      member.lastSeen = Date.now();
      markLeft.run(nowIso(), member.participantId);
    }

    if (liveCount(room) === 0) {
      flushNow(room); // nobody connected — freeze the volume NOW
      scheduleReap(room);
      console.log(`[empty] ${joinedCode} — warm ${ROOM_TTL_MS / 60000}m, volume retained`);
    } else {
      // host duty falls to whoever is connected (host TOKEN unchanged —
      // the original host reclaims it on resume)
      broadcastPeers(io, room);
    }
    joinedCode = null;
    myToken = null;
  });
});

// ---- retention sweeps -------------------------------------------------
// 1) rooms that somehow missed their reap timer
setInterval(
  () => {
    for (const room of Array.from(rooms.values())) {
      if (liveCount(room) === 0 && Date.now() - room.lastActive > ROOM_TTL_MS) {
        reapRoom(room.code);
      }
    }
  },
  60_000,
);
// 2) SQLite volumes idle past VOLUME_TTL (the 24 h retention window)
setInterval(
  () => {
    try {
      const rows = allSessions.all() as { code: string; updatedAt: string }[];
      const cutoff = Date.now() - VOLUME_TTL_MS;
      for (const row of rows) {
        const at = Date.parse(row.updatedAt);
        if (Number.isFinite(at) && at < cutoff) {
          deleteSession.run(row.code);
          console.log(`[sweep] volume ${row.code} expired (>${VOLUME_TTL_MS / 3600000}h idle)`);
        }
      }
    } catch (err) {
      console.error("[sweep] volume sweep failed:", err);
    }
  },
  30 * 60_000,
);

// ---- graceful shutdown: freeze every warm volume ----------------------
process.on("SIGINT" as string, () => {
  for (const room of rooms.values()) flushNow(room);
  process.exit(0);
});
process.on("SIGTERM" as string, () => {
  for (const room of rooms.values()) flushNow(room);
  process.exit(0);
});

http.listen(PORT, () => {
  console.log(`GlassDesk session-service on :${PORT} · volume ${DB_PATH}`);
});
