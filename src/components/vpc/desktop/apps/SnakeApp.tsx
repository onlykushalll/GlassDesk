"use client";

// ============================================================
// GlassDesk — Snake. LOCAL play (the game ticks never leave the
// seat that's playing); only the BEST score is synced via an
// app:patch checkpoint, so both people chase the same record.
//
// Grid 19×15 (col×row) · start 130 ms/tick · every 5 foods the
// speed ramps a level (−10 ms) down to a 70 ms floor.
// Arrows + WASD steer (no 180° reversal), Space pauses/restarts.
// Keys are only honored while THIS window is the top window on
// the active workspace (keyboard focus guard).
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring } from "framer-motion";
import { Gauge, Pause, Play, RotateCcw, Trophy } from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import type { WindowState } from "@/lib/vpc/types";

const COLS = 19;
const ROWS = 15;
const BASE_MS = 130;
const MIN_MS = 70;
const RAMP_FOODS = 5; // foods per speed level

type Dir = [number, number];
type Pos = [number, number];
type Phase = "idle" | "running" | "paused" | "dead";

const SPRING = { type: "spring", stiffness: 420, damping: 28 } as const;

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

function randomFood(body: Pos[]): Pos {
  const occupied = new Set(body.map((s) => `${s[0]},${s[1]}`));
  const free: Pos[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!occupied.has(`${r},${c}`)) free.push([r, c]);
    }
  }
  if (free.length === 0) return [0, 0]; // board full — the win case
  return free[Math.floor(Math.random() * free.length)];
}

export default function SnakeApp({ win }: { win: WindowState }) {
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

  // ---- game state: refs are the truth, useState mirrors for render ----
  const [phase, setPhase] = useState<Phase>("idle");
  const [body, setBody] = useState<Pos[]>(() => {
    const cy = Math.floor(ROWS / 2);
    const cx = Math.floor(COLS / 2);
    return [
      [cy, cx],
      [cy, cx - 1],
      [cy, cx - 2],
    ];
  });
  const [food, setFood] = useState<Pos | null>(null);
  const [score, setScore] = useState(0);
  const [newBest, setNewBest] = useState(false);

  const bodyRef = useRef<Pos[]>(body);
  const dirRef = useRef<Dir>([0, 1]);
  const pendingRef = useRef<Dir | null>(null);
  const foodRef = useRef<Pos | null>(null);
  const foodsRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const bestRef = useRef(best);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    bestRef.current = best;
  }, [best]);

  const start = useCallback((dir?: Dir) => {
    const cy = Math.floor(ROWS / 2);
    const cx = Math.floor(COLS / 2);
    const next: Pos[] = [
      [cy, cx],
      [cy, cx - 1],
      [cy, cx - 2],
    ];
    bodyRef.current = next;
    dirRef.current = dir ?? [0, 1];
    pendingRef.current = null;
    foodsRef.current = 0;
    const f = randomFood(next);
    foodRef.current = f;
    setBody(next);
    setFood(f);
    setScore(0);
    setNewBest(false);
    setPhase("running");
  }, []);

  const die = useCallback(() => {
    setPhase("dead");
    const s = foodsRef.current;
    if (s > 0 && s > bestRef.current) {
      bestRef.current = s; // optimistic mirror until the patch lands
      dispatch({ t: "app:patch", id: win.id, patch: { best: s } });
      setNewBest(true);
      pushToast({ title: "New best! 🏆", body: `Snake record — ${s} points`, kind: "success" });
    }
  }, [dispatch, win.id]);

  const tick = useCallback(() => {
    const cur = bodyRef.current;
    const dir = pendingRef.current ?? dirRef.current;
    pendingRef.current = null;
    dirRef.current = dir;
    const nh: Pos = [cur[0][0] + dir[0], cur[0][1] + dir[1]];

    // wall
    if (nh[0] < 0 || nh[0] >= ROWS || nh[1] < 0 || nh[1] >= COLS) {
      die();
      return;
    }
    // self (the tail vacates unless we're eating)
    const f = foodRef.current;
    const eating = !!f && f[0] === nh[0] && f[1] === nh[1];
    const selfBody = eating ? cur : cur.slice(0, -1);
    if (selfBody.some((seg) => seg[0] === nh[0] && seg[1] === nh[1])) {
      die();
      return;
    }

    const next: Pos[] = [nh, ...cur];
    if (eating) {
      foodsRef.current += 1;
      foodRef.current = randomFood(next);
      setFood(foodRef.current);
      setScore(foodsRef.current);
    } else {
      next.pop();
    }
    bodyRef.current = next;
    setBody(next);
  }, [die]);

  const level = Math.floor(score / RAMP_FOODS);
  const interval = Math.max(MIN_MS, BASE_MS - level * 10);

  // game loop — speed ramps by rebuilding the interval; frozen while
  // another window holds focus (the derived pause above)
  useEffect(() => {
    if (phase !== "running" || !active) return;
    const iv = setInterval(tick, interval);
    return () => clearInterval(iv);
  }, [phase, active, interval, tick]);

  // sticky pause when the browser tab hides (listener callback — not an effect-body setState)
  useEffect(() => {
    const onHide = () => {
      if (document.hidden && phaseRef.current === "running") setPhase("paused");
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const queueDir = (dir: Dir) => {
    const cur = pendingRef.current ?? dirRef.current;
    if (cur[0] === -dir[0] && cur[1] === -dir[1]) return; // no 180° reversal
    if (cur[0] === dir[0] && cur[1] === dir[1]) return; // no-op
    pendingRef.current = dir;
  };

  // keyboard (guarded: only while this window is the active one)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && target.closest("input,textarea,select,[contenteditable=true]")) return;
      const k = e.key.toLowerCase();
      let dir: Dir | null = null;
      if (k === "arrowup" || k === "w") dir = [-1, 0];
      else if (k === "arrowdown" || k === "s") dir = [1, 0];
      else if (k === "arrowleft" || k === "a") dir = [0, -1];
      else if (k === "arrowright" || k === "d") dir = [0, 1];

      if (dir) {
        e.preventDefault(); // never scroll the desktop while playing
        const ph = phaseRef.current;
        if (ph === "idle" || ph === "dead") start(dir);
        else if (ph === "running") queueDir(dir);
        else if (ph === "paused") {
          queueDir(dir);
          setPhase("running");
        }
        return;
      }
      if (k === " ") {
        e.preventDefault();
        const ph = phaseRef.current;
        if (ph === "running") setPhase("paused");
        else if (ph === "paused") setPhase("running");
        else start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, start]);

  // cell lookup for rendering
  const cellMap = useMemo(() => {
    const m = new Map<string, number>();
    body.forEach((seg, i) => m.set(`${seg[0]},${seg[1]}`, i));
    return m;
  }, [body]);

  const nextZ = useGlassDesk((s) => s.nextZ);

  const togglePause = () => {
    const ph = phaseRef.current;
    if (ph === "running") {
      if (!active) {
        // auto-paused (another window holds focus): raising this window resumes play
        dispatch({ t: "win:z", id: win.id, z: nextZ() });
        return;
      }
      setPhase("paused");
    } else if (ph === "paused") {
      setPhase("running");
    }
  };

  // derived: a running game is EFFECTIVELY paused while another window holds focus
  const autoPaused = phase === "running" && !active;
  const shownPhase: Phase = autoPaused ? "paused" : phase;

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
        <div className="glass flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-stone-700">
          <Gauge className="size-3.5 text-teal-600" aria-hidden /> Lv {level + 1}
        </div>
        {(phase === "running" || phase === "paused") && (
          <motion.button
            type="button"
            whileTap={{ scale: 0.92 }}
            transition={SPRING}
            onClick={togglePause}
            aria-label={phase === "running" && active ? "Pause game" : "Resume game"}
            className="glass ml-auto grid size-8 place-items-center rounded-lg text-stone-600 outline-none transition-colors hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-teal-400"
          >
            {phase === "running" && active ? <Pause className="size-4" /> : <Play className="size-4" />}
          </motion.button>
        )}
      </div>

      {/* board */}
      <div className="relative mx-auto flex min-h-0 w-full max-w-[420px] flex-1 items-center overflow-hidden">
        <div
          className="relative w-full rounded-2xl bg-white/25 p-2.5 shadow-[inset_0_2px_12px_rgba(31,41,55,0.12)]"
          role="img"
          aria-label={`Snake board, ${COLS} by ${ROWS}. Snake length ${body.length}, score ${score}.`}
        >
          <div
            className="grid aspect-[19/15] gap-[2px]"
            style={{
              gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
            }}
          >
              {Array.from({ length: ROWS * COLS }, (_, i) => {
                const r = Math.floor(i / COLS);
                const c = i % COLS;
                const si = cellMap.get(`${r},${c}`);
                const isFood = !!food && food[0] === r && food[1] === c;
                const isHead = si === 0;
                const isBody = si !== undefined && si > 0;
                const tail = isBody && (si ?? 0) > body.length * 0.6;
                return (
                  <div
                    key={i}
                    className={`relative rounded-[4px] transition-colors duration-100 ${
                      isHead
                        ? "bg-emerald-600"
                        : isBody
                          ? tail
                            ? "bg-emerald-400/80"
                            : "bg-emerald-500"
                          : "bg-white/30"
                    } ${isHead ? "rounded-[6px] shadow-[0_0_6px_rgba(16,185,129,0.45)]" : ""}`}
                  >
                    {isFood && (
                      <motion.span
                        key={`food-${r}-${c}`}
                        className="absolute inset-[16%] rounded-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.55)]"
                        animate={{ scale: [1, 1.28, 1] }}
                        transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut", times: [0, 0.5, 1] }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* state overlays */}
            <AnimatePresence>
              {shownPhase !== "running" && (
                <motion.div
                  key={`snake-ov-${shownPhase}`}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94 }}
                  transition={SPRING}
                  className="absolute inset-0 z-10 grid place-items-center rounded-2xl bg-white/35 backdrop-blur-[3px]"
                >
                  <div className="glass-strong rounded-2xl px-8 py-6 text-center">
                    {shownPhase === "dead" ? (
                      <>
                        <p className="text-xl font-bold text-stone-800">Game over 💥</p>
                        <p className="mt-1 text-sm text-stone-600">
                          Score <span className="font-semibold tabular-nums">{score}</span> · Best{" "}
                          <span className="font-semibold tabular-nums">{Math.max(best, score)}</span>
                        </p>
                        {newBest && (
                          <motion.p
                            className="mt-1 text-xs font-semibold text-amber-600"
                            animate={{ scale: [1, 1.08, 1] }}
                            transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                          >
                            🏆 New record!
                          </motion.p>
                        )}
                        <p className="mt-1.5 text-[11px] text-stone-400">Space to restart</p>
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          transition={SPRING}
                          onClick={() => start()}
                          className="gd-accent-gradient mt-3 flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-teal-400"
                        >
                          <RotateCcw className="size-3.5" /> Restart
                        </motion.button>
                      </>
                    ) : shownPhase === "paused" ? (
                      <>
                        <p className="text-xl font-bold text-stone-800">Paused</p>
                        <p className="mt-1 text-xs text-stone-400">
                          {autoPaused ? "Another window took focus — click Resume to jump back in" : "Space to resume"}
                        </p>
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          transition={SPRING}
                          onClick={togglePause}
                          className="gd-accent-gradient mt-3 flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-teal-400"
                        >
                          <Play className="size-3.5" /> Resume
                        </motion.button>
                      </>
                    ) : (
                      <>
                        <p className="text-xl font-bold text-stone-800">Snake 🐍</p>
                        <p className="mt-1 text-xs text-stone-400">Press any arrow key to start</p>
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          transition={SPRING}
                          onClick={() => start()}
                          className="gd-accent-gradient mt-3 flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm outline-none transition-[filter] hover:brightness-105 focus-visible:ring-2 focus-visible:ring-teal-400"
                        >
                          <Play className="size-3.5" /> Start
                        </motion.button>
                      </>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

      <p className="text-center text-[11px] text-stone-400" role="note">
        Arrows / WASD steer · Space pauses · every {RAMP_FOODS} snacks the speed ramps up
      </p>
    </div>
  );
}
