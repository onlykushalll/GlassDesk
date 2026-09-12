"use client";

// ============================================================
// GlassDesk — P2P video/audio call (Zoom-style, docked sidebar).
// Signaling rides the SESSION socket from the store (rtc:offer /
// rtc:answer / rtc:ice relayed by the service to a target socket id).
// Host seat always makes the offer; guest answers → no glare.
// Graceful fallbacks: camera/mic blocked (sandbox iframe) still
// establishes the connection with recvonly transceivers so both
// sides show a proper "no camera" state instead of dying.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { sessionSocket, useGlassDesk } from "./store";
import type { Seat } from "./types";

export type CallStatus = "idle" | "waiting" | "connecting" | "live" | "failed";

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export interface CallApi {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  status: CallStatus;
  micOn: boolean;
  camOn: boolean;
  mediaError: string | null;
  ended: boolean;
  peerName: string | null;
  toggleMic: () => void;
  toggleCam: () => void;
  endCall: () => void;
}

export function useCall(): CallApi {
  const peers = useGlassDesk((s) => s.peers);
  const selfId = useGlassDesk((s) => s.selfId);
  const seat = useGlassDesk((s) => s.seat);
  const phase = useGlassDesk((s) => s.phase);

  const remoteId = Object.keys(peers).find((id) => id !== selfId) ?? null;
  const peerName = remoteId ? (peers[remoteId]?.name ?? null) : null;

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<CallStatus>("waiting");
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const remoteIdRef = useRef<string | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const seatRef = useRef<Seat | null>(null);
  const endedRef = useRef(false);

  // Keep latest seat/ended in refs (read by async callbacks) without
  // touching refs during render — the compiler-safe pattern.
  useEffect(() => {
    seatRef.current = seat;
  }, [seat]);
  useEffect(() => {
    endedRef.current = ended;
  }, [ended]);

  const teardown = useCallback((nextStatus: CallStatus) => {
    pcRef.current?.getSenders().forEach((s) => s.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;
    remoteIdRef.current = null;
    pendingIceRef.current = [];
    setLocalStream((prev) => {
      prev?.getTracks().forEach((t) => t.stop());
      return null;
    });
    setRemoteStream(null);
    setStatus(nextStatus);
  }, []);

  const buildPeer = useCallback(async (target: string) => {
    if (pcRef.current && remoteIdRef.current === target) return pcRef.current;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;
    remoteIdRef.current = target;
    pendingIceRef.current = [];

    pc.ontrack = (e) => {
      setRemoteStream(e.streams[0] ?? null);
    };
    pc.onicecandidate = (e) => {
      const sock = sessionSocket();
      if (e.candidate && sock?.connected && remoteIdRef.current) {
        sock.emit("rtc:ice", { to: remoteIdRef.current, candidate: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") setStatus("live");
      else if (st === "failed") setStatus("failed");
      else if (st === "disconnected") setStatus("connecting");
    };

    // Camera/mic — may be blocked by the preview iframe; keep going either way.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: true,
      });
      setMediaError(null);
      setCamOn(true);
      setMicOn(true);
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      setLocalStream(stream);
    } catch {
      setMediaError("Camera / mic unavailable here — try “Open in New Tab”.");
      setCamOn(false);
      setMicOn(false);
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    // Host seat drives the offer.
    if (seatRef.current === "host") {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sock = sessionSocket();
      if (sock?.connected) sock.emit("rtc:offer", { to: target, sdp: pc.localDescription });
    }
    return pc;
  }, []);

  // ---- signaling handlers on the SESSION socket ----
  useEffect(() => {
    const sock = sessionSocket();
    if (!sock) return;

    const onOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      if (endedRef.current) return;
      if (remoteIdRef.current && remoteIdRef.current !== from) teardown("connecting");
      const pc = pcRef.current ?? (await buildPeer(from));
      if (!pc || pc.signalingState === "have-local-offer" || pc.remoteDescription) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      for (const c of pendingIceRef.current.splice(0)) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        } catch {
          /* stale candidate */
        }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const s = sessionSocket();
      if (s?.connected) s.emit("rtc:answer", { to: from, sdp: pc.localDescription });
    };

    const onAnswer = async ({ sdp }: { sdp: RTCSessionDescriptionInit }) => {
      const pc = pcRef.current;
      if (!pc || !pc.localDescription || pc.remoteDescription) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      for (const c of pendingIceRef.current.splice(0)) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        } catch {
          /* stale candidate */
        }
      }
    };

    const onIce = async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      const pc = pcRef.current;
      if (!pc || !pc.remoteDescription) {
        pendingIceRef.current.push(candidate); // buffer until remoteDescription set
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        /* stale candidate */
      }
    };

    sock.on("rtc:offer", onOffer);
    sock.on("rtc:answer", onAnswer);
    sock.on("rtc:ice", onIce);
    return () => {
      sock.off("rtc:offer", onOffer);
      sock.off("rtc:answer", onAnswer);
      sock.off("rtc:ice", onIce);
    };
  }, [buildPeer, teardown, selfId]);

  // ---- call lifecycle driven by peers (join/leave/migration) ----
  useEffect(() => {
    if (phase !== "session" || endedRef.current) return;
    if (!remoteId) {
      /* eslint-disable react-hooks/set-state-in-effect -- teardown of an
         external RTCPeerConnection peer; deferring would race re-joins */
      if (pcRef.current) teardown("waiting");
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    if (remoteIdRef.current === remoteId && pcRef.current) return;
    if (pcRef.current) teardown("connecting");
    setStatus("connecting");
    void buildPeer(remoteId);
  }, [remoteId, phase, buildPeer, teardown]);

  // leaving the session entirely → full teardown
  useEffect(() => {
    if (phase !== "session") {
      /* eslint-disable react-hooks/set-state-in-effect -- external
         RTCPeerConnection teardown on session exit; runs pre-unmount */
      teardown("idle");
      /* eslint-enable react-hooks/set-state-in-effect */
      setEnded(false);
      setMediaError(null);
    }
  }, [phase, teardown]);

  const toggleMic = useCallback(() => {
    setMicOn((prev) => {
      const next = !prev;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  }, [localStream]);

  const toggleCam = useCallback(() => {
    setCamOn((prev) => {
      const next = !prev;
      localStream?.getVideoTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  }, [localStream]);

  const endCall = useCallback(() => {
    setEnded(true);
    teardown("idle");
  }, [teardown]);

  return {
    localStream,
    remoteStream,
    status,
    micOn,
    camOn,
    mediaError,
    ended,
    peerName,
    toggleMic,
    toggleCam,
    endCall,
  };
}
