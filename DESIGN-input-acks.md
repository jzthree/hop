# DESIGN: Sequence-acked input

**Status: proposal only — nothing in this document is implemented.**

Close the half-dead-socket keystroke-loss window by adding per-message sequence
numbers to `input` messages, cumulative server acknowledgements, a client-side
retransmit buffer, and dedup-on-resume across reconnects.

---

## 1. Problem statement

### 1.1 The current input path

A keystroke travels client → PTY like this:

**Web client** (`hay/apps/web/src/App.tsx`)

1. xterm.js `onData` → `handleUserInput(data)` (App.tsx, ~line 684) strips focus
   sequences, then:
   - if `wsRef.current?.readyState !== WebSocket.OPEN`, the keystroke is pushed
     into `pendingInputRef` (a per-room buffer capped by
     `PENDING_INPUT_MAX_ENTRIES = 200` entries and
     `PENDING_INPUT_MAX_AGE_MS = 15000` ms, App.tsx lines 181–182) and a
     "Reconnecting — input buffered" toast is shown;
   - otherwise it is locally echoed via `optimisticEchoRef.current.onInput`
     (`hay/apps/web/src/utils/optimisticEcho.ts`) and sent with
     `sendMessage({ type: "input", data })`.
2. `sendMessage` (App.tsx, ~line 674) is fire-and-forget:
   `wsRef.current.send(JSON.stringify(message))` — no sequence number, no
   delivery confirmation, no `bufferedAmount` check.
3. On reconnect (`connect`'s `open` handler, App.tsx ~lines 826–849) the pending
   buffer is filtered to the same room and the 15 s age window, concatenated,
   and replayed as a single `input` message.

**CLI client** (`hay/apps/cli/src/index.ts`)

1. `process.stdin.on("data", …)` (line 2974) tokenizes input, handles local
   shortcuts, then calls `sendMessage({ type: "input", data: sanitized })`
   (line 3085). Terminal-generated replies (DSR/CPR etc.) go through
   `terminal.onData` (line 536) the same way.
2. `sendMessage` (line 1201) sends only `if (ws?.readyState === WebSocket.OPEN)`
   — when the socket is not OPEN the keystroke is **silently dropped**. The CLI
   has no equivalent of the web client's pending-input buffer.

**Server** (`hay/apps/server/`)

1. The WebSocket is wrapped in a `SocketAdapter`
   (`hay/apps/server/src/rooms.ts`, line 9) by `createSocketAdapter` /
   `attachTermshare` in `hay/apps/server/src/lib.ts` (the standalone
   `hay/apps/server/src/index.ts` and the production host `scripts/hay-host.js`
   build the identical adapter).
2. `Room.attachClient` (rooms.ts, line 243) registers `socket.onMessage` →
   `safeParseClientMessage` (`hay/packages/shared/src/protocol.ts`) →
   `Room.handleMessage` (rooms.ts, line 311).
3. `case "input"` → `Room.handleInput` (rooms.ts, line 637) → `this.pty.write(data)`.
   Nothing is sent back to the client on success; the only input-related reply
   in the protocol is the negative `input_rejected` (control locked).

The wire protocol (`clientMessageSchema` / `serverMessageSchema` in
`hay/packages/shared/src/protocol.ts`) has an app-level `ping`/`pong` pair
(`{type:"ping", t}` handled in rooms.ts line 346), but **no client currently
sends it** — grep finds no senders in `hay/apps/web/src/App.tsx` or
`hay/apps/cli/src/index.ts`. There is also no WebSocket-protocol-level
heartbeat: neither `lib.ts` nor `scripts/hay-host.js` calls `ws.ping()` or runs
an `isAlive` sweep, and no client checks `bufferedAmount`.

### 1.2 Where keystrokes are lost: the half-dead-socket window

Everything above is gated on `readyState === OPEN`. But `readyState` reflects
the *local* socket state, not the health of the path. When a phone's wifi
drops, a NAT mapping expires, a laptop sleeps, or the network path silently
breaks, the TCP connection stays ESTABLISHED on the client for as long as TCP
retransmission takes to give up — tens of seconds to many minutes. During that
whole window:

- `ws.send()` succeeds (bytes queue in the kernel/browser send buffer),
- the web client's optimistic echo paints the keystroke as if delivered,
- the disconnect buffering in `handleUserInput` never engages because
  `readyState` is still `OPEN`,
- the server never receives the bytes, and
- nothing detects the gap until the OS finally errors the socket and the
  `close` handler fires.

When the socket does die, everything sitting in the send buffer is discarded.
The user believes the input was delivered (they saw it echoed, or simply saw no
error); the PTY never got it. The existing `pendingInputRef` replay only
protects keystrokes typed *after* the browser noticed the death — precisely the
easy half of the problem. The CLI is worse: it has no buffer at all, so any
keystroke during any non-OPEN state is gone.

Secondary loss points closed by the same mechanism:

- **Close race**: input sent moments before the `close` event fires may or may
  not have arrived; today the client can't tell, so it neither retransmits nor
  warns.
- **Blind replay**: the web reconnect replay (App.tsx lines 834–849) re-sends
  buffered input with no way for the server to detect duplicates if some of it
  did arrive before the drop.
- **Server-side accepted-but-dead**: the server's `SocketAdapter.send` also
  silently no-ops when its side isn't OPEN (lib.ts lines 29–33) — harmless for
  output (the snapshot on reattach recovers it) but it means the server can't
  signal anything about input it did or didn't get.

## 2. Proposed protocol: sequence numbers + cumulative acks

### 2.1 Overview

- Each client instance numbers its `input` messages with a monotonically
  increasing `seq` that survives reconnects.
- The server acknowledges input **cumulatively**: `{type:"input_ack", seq: N}`
  means "I have written every input with seq ≤ N from you to the PTY".
- The client keeps every sent-but-unacked input in a retransmit buffer. Acks
  prune it; reconnect replays it; a stall in acks is the *detection signal* for
  a half-dead socket — far earlier and more precisely than TCP.
- The server remembers the highest seq it has seen per client *instance* and
  drops anything ≤ that on replay, making retransmission idempotent.

### 2.2 Sequencing

- `seq` starts at 1 per client-instance per room and increments per `input`
  message. It is **not** reset on reconnect — the whole point is that the seq
  space spans socket lifetimes.
- The client identifies its instance with a random `instance` id (UUID
  generated once per attached client process/tab per room), sent as a query
  parameter on the `/ws` URL alongside the existing `room`/`name`/`cols`/`rows`
  params parsed in `attachTermshare` (lib.ts, line 118 onward) and
  `scripts/hay-host.js` (line 192 onward). This is needed because today's
  server-side client id is a fresh `randomUUID()` per *connection* (lib.ts,
  line 125), so it cannot key resume state.

### 2.3 Ack semantics

- **What acks**: the `Room`, after `this.pty.write(data)` returns in
  `handleInput` (rooms.ts, line 637). The ack means "accepted into the PTY
  stream", the strongest claim this server can honestly make (the PTY consumes
  writes; the app behind it may still do anything with them).
- **Cumulative, not per-message**: the server sends the highest contiguous seq
  written. Cumulative acks are self-healing — a lost ack is repaired by the
  next one — and keep the client's pruning logic trivial.
- **Coalesced**: acking every keystroke doubles message rate for no benefit.
  The server acks at most once per small flush window (~50 ms debounce, plus an
  immediate ack when the socket has been idle), always carrying the latest
  cumulative seq. Worst case this adds ~50 ms to loss *detection*, not to input
  latency.
- `input_rejected` (control locked, rooms.ts line 638–643) also carries the
  message's `seq` so the client can prune it from the retransmit buffer —
  rejected input is *resolved*, not lost, and must not be replayed later.

### 2.4 Client retransmit buffer

Replaces (web) / introduces (CLI) the disconnect-only buffer:

- Every sent `input` is appended to `unacked: Array<{seq, data, at}>` **at send
  time**, not at disconnect time. `input_ack` with seq N drops all entries ≤ N.
- On `readyState !== OPEN`, keystrokes are still appended (with fresh seqs) —
  this subsumes today's `pendingInputRef` behavior in `handleUserInput`.
- Bounds: cap at 256 entries / 32 KiB. On overflow drop the **oldest** entries
  and record that a gap exists so the user can be told input was lost (§2.6) —
  never silently.
- Age policy: entries older than a replay-age cap (keep the current 15 s
  `PENDING_INPUT_MAX_AGE_MS` value) are *not retransmitted* on resume — the
  existing judgment in App.tsx (lines 423–426: firing stale keystrokes into a
  shell is worse than losing them) still holds. But unlike today, dropping them
  is reported, not silent.

### 2.5 Reconnect / resume

On the new socket's `open` (web: `connect`'s open handler, App.tsx line 826;
CLI: `ws.on("open")`, index.ts line 2456):

1. The URL carried the same `instance` id, so the server can look up
   `lastSeqSeen` for this instance in the room (kept in `Room`, expiring after
   ~10 minutes without any connection from that instance).
2. The server includes `lastInputSeq: lastSeqSeen` in its `hello` message
   (schema in protocol.ts, line 24; already extended with optional fields
   like `created`, so this is additive).
3. The client prunes its unacked buffer to entries `> lastInputSeq` (those
   arrived before the drop — the "did my last keystroke make it?" race is
   resolved exactly), drops over-age entries (reporting the count), and
   retransmits the rest **in order, with their original seqs, before accepting
   new keystrokes into the send path** (new input queues behind the replay).
4. The server applies its normal dedup rule — ignore seq ≤ lastSeqSeen, write
   the rest — so a replay racing a late-arriving original is harmless.

### 2.6 Surfacing "input not delivered" to the user

The ack stream gives a precise health signal; use it in three escalating steps:

1. **Stall detection**: if the oldest unacked entry is older than ~2 s, send an
   app-level `{type:"ping", t}` (already in the protocol, already handled by
   the server at rooms.ts line 346 — currently unused). If neither an ack nor
   the pong arrives within ~2 more seconds, declare the socket suspect.
2. **Proactive reconnect**: on a suspect socket, the client closes it and
   reconnects immediately (`scheduleReconnect`, App.tsx line 785, entering at
   attempt 0). The retransmit buffer carries the in-flight keystrokes across;
   resume (§2.5) delivers exactly the ones that were lost. This converts
   "minutes of silent loss" into "~4 s pause, then delivery", with UI:
   web shows the existing toast/notice machinery ("Connection stalled —
   reconnecting, input preserved"); the CLI shows it in the status bar it
   already renders for reconnects (index.ts line 2354).
3. **Loss admission**: only when input actually cannot be delivered — buffer
   overflow (§2.4) or over-age drop (§2.5) — the client says so concretely:
   "N keystrokes from HH:MM:SS were not delivered", via `showToast`/`pushNotice`
   on web and the notice line on the CLI. Never claim more certainty than the
   acks provide.

## 3. Wire format

All changes are additive to `hay/packages/shared/src/protocol.ts`.

```ts
// clientMessageSchema — "input" gains an optional seq
z.object({
  type: z.literal("input"),
  data: z.string().min(1),
  seq: z.number().int().positive().optional(),   // absent = legacy client
})

// serverMessageSchema — new message + two extended ones
z.object({ type: z.literal("input_ack"), seq: z.number().int().positive() })

// "hello" gains (all optional):
//   inputAcks: z.boolean().optional()        — server speaks this protocol
//   lastInputSeq: z.number().int().optional() — resume point for this instance

// "input_rejected" gains:
//   seq: z.number().int().optional()          — which input was rejected
```

Connection URL gains `&instance=<uuid>` (parsed next to `room`/`name` in
`attachTermshare`, lib.ts, and in `scripts/hay-host.js`).

### Backward compatibility / negotiation

- **Old client, new server**: `input` arrives without `seq`; the server writes
  it exactly as today and sends no acks to that client. `hello.inputAcks` is
  ignored by old clients because the schemas are zod discriminated unions with
  optional extra fields — the codebase already uses this pattern for
  `hello.created` and `session_ended.by` (protocol.ts lines 32–34, 59–61).
- **New client, old server**: the client sends `seq` on `input`. Old servers
  parse with `safeParseClientMessage` and **unknown keys are tolerated** (zod
  objects strip unknown keys by default), so input still flows. The client
  learns the server is old from `hello` lacking `inputAcks: true` and degrades
  to exactly today's behavior (fire-and-forget + disconnect-only buffering),
  disabling stall detection so it never false-alarms.
- No version handshake beyond `hello.inputAcks` is needed.

## 4. Edge cases

- **Reconnect race (old socket half-dead, new socket open)**: the old
  connection's client entry still sits in `Room.clients` until its close fires.
  Resume state is keyed by `instance`, not by connection, so the new socket's
  dedup is correct regardless. If the zombie connection later flushes a
  duplicate `input` (TCP delivered it after all), its seq ≤ lastSeqSeen and the
  server drops it. Optionally, `attachClient` (rooms.ts line 243) can eagerly
  close a prior connection with the same `instance` id.
- **Duplicate delivery**: only possible path is "server wrote it, ack lost,
  client retransmits" — closed by the per-instance `lastSeqSeen` check before
  `pty.write`.
- **Ordering**: WebSocket delivery is ordered within a connection; seqs are
  assigned in send order; resume replays in seq order before new input. A gap
  in seqs at the server (seq jumps by >1) can only mean the client dropped
  overflowed/aged entries on purpose; the server accepts the jump and moves
  `lastSeqSeen` forward — it must not wait for a retransmission that will
  never come.
- **Buffer bounds**: client buffer capped (§2.4) with explicit loss reporting.
  Server per-instance state is one integer + timestamp per instance, expired
  after ~10 minutes disconnected; a room with many transient clients stays
  O(clients).
- **Multi-client on one session**: each client instance has an independent seq
  space and ack stream; `Room.handleInput` interleaves writes by arrival, same
  as today. Acks go only to the socket that sent the input (`client.socket`,
  as `input_rejected` does today), never broadcast.
- **System input**: `Room.sendSystemInput` (rooms.ts line 624), used by the
  daemon (`hop`, line 1345) and MCP paths, bypasses client sockets entirely and
  is unaffected.
- **Web replay concatenation**: today's replay joins buffered entries into one
  `input` message (App.tsx line 843). With seqs, replay must preserve one
  message per seq (or renumber after concatenation); the design keeps
  per-entry messages for exact dedup.

## 5. Alternatives considered

- **WebSocket ping/pong tightening (protocol-level heartbeat)**: server
  `ws.ping()` every ~10 s + `isAlive` sweep, clients watching pong gaps. This
  *detects* dead sockets in seconds but does nothing for the keystrokes already
  swallowed by the send buffer — detection without retransmission still loses
  input, and heartbeat intervals short enough to protect fast typists would be
  chatty. Worth doing *in addition* (it cleans up server-side zombie clients),
  but it does not close the loss window.
- **TCP keepalive**: not configurable from browser JavaScript at all, and
  default kernel timers are minutes long. Doesn't apply to the primary (phone
  browser) case.
- **Full request/response input** (each keystroke waits for its ack before the
  next is sent): maximal safety, but adds a full RTT of head-of-line blocking
  per keystroke — unusable on the high-latency mobile links that are exactly
  the scenario at issue. Sequence + cumulative ack gives the same delivery
  guarantee with pipelining.
- **Optimistic-echo reconciliation as detector**: the web client already
  diff-reconciles predicted echo against real output
  (`hay/apps/web/src/utils/optimisticEcho.ts`); "echo never confirmed" could
  flag loss. But it only covers printable characters in echoing contexts — not
  control keys, password prompts, or TUIs (and the CLI has no echo layer). Too
  weak to be the mechanism; remains a nice complement.

Sequence-acks win because they make the client's belief about delivery *match
reality* — detection, retransmission, dedup, and honest failure reporting fall
out of one small mechanism, and it degrades gracefully to today's behavior
when either side doesn't speak it.

## 6. Implementation plan (no code in this change)

Ordered so each step lands independently and old/new components interoperate
throughout:

1. **Protocol** — `hay/packages/shared/src/protocol.ts`: optional `seq` on
   `input` and `input_rejected`, new `input_ack` server message, optional
   `inputAcks`/`lastInputSeq` on `hello`. Tests in
   `hay/packages/shared/test/protocol.test.ts` (round-trips, legacy messages
   without the new fields still parse).
2. **Server** — `hay/apps/server/src/rooms.ts`: parse `instance` (plumbed
   through `ClientInfo` from `attachTermshare` in `lib.ts`,
   `hay/apps/server/src/index.ts`, and `scripts/hay-host.js`); per-instance
   `lastSeqSeen` map with expiry in `Room`; dedup + coalesced cumulative acks
   in `handleInput`; `lastInputSeq` in the `hello` sent by `attachClient`;
   `seq` echoed on `input_rejected`. Tests in
   `hay/apps/server/test/rooms.test.ts` (ack emission, dedup on replay,
   seq-gap tolerance, legacy no-seq client).
3. **Web client** — `hay/apps/web/src/App.tsx`: instance id + seq counter;
   replace `pendingInputRef` with the always-on unacked buffer in
   `handleUserInput`/`sendMessage`; prune on `input_ack`; resume logic in
   `connect`'s open/`hello` handling; stall detection using the existing
   `ping`/`pong`; suspect-socket proactive reconnect via `scheduleReconnect`;
   loss/stall toasts. New unit tests beside `hay/apps/web/test/` for the
   buffer/resume state machine (extracted into a `utils/` module like
   `optimisticEcho.ts` so it's testable headlessly).
4. **CLI client** — `hay/apps/cli/src/index.ts`: same buffer/resume module
   shared via `hay/packages/shared` if practical; fix the silent drop in
   `sendMessage` (line 1201) by buffering when not OPEN; status-bar/notice
   surfacing for stall and loss.
5. **Optional hardening (separate follow-up)** — server-side WebSocket-level
   heartbeat in `lib.ts`/`scripts/hay-host.js` to reap zombie connections
   (§5, first alternative).

Rollout risk is low: every hop deployment runs server and clients from the
same checkout (the daemon spawns `scripts/hay-host.js` and serves the web
bundle), so mixed versions occur only transiently, and both mixes degrade to
current behavior by design.
