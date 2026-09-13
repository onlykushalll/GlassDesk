# GlassDesk — Technical Architecture & System Specification

## 1. Executive Summary & Design Topology

GlassDesk is an in-browser, low-latency collaborative operating system designed for concurrent co-control between two remote participants. Unlike traditional video-streaming remote desktop protocols (RDP, VNC, AnyDesk) that transmit raw pixel frames over heavy H.264/WebRTC video channels, GlassDesk operates as an **operational state-synchronized virtual machine**:
- Application state is synchronized at the semantic **operational mutation** level via WebSocket event streams.
- The user interface renders natively on each client browser at 60+ FPS with zero compression artifacts.
- Audio and video communication is offloaded to a docked peer-to-peer WebRTC mesh with integrated glare avoidance.

```
                    ┌─────────────────────────┐
                    │       Reverse Proxy     │
                    │      (Port :80 / :443)  │
                    └────────────┬────────────┘
                                 │
           ┌─────────────────────┴─────────────────────┐
           ▼                                           ▼
┌───────────────────────────┐             ┌───────────────────────────┐
│     Next.js Web Client    │             │   Session Microservice    │
│       (Port :3000)        │             │       (Port :4000)        │
├───────────────────────────┤             ├───────────────────────────┤
│ • React 19 / Zustand 5    │  WebSocket  │ • Node.js / Bun Engine    │
│ • Framer Motion 12        ├────────────►│ • Socket.io 4.8 Engine    │
│ • 30 Native VPC Apps      │  (Events)   │ • Authoritative Op Reducer│
│ • Optimistic Op Execution │             │ • Ghost Eviction Protocol │
│ • WebRTC P2P Video Mesh   │             │ • SQLite WAL Volume       │
└───────────────────────────┘             └───────────────────────────┘
```

---

## 2. Authoritative Operational Reducer (`applyOp`)

To guarantee deterministic, conflict-free state across both seats without the overhead of heavy CRDT vectors, GlassDesk employs an **Authoritative Central Reducer**:

1. **Optimistic Client Execution**: When a user drags a window, types a note, or writes to the virtual filesystem, the local client applies the mutation immediately to its local Zustand store for 0ms perceptual latency.
2. **Server Serialization & Sequence Stamp**: The mutation (`Op`) is dispatched over the room WebSocket. The server's `applyOp` validates permissions, increments the room mutation sequence counter, applies the change to the authoritative in-memory room state, and broadcasts the serialized `Op` to the remote peer.
3. **Reconciliation on Desync**: If a sequence gap is detected by either peer, the client requests a full authoritative `room:state` snapshot.

### Mutation Types

| Category | Operations | Semantics |
|---|---|---|
| **Window Management** | `WINDOW_OPEN`, `WINDOW_CLOSE`, `WINDOW_FOCUS`, `WINDOW_MOVE`, `WINDOW_RESIZE`, `WINDOW_MINIMIZE`, `WINDOW_MAXIMIZE` | Highest z-index is incremented monotonically; window positions are bounded by virtual viewport geometry. |
| **Virtual Filesystem** | `VFS_WRITE`, `VFS_DELETE`, `VFS_RENAME`, `VFS_MKDIR` | Path-indexed hierarchical virtual storage persisted into SQLite. |
| **System & Shell** | `PROCESS_SPAWN`, `PROCESS_KILL`, `SETTINGS_SET` | Ephemeral PID allocation and system hardware simulation. |
| **Docked Video & Chat**| `CHAT_SEND`, `RTC_SIGNAL` | In-memory transient message queue and P2P SDP relay. |

---

## 3. Session Token Resumption & Ghost Eviction Protocol

Network partitions and page reloads are primary failure modes in collaborative tools. GlassDesk implements a stateful session resumption protocol:

1. **Cryptographic Participant Tokens**: On room creation or first join, each seat receives an ephemeral UUID token stored in client `localStorage`.
2. **Socket Migration Handling**: If a participant reloads the page or switches networks, the client establishes a new WebSocket connection presenting its existing session token. The session service re-binds the existing seat identity rather than creating a duplicate phantom user.
3. **Ghost Eviction Protocol**: If a connection terminates abruptly without a clean TCP FIN, a 15-second grace timer is initiated. If the token is not resumed within the window, the server dispatches a `seat:leave` event, releases input locks held by that seat, and preserves room state for up to 24 hours.

---

## 4. WebRTC Signaling & Glare-Avoidance State Machine

Docked video calling uses standard WebRTC `RTCPeerConnection` with a deterministic glare-avoidance state machine:

```
[Seat 1: Host]                                              [Seat 2: Guest]
      │                                                            │
      ├── Creates RTCOffer ───────────────────────────────────────►│
      │   (Socket Relay: rtc:offer)                                │
      │                                                            ├── Sets Remote Description
      │                                                            ├── Creates RTCAnswer
      │◄───────────────────────────────────────────────────────────┤
      │   (Socket Relay: rtc:answer)                               │
      ├── Sets Remote Description                                  │
      │                                                            │
      ├── ICE Candidates (rtc:ice) ◄──────────────────────────────►│ ICE Candidates (rtc:ice)
      ▼                                                            ▼
      └──────────────── Direct P2P Media Stream ───────────────────┘
```

- **Deterministic Offer Role**: The host seat (`seat-1`) is always the designated polite offerer; `seat-2` only issues answers. This eliminates simultaneous collision offers (WebRTC glare) across high-latency links.
- **Candidate Buffering**: ICE candidates received prior to remote description resolution are buffered in a queue and flushed sequentially once `setRemoteDescription` resolves.

---

## 5. Storage Engine: Debounced SQLite WAL Architecture

Virtual PC state is persisted to an embedded SQLite database using Write-Ahead Logging (WAL):
- **Hot-State In-Memory Buffer**: High-frequency operations (such as window drags and cursor movements) execute strictly in volatile memory.
- **Debounced Flush**: Persistent mutations (file creation, notes, preferences) trigger a 400ms debounced transaction to write the full JSON-serialized state snapshot to the SQLite database.
- **Automated Lifecycle Eviction**: Rooms with zero active connections for greater than 24 hours are safely pruned via a background sweeper task.
