"use client";

// GlassDesk root component — the ONLY user-facing surface.
// Landing ⇄ Session phase switch + `?join=CODE` deep-link auto-join
// + the Restart boot replay: StartMenu → Power → Restart stashes the
// session code + a "gd:force-boot" flag in sessionStorage and reloads;
// on load we auto-rejoin the SAME session and replay the boot phase.

import { useEffect, useRef } from "react";
import { savedSession, useGlassDesk, rememberedName } from "@/lib/vpc/store";
import Landing from "./Landing";
import SessionView from "./SessionView";

// sessionStorage keys shared with StartMenu's Restart flow.
const FORCE_BOOT_KEY = "gd:force-boot";
const REJOIN_CODE_KEY = "gd:rejoin-code";

export default function App() {
  const phase = useGlassDesk((s) => s.phase);
  const booted = useGlassDesk((s) => (s.state ? s.state.booted : null));
  const join = useGlassDesk((s) => s.join);
  const autoTried = useRef(false);
  const bootReplayed = useRef(false);

  useEffect(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    try {
      const params = new URLSearchParams(window.location.search);
      let code = (params.get("join") ?? "").replace(/\D/g, "").slice(0, 6);
      let name: string | null = null;
      if (code.length === 6) {
        name = rememberedName();
      } else {
        // reload / crash recovery: resume the saved session identity —
        // same code, same seat, newest state (service-side retention)
        const saved = savedSession();
        if (saved && saved.code.length === 6) {
          code = saved.code;
          name = saved.name;
        } else if (sessionStorage.getItem(FORCE_BOOT_KEY) === "1") {
          // Restart reload: rejoin the SAME session (leave() was never
          // called) using the code stashed by the Start menu.
          code = (sessionStorage.getItem(REJOIN_CODE_KEY) ?? "").replace(/\D/g, "").slice(0, 6);
          name = rememberedName();
        }
      }
      if (code.length === 6 && name) join(code, name);
      // no remembered name → Landing shows with code context; user enters
      // name and can hit join (Landing keeps its own code field).
    } catch {
      /* SSR / bad URL — ignore */
    }
  }, [join]);

  // Restart boot replay: once the rejoined state lands, flip the synced
  // `booted` flag off for one pass — Desktop's existing 2.4s boot overlay
  // then plays and its timer flips the flag back on (host re-flushes the
  // snapshot). Windows, files and chat are untouched: a rejoin with boot
  // theater, not a new session. The flag is consumed here so the replay
  // fires exactly once per restart.
  useEffect(() => {
    if (bootReplayed.current) return;
    if (phase !== "session" || booted === null) return;
    bootReplayed.current = true;
    try {
      if (booted && sessionStorage.getItem(FORCE_BOOT_KEY) === "1") {
        useGlassDesk.getState().dispatch({ t: "sys", patch: { booted: false } });
      }
      sessionStorage.removeItem(FORCE_BOOT_KEY);
      sessionStorage.removeItem(REJOIN_CODE_KEY);
    } catch {
      /* private mode — plain rejoin, no theater */
    }
  }, [phase, booted]);

  return phase === "session" ? <SessionView /> : <Landing />;
}
