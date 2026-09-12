# Privacy Policy — GlassDesk

**Last Updated:** September 12, 2026

GlassDesk ("we", "our", or "the platform") provides a browser-based collaborative virtual desktop environment. We are committed to protecting user data, audio/video streams, and session privacy.

---

## 1. Zero Cloud Video & Audio Retention

- **Direct Peer-to-Peer Streaming:** Video and audio feeds in docked calls utilize WebRTC (Web Real-Time Communication) to stream media directly between participant browsers.
- **No Video Recording:** We do not record, transcribe, capture, or store video frames or audio streams on any server.
- **Ephemeral Signaling:** WebRTC connection metadata (SDP offers, answers, and ICE candidates) is relayed transiently via WebSockets solely to negotiate the direct P2P link and is discarded immediately upon connection.

---

## 2. Virtual PC Session Data & Input Events

- **Ephemeral Input Multiplexing:** Mouse coordinates, clicks, and keyboard strokes sent to the virtual desktop are relayed in real-time across active WebSocket connections to synchronize co-control state. Raw keystroke logs are NEVER permanently recorded or stored.
- **Local SQLite State Persistence:** Virtual PC session state (window positions, open tabs, active notes, virtual filesystem files) is persisted into an SQLite database (`custom.db`) managed on your hosting server. Rooms idle for more than 24 hours are automatically purged.
- **Room Access Control:** Virtual desktop rooms are guarded by 6-digit codes. Only users in possession of the room code can connect.

---

## 3. Local Storage & Client Cookies

GlassDesk does not use tracking cookies, advertising pixels, or third-party marketing beacons. The application uses HTML5 `localStorage` exclusively for functional client preferences:
- Selected display name and avatar
- Audio volume, microphone mute, and camera privacy toggles
- Reconnect session resume tokens

You can clear all stored local data at any time via your browser settings.

---

## 4. Contact

For security vulnerability reports or privacy inquiries, please open an issue on GitHub:
https://github.com/onlykushalll/GlassDesk
