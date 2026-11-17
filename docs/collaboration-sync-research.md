# Real-Time Synchronization Research — Collaboration-1, Iteration 1

## Decision

JukeBox should use WebSockets with STOMP for real-time project synchronization. The prototype already has the required Spring messaging setup: clients publish changes to `/app/projects/{projectId}/sync` and subscribe to `/topic/projects/{projectId}`. This supports low-latency updates while multiple users edit the same project.

## Polling versus WebSockets

| Approach | Benefits | Costs and risks |
| --- | --- | --- |
| Polling | Simple HTTP model; easy to debug and deploy; works through most proxies; reconnects naturally by making the next request | Adds delay between edits and display; repeatedly sends requests when nothing changed; increases server and network load; requires cursors or timestamps to avoid missing or duplicating changes |
| WebSockets | Low-latency server push; one connection supports continuous collaboration; efficient when edits are frequent; fits the existing STOMP topic model | Requires connection lifecycle handling, reconnect and offline queues; proxy/load-balancer support must be configured; authorization must cover both connection and project subscriptions; concurrent edits still need ordering/conflict rules |

Polling would be acceptable for occasional project refreshes or a fallback transport, but it does not fit the interactive note and track editing experience as well as a persistent connection. WebSockets are recommended for live edits; HTTP remains appropriate for initial project loading, persistence, collaborator management and recovery after a missed connection.

## Integration requirements

### Transport and server

- Keep the Spring WebSocket endpoint at `/ws`, application prefix `/app` and broker prefix `/topic`.
- Scope every message to the destination project ID. The server must use the destination variable for authorization and must not trust a client-supplied project ID or user ID.
- Authenticate the connection and authorize each project subscription and mutation. Viewers may request state and receive updates; only owners and editors may publish edits.
- Store accepted changes only after validating their type, target and payload. Broadcast accepted changes to the project topic.
- Provide a state request/replay path for newly connected users and reconnecting users. Clients need a project/user-scoped local outbox for edits created while disconnected.
- Define ordering and conflict behavior for simultaneous edits. Every change should include an actor, target ID, timestamp and a server-assigned sequence or revision so clients can detect stale state.
- Keep WebSocket messages small. Do not send audio bytes through the collaboration channel.

### Project JSON contract

The synchronized project document must preserve application identity and support optimistic version checks:

```json
{
  "version": 2,
  "revision": 17,
  "name": "JukeBox",
  "ppq": 480,
  "tracks": [{ "id": "piano", "name": "Piano", "channel": 0, "program": 0 }],
  "notes": [{
    "id": "note-1",
    "midi": 60,
    "ticks": 17,
    "durationTicks": 720,
    "trackId": "piano"
  }],
  "audio": [{
    "id": "kick",
    "url": "/projects/demo-project/audio/kick.wav",
    "hash": "sha256:..."
  }]
}
```

- `version` identifies the JSON schema and must be incremented when the document shape changes. It is not a per-edit counter.
- `revision` identifies the server state revision. A mutation should include the client base revision; the server accepts it, rejects it as stale, or returns a conflict according to the chosen policy.
- Notes and tracks require stable IDs. Edits and deletes target IDs, never array positions or pitch/start-time combinations, so duplicate and overlapping notes remain independent.
- Audio is referenced by an asset ID and URL or storage key, with an optional content hash. Audio data must not be embedded in project JSON or WebSocket messages.
- Tick timing, PPQ, track identity and note metadata remain in the project document. Runtime `AudioBuffer` objects, Web Audio nodes and other browser-only state do not.
- Full snapshots and incremental changes must use the same IDs and schema version. A client that cannot read the document version must reject it and request migration or a compatible snapshot.

## Trade-offs and follow-up

WebSockets give the best editing experience but add lifecycle and correctness work. The first implementation should use server-ordered append-only changes plus snapshot replay. It should reject stale destructive edits or require a fresh revision before applying them; silently overwriting another user’s note would be unsafe. More advanced CRDT or operational-transform logic can be considered later if simultaneous fine-grained edits become common.

## Collaboration-4: Two-session conflict test

### Scenario tested

Two sessions in the same project publish `EDIT_NOTE` changes for the same stable note ID at nearly the same time. Each session represents a different user and sends a different pitch in its payload.

### Conflicts observed

- The server accepts both changes because the current `ProjectChange` has no base revision and the controller performs no conflict check.
- Both changes are broadcast to the project topic.
- A later state request replays both changes in server arrival order.
- The current prototype has no merge rule for two edits to the same note. A client applying the events sequentially will display the last received pitch, so the other edit is effectively overwritten in that client view even though both events were retained.
- Concurrent changes to different note IDs are not inherently conflicting and can be applied independently.

The behavior is covered by `ProjectSyncControllerTest.concurrentEditsToTheSameNoteAreAllStoredAndBroadcast` and `ProjectSyncControllerTest.replayKeepsConcurrentEditsForTheSameNoteInArrivalOrder`.

### Proposed policy

Use optimistic version checks for Iteration 2:

1. Include `baseRevision` in every mutating change. The server maintains a monotonically increasing project revision and assigns the accepted change's `revision`.
2. Accept a change only when `baseRevision` equals the current project revision. Otherwise reject it with a conflict response containing the current revision and a fresh project snapshot or change list.
3. Keep stable note IDs as the conflict target. Two edits to different notes may both succeed even when they originate from the same base revision; same-note edits should be rejected or explicitly rebased rather than silently last-write-wins.
4. For a rejected edit, the client refreshes state, shows that its local edit needs review, and keeps the unsent change in its local outbox until the user retries or discards it.
5. Use server arrival order only for ordering accepted changes, not as an implicit conflict-resolution policy.

This policy is simpler to explain and test than last-write-wins, prevents silent loss of a collaborator's edit, and leaves room for a later field-level merge or CRDT approach if note editing becomes more granular.

