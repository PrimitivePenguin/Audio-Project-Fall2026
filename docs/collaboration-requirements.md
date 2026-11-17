# JukeBox Collaboration Requirements — Iteration 1

## Purpose

JukeBox needs a real-time collaboration foundation before project sharing and conflict handling are implemented. These requirements cover four Collaboration stories for Iteration 1. The prototype is exploratory and uses placeholder project JSON; it is not the final persistence or authorization model.

## Scope and assumptions

- Collaboration is scoped to one project identified by `projectId`.
- The prototype uses Spring WebSockets with STOMP.
- The current transport uses `/ws` for the WebSocket connection, `/app` for client messages and `/topic` for project broadcasts.
- A project snapshot contains placeholder JSON only. The real sequencer persistence format is not finalized.
- Track beat patterns are represented by a `steps` array in the placeholder snapshot.
- Audio is local/runtime data in the prototype. Audio bytes are not sent through WebSocket messages or embedded in project JSON.
- Authentication, persistent projects and production permissions are Iteration 2 concerns.

## User stories and acceptance criteria

### Collaboration-1: Research synchronization approaches

**Story:** As a developer, I want to research real-time synchronization approaches so we can choose an appropriate technology for JukeBox.

**Requirements:**

- Compare HTTP polling and WebSockets.
- Record benefits, costs and operational risks for both approaches.
- Recommend one approach for live collaboration.
- Record integration requirements for transport, reconnects, authorization, state replay and conflict detection.
- Define the project JSON requirements needed for synchronization:
  - stable IDs for projects, tracks and notes;
  - a schema `version` that identifies the JSON shape;
  - a server `revision` or equivalent state version for optimistic checks;
  - audio represented by an external asset reference, URL or storage key, not embedded bytes.

**Acceptance criteria:**

- [collaboration-sync-research.md](collaboration-sync-research.md) compares polling and WebSockets.
- The document recommends WebSockets/STOMP for live edits and explains why.
- The document identifies reconnect, replay, ordering, authorization and conflict trade-offs.
- The JSON contract explicitly includes stable IDs, `version`, `revision` and external audio references.

### Collaboration-2: Prototype two-session synchronization

**Story:** As a developer, I want to prototype synchronization between two browser sessions so that we can validate that project changes can propagate between users.

**Requirements:**

- Provide a standalone collaboration page at `/collaboration-test`.
- Allow two browser sessions to connect to the same `projectId` using different user IDs.
- Allow one session to edit the placeholder project name and publish the change.
- Show the changed project name and JSON snapshot in the other connected session.
- Allow a newly connected session to request existing project state.
- Include track beat patterns in the placeholder JSON as `tracks[].steps`.
- Keep live beat changes as incremental `SET_BEAT` messages while updating the local JSON snapshot.
- Queue mutation messages locally while disconnected and send them after reconnecting to the same project.

**Acceptance criteria:**

- Session A connects to project `demo-project` and changes the project name.
- Session B connects to `demo-project` and receives the project change through the project topic.
- Session B displays the updated name in its placeholder JSON.
- A track's beat pattern is represented as a boolean `steps` array in the JSON snapshot.
- A state request replays changes created before Session B connected.
- Audio data is not required for project synchronization.

**Prototype message contract:**

```json
{
  "projectId": "demo-project",
  "userId": "browser-user",
  "type": "UPDATE_PROJECT",
  "targetId": "demo-project",
  "payload": { "name": "Renamed demo" },
  "timestamp": 1730000000000
}
```

The prototype currently stores accepted changes in server memory and broadcasts them to `/topic/projects/{projectId}`. This is sufficient for the demo but is not durable persistence.

### Collaboration-3: Design sharing and permissions

**Story:** As a developer, I want to design the sharing and permissions model so that Iteration 2 can implement it directly.

**Requirements:**

- Define `Owner`, `Editor` and `Viewer` roles.
- Define the collaborator table, membership uniqueness and owner invariant.
- Define read, edit, collaborator-management and project-management permissions.
- Define server-side rules for HTTP project endpoints, collaborator endpoints, WebSocket subscriptions and STOMP mutations.
- Require authorization from server-side session identity and project membership, not client-supplied role or user ID.
- Define `401` versus `403` behavior and rejection behavior for unauthorized STOMP messages.

**Acceptance criteria:**

- [collaboration-permissions.md](collaboration-permissions.md) defines all three roles and their capabilities.
- The document defines the collaborator table and constraints, including one owner per project and a unique `(project_id, user_id)` membership.
- The document defines endpoint rules for reading state, mutating project content, managing collaborators, transferring ownership and deleting a project.
- The document states that viewers can read but cannot publish mutations.
- The document identifies the authorization work required in Iteration 2.

### Collaboration-4: Test simultaneous edits and conflicts

**Story:** As a developer, I want to test two sessions editing at the same time so that we know which conflicts matter.

**Requirements:**

- Test two sessions publishing changes to the same stable note or project target.
- Record whether both changes are accepted, broadcast and replayed.
- Distinguish same-target conflicts from independent edits to different targets.
- Identify the current behavior when no version check exists.
- Propose a policy for stale updates and rejected changes.

**Observed Iteration 1 behavior:**

- The current controller accepts both same-target changes because `ProjectChange` has no base revision.
- Both changes are broadcast to the project topic.
- A later state request replays both changes in server arrival order.
- A client applying both updates sequentially can show the last received value, which silently hides the other user’s edit.
- Changes to different note IDs are independent and are not inherently conflicting.

**Proposed policy for Iteration 2:**

- Add `baseRevision` to each mutating message.
- Maintain a monotonically increasing server revision per project.
- Accept a mutation only when its base revision is current.
- Reject stale mutations with a conflict response containing the current revision and a fresh snapshot or change list.
- Keep same-note conflicts visible for user review rather than silently using last-write-wins.
- Permit independent changes to different targets to be merged when the server can prove they do not conflict.
- Keep rejected local changes in the outbox until the user retries or discards them.

**Acceptance criteria:**

- `ProjectSyncControllerTest` covers two sessions editing the same target.
- Tests verify that the current prototype observes both changes and preserves their arrival order.
- The requirements identify the absence of revision checks as the current limitation.
- The requirements specify version checking and stale-update rejection as the recommended policy.

## Cross-cutting functional requirements

| ID | Requirement |
| --- | --- |
| COL-FR-01 | Project messages must be scoped by the destination `projectId`. |
| COL-FR-02 | Project and track IDs must remain stable across snapshots and incremental changes. |
| COL-FR-03 | A state request must not be stored as a project mutation. |
| COL-FR-04 | A reconnecting client must be able to request current state and flush queued mutations for the same project. |
| COL-FR-05 | The server must validate message type, target and payload before storing or broadcasting a mutation. |
| COL-FR-06 | The final project format must keep audio references separate from project JSON content. |
| COL-FR-07 | Unauthorized users must not receive project state or mutate project content once permissions are implemented. |

## Quality and operational requirements

- Live edits should be delivered without polling delay during a healthy WebSocket connection.
- Reconnect handling must not send queued changes to a different project.
- Duplicate state replay must be idempotent by stable ID where possible.
- The server must not rely on client timestamps for authoritative ordering; server arrival or assigned revision is authoritative.
- The prototype may use in-memory state, but production synchronization requires durable project persistence and a recovery snapshot.
- WebSocket messages must remain small and must never carry raw audio files.

## Out of scope for Iteration 1

- Final project database schema and persistence implementation
- Production authentication and collaborator management endpoints
- Complete CRDT or operational-transform implementation
- Binary audio synchronization or shared audio storage
- Final note-level conflict UI
- Cross-server WebSocket broker configuration

## Traceability

| Story | Primary artifact | Current validation |
| --- | --- | --- |
| Collaboration-1 | [collaboration-sync-research.md](collaboration-sync-research.md) | Research and integration requirements |
| Collaboration-2 | [collaboration-test.html](../src/main/resources/templates/collaboration-test.html) | Two-session manual demo and state replay tests |
| Collaboration-3 | [collaboration-permissions.md](collaboration-permissions.md) | Permissions design and endpoint matrix |
| Collaboration-4 | [ProjectSyncControllerTest.java](../src/test/java/com/cmpt276group18/audio_project/collaboration/ProjectSyncControllerTest.java) | Concurrent same-target and replay tests |
