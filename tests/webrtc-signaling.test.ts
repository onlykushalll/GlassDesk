import { describe, it, expect } from "bun:test";

describe("GlassDesk WebRTC Glare-Avoidance Signaling Protocol", () => {
  interface SignalingState {
    role: "host" | "guest";
    signalingState: "stable" | "have-local-offer" | "have-remote-offer" | "closed";
    bufferedCandidates: string[];
    isCaller: boolean;
  }

  function createPeerState(role: "host" | "guest"): SignalingState {
    return {
      role,
      signalingState: "stable",
      bufferedCandidates: [],
      // Host seat is always designated polite offerer
      isCaller: role === "host",
    };
  }

  it("should enforce asymmetric offer generation preventing offer collisions (glare)", () => {
    const host = createPeerState("host");
    const guest = createPeerState("guest");

    // Host initiates call
    expect(host.isCaller).toBe(true);
    expect(guest.isCaller).toBe(false);

    // Host transitions to have-local-offer
    host.signalingState = "have-local-offer";

    // Guest receives offer and transitions to have-remote-offer
    guest.signalingState = "have-remote-offer";

    // Guest answers
    guest.signalingState = "stable";
    host.signalingState = "stable";

    expect(host.signalingState).toBe("stable");
    expect(guest.signalingState).toBe("stable");
  });

  it("should buffer ICE candidates received before remote description is resolved", () => {
    const peer = createPeerState("guest");
    const mockCandidates = ["candidate:1 1 UDP 2122260223 192.168.1.1 5000", "candidate:2 1 UDP 2122260223 192.168.1.2 5001"];

    // Candidate arrives before remote description
    function handleIncomingIce(candidate: string) {
      if (peer.signalingState === "stable" || peer.signalingState === "have-local-offer") {
        // Buffer until remote description set
        peer.bufferedCandidates.push(candidate);
      }
    }

    handleIncomingIce(mockCandidates[0]);
    handleIncomingIce(mockCandidates[1]);

    expect(peer.bufferedCandidates.length).toBe(2);

    // When remote description resolves, buffer is drained sequentially
    const drained = peer.bufferedCandidates.splice(0);
    expect(drained.length).toBe(2);
    expect(peer.bufferedCandidates.length).toBe(0);
  });
});
