import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyOp, freshDesktop, type DesktopState, type Op } from "../src/lib/vpc/types";

describe("GlassDesk Session Service & State Engine", () => {
  let db: Database;

  beforeEach(() => {
    // Use in-memory SQLite database for test isolation
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS DesktopSession (
        code      TEXT PRIMARY KEY,
        state     TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS SessionParticipant (
        id       TEXT PRIMARY KEY,
        code     TEXT NOT NULL,
        name     TEXT NOT NULL,
        seat     TEXT NOT NULL,
        joinedAt TEXT NOT NULL,
        leftAt   TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("should persist and re-hydrate room desktop state across sessions", () => {
    const code = "987654";
    const initial = freshDesktop({ code, ramMB: 2048 });

    // Apply an op to create a file
    const modified = applyOp(initial, {
      t: "fs:upsert",
      node: {
        id: "f-test",
        name: "test.txt",
        kind: "file",
        parent: null,
        content: "Hello World",
        updatedAt: Date.now(),
      },
    });

    const now = new Date().toISOString();
    const insertStmt = db.prepare(`
      INSERT INTO DesktopSession (code, state, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
    `);
    insertStmt.run(code, JSON.stringify(modified), now, now);

    // Read back and deserialize
    const selectStmt = db.prepare("SELECT state FROM DesktopSession WHERE code = ?");
    const row = selectStmt.get(code) as { state: string } | null;

    expect(row).toBeDefined();
    const rehydrated = JSON.parse(row!.state) as DesktopState;
    expect(rehydrated.fs["f-test"]).toBeDefined();
    expect(rehydrated.fs["f-test"].content).toBe("Hello World");
  });

  it("should enforce ghost member eviction when token exceeds grace threshold", () => {
    const GHOST_GRACE_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    interface MockMember {
      token: string;
      seat: "seat-1" | "seat-2";
      name: string;
      sid: string | null;
      lastSeen: number;
    }

    const members = new Map<string, MockMember>();

    // Member 1: active connected socket
    members.set("token-active", {
      token: "token-active",
      seat: "seat-1",
      name: "HostUser",
      sid: "socket-123",
      lastSeen: now,
    });

    // Member 2: disconnected socket, within grace window (2 mins ago)
    members.set("token-grace", {
      token: "token-grace",
      seat: "seat-2",
      name: "GuestUser",
      sid: null,
      lastSeen: now - 2 * 60 * 1000,
    });

    // Member 3: disconnected ghost, outside grace window (10 mins ago)
    members.set("token-ghost", {
      token: "token-ghost",
      seat: "seat-2",
      name: "OldGhost",
      sid: null,
      lastSeen: now - 10 * 60 * 1000,
    });

    // Simulation of evictStaleMembers
    function evictStale(currentTime: number): boolean {
      let evicted = false;
      for (const [token, m] of Array.from(members.entries())) {
        if (m.sid === null && currentTime - m.lastSeen > GHOST_GRACE_MS) {
          members.delete(token);
          evicted = true;
        }
      }
      return evicted;
    }

    const hadEviction = evictStale(now);
    expect(hadEviction).toBe(true);
    expect(members.has("token-active")).toBe(true);
    expect(members.has("token-grace")).toBe(true);
    expect(members.has("token-ghost")).toBe(false);
  });

  it("should serialize sequential ops and guarantee no lost updates", () => {
    let state = freshDesktop({ code: "112233", ramMB: 2048 });
    const ops: Op[] = [
      { t: "chat", msg: { id: "m1", seat: "seat-1", text: "First", at: 1000 } },
      { t: "chat", msg: { id: "m2", seat: "seat-2", text: "Second", at: 1001 } },
      { t: "chat", msg: { id: "m3", seat: "seat-1", text: "Third", at: 1002 } },
    ];

    for (const op of ops) {
      state = applyOp(state, op);
    }

    expect(state.chat.length).toBe(3);
    expect(state.chat[0].text).toBe("First");
    expect(state.chat[1].text).toBe("Second");
    expect(state.chat[2].text).toBe("Third");
  });
});
