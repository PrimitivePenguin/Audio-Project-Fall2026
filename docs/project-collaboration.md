# Project persistence and collaboration API

Projects are persisted by the backend and identified by UUIDs. The existing editor
can continue using its local project store while the editor work is in progress;
it can adopt these endpoints later without a frontend merge dependency.

All endpoints require the logged-in session. A user only sees projects in which
they have a row in `project_collaborators`.

| Method | Endpoint | Permission | Purpose |
|---|---|---|---|
| `GET` | `/api/projects` | authenticated | List accessible projects |
| `POST` | `/api/projects` | authenticated | Create a project and its owner row |
| `GET` | `/api/projects/{id}` | owner/editor/viewer | Read project data |
| `PUT` | `/api/projects/{id}` | owner/editor | Update name and/or `projectData` |
| `DELETE` | `/api/projects/{id}` | owner | Delete project |
| `GET` | `/api/projects/{id}/collaborators` | owner/editor/viewer | List collaborators |
| `POST` | `/api/projects/{id}/collaborators` | owner | Add an `EDITOR` or `VIEWER` |
| `PATCH` | `/api/projects/{id}/collaborators/{userId}` | owner | Change editor/viewer role |
| `DELETE` | `/api/projects/{id}/collaborators/{userId}` | owner | Remove non-owner collaborator |
| `POST` | `/api/projects/{id}/leave` | editor/viewer | Leave the project |
| `POST` | `/api/projects/{id}/transfer-ownership` | owner | Transfer ownership |

`GET /api/projects` includes the current user's `role` for each project. The
dashboard uses that role to show only permitted actions. Owners cannot leave;
they must transfer ownership first.

The dashboard's **Load in editor** action opens `/project/{id}`. That route
serves the editor page, which fetches the project data during initialization
through the permission-protected API. The existing local project library
continues to work independently.

When a database project is loaded, owners and editors can use **Save Project**
to persist note, track, tempo, loop, and pattern changes. Viewers cannot edit
or save and remain read-only by permission enforcement. The explicit snapshot
save is intentionally isolated behind one function so it can later be replaced
by WebSocket operations.

`POST /api/projects` accepts `{"name":"...", "projectData":"..."}`.
Collaborator endpoints use `{"usernameOrEmail": "teammate", "role": "EDITOR"}`.
Ownership transfer uses `{"usernameOrEmail": "teammate@example.com"}`.

The current user table uses integer IDs, so `project_collaborators.user_id` and
`invited_by` retain that existing type for a safe additive migration. Project IDs
are UUIDs. Converting users to UUID primary keys should be a separate migration,
not coupled to editor development.


## Instrument configuration in projectData

The browser database snapshot adds an optional `instruments` envelope with `version: 1`, `synth.tracks` (stable MIDI track IDs and waveform/ADSR/cutoff/gain settings) and `drums` (canonical stepCount, fixed kit track IDs, boolean patterns and per-drum gain). This is additional JSON text only: UUIDs, ownership, collaborator roles, backend authorization, database schema and optimistic `version` checking are unchanged. Save reads current APIs; successful PUT advances the local version, and 409 is surfaced without an automatic overwrite/retry.

`/project/{UUID}` forwards the same editor HTML as `/index.html`; all entry assets, including instruments and contour modules, use root-absolute URLs. The editor fetches/loads the composition and loops before `jukebox:ready`. Instrument listeners restore validated state before UI render. Old projects without state use defaults. Viewer configuration is inspectable but read-only in the UI/API, and PUT remains permission-protected on the server.

Generated drum buffers rebuild locally from supported settings. Uploaded audio bytes are **not** saved: metadata explicitly says `audioPersisted: false`, the editor shows an unavailable-audio notice after reload, and re-upload is required. Trigger metadata survives saves and is reconnected on re-upload. No persistent audio storage or new endpoint is implied. Local-library/MIDI serialization remains independent; the database snapshot is the extension point.

See [sequencer integration](sequencer-api.md#post-merge-dashboard-and-instrument-integration) for field shapes and the manual browser checklist. Dashboard body scrolling is scoped to `dashboard-page` so it does not alter editor viewport behavior.
