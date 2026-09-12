"use client";

// ============================================================
// GlassDesk — 2048. LOCAL play: the board lives in local state
// (high-frequency moves never hit the wire); only the BEST
// score checkpoints into the synced payload. Tiles SLIDE with
// framer-motion springs (animate left/top per tile id) and
// merged tiles double with a springy pop — the wow factor.
//
// Controls: arrow keys (honored only while this window is the
// top window on the active workspace) + swipe on touch.
// Undo restores exactly one move.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring } from "framer-motion";
import { RotateCcw, Trophy, Undo2 } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import type { WindowState } from "@/lib/vpc/types";

interface Tile {
  id: number;
  v: number;
  r: number;
  c: number;
}
interface Ghost {
  id: number;
  v: number;
  fromR: number;
  fromC: number;
  toR: number;
  toC: number;
}
type Dir = "up" | "down" | "left" | "right";

const SIZE = 4;
const TARGET = 2048;
const SPRING = { type: "spring", stiffness: 380, damping: 28 } as const;
const POP = { type: "spring", stiffness: 480, damping: 22 } as const;

/** Subtle count-up for score digits. */
function AnimatedNum({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const mv = useMotionValue(value);
  const sp = useSpring(mv, { stiffness: 400, damping: 30 });
  useEffect(() => {
    mv.set(value);
  }, [value, mv]);
  useEffect(() => sp.on("change", (v) => setDisplay(Math.round(v))), [sp]);
  return <span className="tabular-nums">{display}</span>;
}

function tileCls(v: number): string {
  switch (v) {
    case 2:
      return "bg-stone-100 text-stone-700";
    case 4:
      return "bg-amber-100 text-stone-700";
    case 8:
      return "bg-amber-300 text-stone-800";
    case 16:
      return "bg-amber-400 text-white";
    case 32:
      return "bg-rose-400 text-white";
    case 64:
      return "bg-rose-500 text-white";
    case 128:
      return "bg-teal-400 text-white";
    case 256:
      return "bg-teal-500 text-white";
    case 512:
      return "bg-emerald-500 text-white";
    case 1024:
      return "bg-emerald-600 text-white";
    default:
      return "gd-accent-gradient text-white shadow-[0_0_22px_rgba(20,184,166,0.5)]";
  }
}

function txtCls(v: number): string {
  if (v >= 10000) return "text-base";
  if (v >= 1000) return "text-xl";
  if (v >= 100) return "text-2xl";
  return "text-3xl";
}

/** Standard 2048 move — compacts each line toward the edge,
 *  merges equal neighbours once, reports absorbed tiles. */
function moveTiles(tiles: Tile[], dir: Dir): {
  tiles: Tile[];
  absorbed: Ghost[];
  gained: number;
  moved: boolean;
} {
  const vertical = dir === "up" || dir === "down";
  const forward = dir === "left" || dir === "up";
  const next: Tile[] = [];
  const absorbed: Ghost[] = [];
  let gained = 0;
  let moved = false;

  for (let line = 0; line < SIZE; line++) {
    const inLine = tiles
      .filter((t) => (vertical ? t.c === line : t.r === line))
      .sort((a, b) => (vertical ? a.r - b.r : a.c - b.c) * (forward ? 1 : -1));
    const out: Tile[] = [];
    let i = 0;
    while (i < inLine.length) {
      const a = inLine[i];
      if (i + 1 < inLine.length && inLine[i + 1].v === a.v) {
        const b = inLine[i + 1];
        const pos = out.length;
        const merged: Tile = {
          id: a.id,
          v: a.v * 2,
          r: vertical ? (forward ? pos : SIZE - 1 - pos) : line,
          c: vertical ? line : forward ? pos : SIZE - 1 - pos,
        };
        out.push(merged);
        absorbed.push({ id: b.id, v: b.v, fromR: b.r, fromC: b.c, toR: merged.r, toC: merged.c });
        gained += merged.v;
        moved = true; // a merge always displaces the second tile
        i += 2;
      } else {
        const pos = out.length;
        const t: Tile = {
          ...a,
          r: vertical ? (forward ? pos : SIZE - 1 - pos) : line,
          c: vertical ? line : forward ? pos : SIZE - 1 - pos,
        };
        if (t.r !== a.r || t.c !== a.c) moved = true;
        out.push(t);
        i += 1;
      }
    }
    next.push(...out);
  }
  return { tiles: next, absorbed, gained, moved };
}

function canMove(tiles: Tile[]): boolean {
  if (tiles.length < SIZE * SIZE) return true;
  const grid = new Map<string, number>(tiles.map((t) => [`${t.r},${t.c}`, t.v]));
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = grid.get(`${r},${c}`);
      if (v === undefined) return true;
      if (c < SIZE - 1 && grid.get(`${r},${c + 1}`) === v) return true;
      if (r < SIZE - 1 && grid.get(`${r + 1},${c}`) === v) return true;
    }
  }
  return false;
}

export default function G2048App({ win }: { win: WindowState }) {
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;
  const p = w.payload ?? {};
  const best = typeof p.best === "number" && p.best >= 0 ? Math.floor(p.best) : 0;

  // keyboard focus guard: only this window may take keys
  const active = useGlassDesk((s) => {
    const d = s.state;
    if (!d) return false;
    let topZ = -1;
    let topId: string | null = null;
    for (const wnd of d.windows) {
      if (wnd.minimized) continue;
      if ((wnd.workspace ?? 0) !== d.workspace) continue;
      if (wnd.z > topZ) {
        topZ = wnd.z;
        topId = wnd.id;
      }
    }
    return topId === win.id;
  });

  // ---- local game state (refs = truth, states = mirror) ----
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [won, setWon] = useState(false);
  const [keepGoing, setKeepGoing] = useState(false);
  const [undo, setUndo] = useState<{ tiles: Tile[]; score: number } | null>(null);

  const idRef = useRef(0);
  const tilesRef = useRef<Tile[]>([]);
  const scoreRef = useRef(0);
  const overRef = useRef(false);
  const wonRef = useRef(false);
  const keepGoingRef = useRef(false);
  const bestRef = useRef(best);
  const beatBestRef = useRef(false);
  const ghostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);
  useEffect(() => {
    scoreRef.current = score;
  }, [score]);
  useEffect(() => {
    overRef.current = over;
  }, [over]);
  useEffect(() => {
    wonRef.current = won;
  }, [won]);
  useEffect(() => {
    keepGoingRef.current = keepGoing;
  }, [keepGoing]);
  useEffect(() => {
    bestRef.current = best;
  }, [best]);

  const spawn = useCallback((board: Tile[]): Tile => {
    idRef.current += 1;
    const free: [number, number][] = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!board.some((t) => t.r === r && t.c === c)) free.push([r, c]);
      }
    }
    const [r, c] = free[Math.floor(Math.random() * free.length)] ?? [0, 0];
    return { id: idRef.current, v: Math.random() < 0.9 ? 2 : 4, r, c };
  }, []);

  const newGame = useCallback(() => {
    const first = spawn([]);
    const second = spawn([first]);
    const next = [first, second];
    tilesRef.current = next;
    scoreRef.current = 0;
    overRef.current = false;
    wonRef.current = false;
    keepGoingRef.current = false;
    beatBestRef.current = false;
    if (ghostTimer.current) clearTimeout(ghostTimer.current);
    setTiles(next);
    setGhosts([]);
    setScore(0);
    setOver(false);
    setWon(false);
    setKeepGoing(false);
    setUndo(null);
  }, [spawn]);

  // seed a game on first mount (local play — fresh board per seat)
  useEffect(() => {
    newGame();
  }, [newGame]);

  const doMove = useCallback(
    (dir: Dir) => {
      if (overRef.current || (wonRef.current && !keepGoingRef.current)) return;
      const res = moveTiles(tilesRef.current, dir);
      if (!res.moved) return;

      setUndo({ tiles: tilesRef.current, score: scoreRef.current });
      const withSpawn = [...res.tiles, spawn(res.tiles)];
      const newScore = scoreRef.current + res.gained;

      tilesRef.current = withSpawn;
      scoreRef.current = newScore;
      setTiles(withSpawn);
      setScore(newScore);

      // absorbed tiles ghost-slide into their merge target, then fade
      setGhosts(res.absorbed);
      if (ghostTimer.current) clearTimeout(ghostTimer.current);
      ghostTimer.current = setTimeout(() => setGhosts([]), 240);

      if (!wonRef.current && res.tiles.some((t) => t.v >= TARGET)) {
        wonRef.current = true;
        setWon(true);
      }
      if (!canMove(withSpawn)) {
        overRef.current = true;
        setOver(true);
      }
      if (newScore > bestRef.current) {
        if (!beatBestRef.current && bestRef.current > 0) {
          beatBestRef.current = true;
          pushToast({ title: "New best! 🏆", body: `2048 record — ${newScore} points`, kind: "success" });
        }
        bestRef.current = newScore;
        dispatch({ t: "app:patch", id: win.id, patch: { best: newScore } });
      }
    },
    [dispatch, win.id, spawn],
  );

  const undoMove = () => {
    if (!undo) return;
    tilesRef.current = undo.tiles;
    scoreRef.current = undo.score;
    overRef.current = false;
    setTiles(undo.tiles);
    setScore(undo.score);
    setOver(false);
    setUndo(null);
    setGhosts([]);
  };

  // keyboard (guarded: only while this window is the active one)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && target.closest("input,textarea,select,[contenteditable=true]")) return;
      const map: Record<string, Dir> = {
        arrowup: "up",
        arrowdown: "down",
        arrowleft: "left",
        arrowright: "right",
        w: "up",
        s: "down",
        a: "left",
        d: "right",
      };
      const dir = map[e.key.toLowerCase()];
      if (dir) {
        e.preventDefault(); // never scroll the desktop while playing
        doMove(dir);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, doMove]);

  const showWin = won && !keepGoing;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-3">
      {/* score bar */}
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <div className="glass rounded-lg px-3 py-1.5 text-sm font-semibold text-stone-700">
          Score <AnimatedNum value={score} />
        </div>
        <div className="glass flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold tabular-nums text-stone-700">
          <Trophy className="size-3.5 text-amber-500" aria-hidden /> {Math.max(best, score)}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <motion.button
            type="button"
            whileTap={{ scale: 0.92 }}
            transition={SPRING}
            onClick={undoMove}
            disabled={!undo}
            aria-label="Undo last move"
            className="glass grid size-8 place-items-center rounded-lg text-stone-600 outline-none transition-colors hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-teal-400 disabled:opacity-40"
          >
            <Undo2 className="size-4" />
          </motion.button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.92 }}
            transition={SPRING}
            onClick={newGame}
            aria-label="New game"
            className="glass grid size-8 place-items-center rounded-lg text-stone-600 outline-none transition-colors hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-teal-400"
          >
            <RotateCcw className="size-4" />
          </motion.button>
        </div>
      </div>

      {/* board */}
      <div className="grid min-h-0 flex-1 place-items-center overflow-hidden">
        <div
          className="relative aspect-square w-full max-w-[340px] touch-none select-none rounded-2xl bg-white/25 p-2 shadow-[inset_0_2px_12px_rgba(31,41,55,0.12)]"
          role="group"
          aria-label="2048 board"
          onPointerDown={(e) => {
            swipeStart.current = { x: e.clientX, y: e.clientY };
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* pointer already released — the plain up handler still works */
            }
          }}
          onPointerUp={(e) => {
            const s = swipeStart.current;
            swipeStart.current = null;
            if (!s) return;
            const dx = e.clientX - s.x;
            const dy = e.clientY - s.y;
            if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
            if (Math.abs(dx) > Math.abs(dy)) doMove(dx > 0 ? "right" : "left");
            else doMove(dy > 0 ? "down" : "up");
          }}
          onPointerCancel={() => {
            swipeStart.current = null;
          }}
        >
          <div className="absolute inset-2">
            {/* empty slots */}
            {Array.from({ length: SIZE * SIZE }, (_, i) => {
              const r = Math.floor(i / SIZE);
              const c = i % SIZE;
              return (
                <div
                  key={`slot-${i}`}
                  className="absolute"
                  style={{ left: `${c * 25}%`, top: `${r * 25}%`, width: "25%", height: "25%" }}
                >
                  <div className="absolute inset-[7%] rounded-[10px] bg-white/35" />
                </div>
              );
            })}

            {/* absorbed-tile ghosts: slide into the merge, then fade */}
            {ghosts.map((g) => (
              <motion.div
                key={`ghost-${g.id}`}
                className="absolute"
                initial={{ left: `${g.fromC * 25}%`, top: `${g.fromR * 25}%`, opacity: 0.9 }}
                animate={{ left: `${g.toC * 25}%`, top: `${g.toR * 25}%`, opacity: 0 }}
                transition={{ ...SPRING, opacity: { duration: 0.2, ease: "easeOut" } }}
                style={{ width: "25%", height: "25%" }}
                aria-hidden
              >
                <div className={`absolute inset-[7%] rounded-[10px] ${tileCls(g.v)}`} />
              </motion.div>
            ))}

            {/* live tiles — they SLIDE between cells */}
            {tiles.map((tile) => (
              <motion.div
                key={tile.id}
                className="absolute"
                initial={{ scale: 0, opacity: 0 }}
                animate={{
                  left: `${tile.c * 25}%`,
                  top: `${tile.r * 25}%`,
                  width: "25%",
                  height: "25%",
                  scale: 1,
                  opacity: 1,
                }}
                transition={SPRING}
                aria-label={`tile ${tile.v}, row ${tile.r + 1}, column ${tile.c + 1}`}
              >
                {/* keyed by value → doubling pops with a spring */}
                <motion.div
                  key={`${tile.id}-${tile.v}`}
                  initial={{ scale: 0.75 }}
                  animate={{ scale: 1 }}
                  transition={POP}
                  className={`absolute inset-[7%] grid select-none place-items-center rounded-[10px] font-extrabold shadow-sm ${tileCls(tile.v)} ${txtCls(tile.v)}`}
                >
                  {tile.v}
                </motion.div>
              </motion.div>
            ))}
          </div>

          {/* win / game-over overlays */}
          <AnimatePresence>
            {(showWin || over) && (
              <motion.div
                key={showWin ? "g2048-win" : "g2048-over"}
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={SPRING}
                className="absolute inset-0 z-10 grid place-items-center rounded-2xl bg-white/40 backdrop-blur-[4px]"
              >
                <div className="glass-strong rounded-2xl px-8 py-6 text-center">
                  {showWin ? (
                    <>
                      <p className="text-xl font-bold text-stone-800">You win! 🎉</p>
                      <p className="mt-1 text-xs text-stone-500">2048 reached · score {score}</p>
                      <div className="mt-3 flex items-center justify-center gap-2">
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          transition={SPRING}
                          onClick={() => setKeepGoing(true)}
                          className="rounded-xl bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-700 outline-none transition-colors hover:bg-emerald-500/25 focus-visible:ring-2 focus-visible:ring-emerald-400"
                        >
                          Keep going
                        </motion.button>
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          transition={SPRING}
                          onClick={newGame}
                          className="gd-accent-gradient rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-teal-400"
                        >
                          New game
                        </motion.button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-xl font-bold text-stone-800">Game over</p>
                      <p className="mt-1 text-xs text-stone-500">No moves left · score {score}</p>
                      <div className="mt-3 flex items-center justify-center gap-2">
                        {undo && (
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.94 }}
                            transition={SPRING}
                            onClick={undoMove}
                            className="flex items-center gap-1.5 rounded-xl bg-white/60 px-4 py-2 text-sm font-semibold text-stone-700 outline-none transition-colors hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-teal-400"
                          >
                            <Undo2 className="size-3.5" /> Undo
                          </motion.button>
                        )}
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          transition={SPRING}
                          onClick={newGame}
                          className="gd-accent-gradient rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-teal-400"
                        >
                          New game
                        </motion.button>
                      </div>
                    </>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <p className="text-center text-[11px] text-stone-400" role="note">
        Arrow keys or swipe · merge to {TARGET} · undo takes back one move
      </p>
    </div>
  );
}
