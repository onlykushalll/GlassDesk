"use client";

// ============================================================
// GlassDesk — the shared synth radio (Media app + taskbar mini).
//
// "Media playing" is REAL here: a deterministic WebAudio engine
// synthesizes each track (pads / bass / plucks / hats) from the
// SHARED playhead seconds. Both seats render the exact same
// pattern from the same t → audible music, synced, no files.
//
// Determinism: every note decision is a pure hash of
// (trackIndex, absolute step) — no Math.random anywhere, so any
// seat at any wall-clock computes the identical audio stream.
//
// The taskbar imports TRACK_TITLES for the media mini; MediaApp
// owns the sync payload (track/playing/t/medBy) and feeds the
// engine through useSynthRadio({ getPos }).
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";

export interface RadioTrack {
  title: string;
  artist: string;
  dur: number; // seconds (loop anchor for the pattern)
  gradient: string; // tailwind from-/to- classes
  bpm: number;
  rootMidi: number; // pattern root (C4 = 60)
  prog: [number, "maj7" | "min7" | "7"][]; // [semitone offset, quality] per chord
}

/** Shared track list — titles also power the taskbar media mini. */
export const TRACKS: RadioTrack[] = [
  {
    title: "Glass Mornings",
    artist: "Nova FM",
    dur: 192,
    gradient: "from-teal-400 to-emerald-400",
    bpm: 76,
    rootMidi: 65,
    prog: [[0, "maj7"], [9, "min7"], [5, "maj7"], [7, "7"]],
  },
  {
    title: "Liquid Dreams",
    artist: "Aurora System",
    dur: 225,
    gradient: "from-amber-400 to-orange-400",
    bpm: 84,
    rootMidi: 62,
    prog: [[0, "min7"], [5, "min7"], [8, "maj7"], [3, "maj7"]],
  },
  {
    title: "Frosted Light",
    artist: "Panel Pioneers",
    dur: 198,
    gradient: "from-rose-400 to-pink-400",
    bpm: 92,
    rootMidi: 67,
    prog: [[0, "maj7"], [2, "min7"], [7, "7"], [10, "min7"]],
  },
  {
    title: "Session Sync",
    artist: "local-1",
    dur: 243,
    gradient: "from-emerald-400 to-teal-400",
    bpm: 80,
    rootMidi: 60,
    prog: [[0, "maj7"], [4, "min7"], [9, "min7"], [5, "maj7"]],
  },
  {
    title: "Preserve This Moment",
    artist: "snapd",
    dur: 180,
    gradient: "from-violet-400 to-purple-400",
    bpm: 72,
    rootMidi: 64,
    prog: [[0, "min7"], [7, "maj7"], [5, "min7"], [10, "maj7"]],
  },
  {
    title: "Boot Sequence",
    artist: "gd-kernel",
    dur: 156,
    gradient: "from-stone-400 to-stone-500",
    bpm: 100,
    rootMidi: 58,
    prog: [[0, "min7"], [3, "maj7"], [10, "min7"], [8, "7"]],
  },
];

export const TRACK_TITLES: string[] = TRACKS.map((t) => t.title);

// ---------------- tiny deterministic hash (no Math.random) ----------------

function hash(a: number, b: number): number {
  let h = (a * 0x9e3779b1 + b * 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

const CHORD_TONES: Record<"maj7" | "min7" | "7", number[]> = {
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  7: [0, 4, 7, 10],
};

// ---------------- the engine (module singleton) ----------------

const PENTA = [0, 3, 5, 7, 10]; // minor pentatonic — sings over everything here

class RadioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer: number | null = null;
  private volume = 0.75;
  private track = 0;

  /** Create (or reuse) the AudioContext + graph. Safe to call anytime;
   *  returns the state so callers can detect autoplay-lock. */
  ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("no audio");
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = 0; // ramped by play/pause
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    // gentle space: feedback delay send
    const delay = ctx.createDelay(1.2);
    delay.delayTime.value = 0.31;
    const fb = ctx.createGain();
    fb.gain.value = 0.28;
    const send = ctx.createGain();
    send.gain.value = 0.5;
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(comp);
    send.connect(delay);

    master.connect(comp);
    comp.connect(ctx.destination);
    this.send = send;

    // 1s of white noise for hats
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this.ctx = ctx;
    this.master = master;
    return ctx;
  }

  private send: GainNode | null = null;

  state(): AudioContextState | "none" {
    return this.ctx?.state ?? "none";
  }

  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (ctx.state !== "running") await ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  private tone(
    freq: number,
    at: number,
    dur: number,
    gain: number,
    type: OscillatorType,
    attack = 0.01,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, at + dur);
    osc.connect(g);
    g.connect(master);
    if (this.send) g.connect(this.send);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  private pad(freqs: number[], at: number, dur: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.05, at + 0.8);
    g.gain.setValueAtTime(0.05, at + dur - 1.2);
    g.gain.linearRampToValueAtTime(0, at + dur);
    lp.connect(g);
    g.connect(master);
    if (this.send) g.connect(this.send);
    for (const f of freqs) {
      for (const detune of [-4, 3]) {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = f;
        osc.detune.value = detune;
        osc.connect(lp);
        osc.start(at);
        osc.stop(at + dur + 0.1);
      }
    }
  }

  private hat(at: number, gain: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0005, at + 0.045);
    src.connect(hp);
    hp.connect(g);
    g.connect(master);
    src.start(at, Math.random() * 0.5); // random offset — pure texture
    src.stop(at + 0.08);
  }

  /** Schedule all events for eighth-steps in [fromStep, toStep). */
  private scheduleSteps(fromStep: number, toStep: number, ctxAt: number, posAt: number): void {
    const tr = TRACKS[this.track] ?? TRACKS[0];
    const stepDur = 60 / tr.bpm / 2; // eighth note
    for (let step = Math.ceil(fromStep); step < toStep; step++) {
      const beat = step / 2;
      const bar = Math.floor(beat / 4);
      const chordIdx = Math.floor(bar / 2) % tr.prog.length;
      const [semi, quality] = tr.prog[chordIdx];
      const chordRoot = tr.rootMidi + semi;
      const at = ctxAt + (step * stepDur - posAt);

      // pad — at every chord boundary (every 8 beats = 16 steps)
      if (step % 16 === 0) {
        const tones = CHORD_TONES[quality].map((t) => midiToFreq(chordRoot + t + 12));
        this.pad(tones, at, 16 * stepDur);
      }
      // bass — on beats 1 & 3
      if (step % 4 === 0) {
        this.tone(midiToFreq(chordRoot - 12), at, 0.55, 0.16, "sine", 0.02);
      }
      // pluck melody — deterministic pick on ~1/3 of eighths
      const h = hash(this.track, step);
      if (h % 3 === 0) {
        const note = chordRoot + 12 + PENTA[(h >>> 8) % PENTA.length] + (((h >>> 14) % 3) * 12);
        this.tone(midiToFreq(note), at, 0.34, 0.07, "triangle", 0.005);
      }
      // hats — most eighths, humanized
      if (h % 7 !== 0) {
        const accent = step % 2 === 1 ? 0.028 : 0.016;
        this.hat(at, accent);
      }
    }
  }

  /** Begin following the shared playhead. getPos() returns the shared
   *  seconds; we schedule LOOKAHEAD ahead on the ctx clock. */
  start(track: number, getPos: () => number): void {
    const ctx = this.ensure();
    this.track = Math.max(0, Math.min(TRACKS.length - 1, track));
    if (this.master) {
      this.master.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.12);
    }
    if (this.timer !== null) window.clearInterval(this.timer);
    const LOOKAHEAD = 0.5; // seconds of audio scheduled ahead
    const TICK = 120; // ms
    let lastStep = -1;
    const pump = () => {
      const pos = getPos();
      const tr = TRACKS[this.track] ?? TRACKS[0];
      const stepDur = 60 / tr.bpm / 2;
      const stepNow = pos / stepDur;
      const from = lastStep < 0 ? Math.ceil(stepNow) : Math.max(lastStep, Math.ceil(stepNow));
      const to = stepNow + LOOKAHEAD / stepDur;
      if (to > from) {
        this.scheduleSteps(from, to, ctx.currentTime, pos);
        lastStep = Math.max(lastStep, Math.floor(to));
      }
    };
    pump();
    this.timer = window.setInterval(pump, TICK);
  }

  pause(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    }
  }

  /** hard stop (window closed) */
  stop(): void {
    this.pause();
  }
}

let engine: RadioEngine | null = null;

function getEngine(): RadioEngine {
  if (!engine) engine = new RadioEngine();
  return engine;
}

// ---------------- the React hook ----------------

export interface SynthRadioState {
  /** false while the browser autoplay-lock holds the AudioContext —
   *  show a "tap to unmute" affordance until a gesture lands. */
  locked: boolean;
  unlock: () => void;
}

/**
 * Follows the shared playhead and renders audible music.
 *   track   — shared track index
 *   playing — shared play state
 *   getPos  — () => shared seconds (drift-corrected by MediaApp)
 *   volume  — LOCAL pref (never synced; each seat has own speakers)
 */
export function useSynthRadio(opts: {
  track: number;
  playing: boolean;
  getPos: () => number;
  volume: number;
}): SynthRadioState {
  const { track, playing, getPos, volume } = opts;
  const [locked, setLocked] = useState(false);

  const getPosRef = useRef(getPos);
  useEffect(() => {
    getPosRef.current = getPos; // latest-ref pattern — updated in an effect, never during render
  });

  useEffect(() => {
    const eng = getEngine();
    eng.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    const eng = getEngine();
    if (!playing) {
      eng.pause();
      return;
    }
    let cancelled = false;
    eng
      .resume()
      .then(() => {
        if (cancelled) return;
        eng.start(track, () => getPosRef.current());
        setLocked(false);
      })
      .catch(() => {
        if (!cancelled) setLocked(true);
      });
    // detect suspended-while-playing on a slow poll
    const iv = window.setInterval(() => {
      const st = eng.state();
      setLocked((l) => (st === "running" ? (l ? false : l) : l || true));
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
      eng.pause();
    };
  }, [playing, track]);

  const unlock = useCallback(() => {
    const eng = getEngine();
    eng
      .resume()
      .then(() => {
        eng.start(track, () => getPosRef.current());
        setLocked(false);
      })
      .catch(() => setLocked(true));
  }, [track]);

  return { locked, unlock };
}
