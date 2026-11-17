# Collaboration Sharing and Permissions — Iteration 1

This document defines the sharing model for Iteration 2. A project has one owner and zero or more collaborators. Every server-side operation resolves the authenticated user and project membership before reading or changing project data. The client must not be trusted to supply a role, owner ID or permission decision.

## Roles

| Role | Read project | Edit notes, tracks and settings | Manage collaborators | Delete project / transfer ownership |
| --- | --- | --- | --- | --- |
| Owner | Yes | Yes | Yes | Yes |
| Editor | Yes | Yes | No | No |
| Viewer | Yes | No | No | No |

The owner is also represented in the collaborator view as `OWNER`, but ownership is authoritative on the project record. There can be only one owner. An owner may change a collaborator's role or remove a collaborator, but may not remove themself without transferring ownership first. Editors and viewers cannot grant or escalate permissions.

## Collaborator table

Suggested relational table: `project_collaborators`.

| Column | Type | Rules |
| --- | --- | --- |
| `project_id` | UUID / foreign key | Required; references the project; cascades on project deletion |
| `user_id` | UUID / foreign key | Required; references `users`; identifies the collaborator |
| `role` | `OWNER`, `EDITOR` or `VIEWER` | Required; exactly one `OWNER` per project |
| `invited_by` | UUID / foreign key | Required for non-owner rows; identifies the owner who granted access |
| `created_at` | timestamp | Required; set by the server |
| `updated_at` | timestamp | Required; set by the server on role changes |

Constraints:

- Primary key is `(project_id, user_id)`; a user can appear only once per project.
- Enforce one owner per project with a database constraint or transaction-safe service check.
- Do not accept `role`, `invited_by`, timestamps or project ownership fields from an untrusted client.
- Invites should resolve to an existing user before inserting a collaborator row. Return `404` for an unknown user and `409` for an existing membership.
- Removing a membership revokes access immediately, including active WebSocket sessions on their next message or authorization check.

## Server-side endpoint rules

All endpoints require an authenticated user. `401 Unauthorized` means no valid session. `403 Forbidden` means the user is authenticated but lacks the required project role. Project lookup must happen before returning project data; do not authorize from a client-supplied `projectId` or `userId` alone.

| Endpoint | Required role | Server-side rule |
| --- | --- | --- |
| `GET /collaboration-test` | Authenticated user | Render the prototype page only. The page must not expose project data until a project-specific request passes membership authorization. |
| `GET /api/projects/{projectId}` | Owner, Editor or Viewer | Return project metadata and content only after membership lookup. |
| `GET /api/projects/{projectId}/collaborators` | Owner, Editor or Viewer | Return the project's collaborator list. Do not return collaborators from another project. |
| `POST /api/projects/{projectId}/collaborators` | Owner | Add an existing user as `EDITOR` or `VIEWER`. Reject `OWNER` requests; set `invited_by` and timestamps on the server. |
| `PATCH /api/projects/{projectId}/collaborators/{userId}` | Owner | Change only the target membership's role between `EDITOR` and `VIEWER`. Never create a second owner. |
| `DELETE /api/projects/{projectId}/collaborators/{userId}` | Owner | Remove the target membership. Reject removal of the owner; ownership transfer is a separate transaction. |
| `POST /api/projects/{projectId}/ownership` | Owner | Transfer ownership atomically: demote the current owner and promote the target member in one transaction. |
| `POST /app/projects/{projectId}/sync` (STOMP) | Owner or Editor | Verify membership and role before accepting `ADD_TRACK`, `EDIT_NOTE`, `SET_BEAT` or other mutating changes. Ignore or reject client `projectId` mismatches; use the destination variable as the project scope. |
| `POST /app/projects/{projectId}/sync` with `REQUEST_STATE` | Owner, Editor or Viewer | Verify membership before replaying state. A viewer may request and receive state but cannot publish mutations. |
| `/topic/projects/{projectId}` subscription | Owner, Editor or Viewer | Broker delivery must be limited to authorized project members. Subscription authorization is required in addition to controller checks. |
| `DELETE /api/projects/{projectId}` | Owner | Delete the project, collaborator rows and project content in one transaction. |

For rejected STOMP messages, use an application error response and do not broadcast the change. The server should derive the actor from the authenticated session rather than trusting `ProjectChange.userId`; retain that field only as audit metadata populated server-side. Validate change type and payload before storing or broadcasting it.

## Iteration 2 implementation notes

1. Add project membership lookup as a service used by both HTTP controllers and the WebSocket message handler.
2. Apply the same authorization policy to state replay and mutations; read access is not edit access.
3. Store accepted changes only after authorization and validation succeed.
4. Add tests for owner, editor and viewer access to every route above, including a viewer attempting `EDIT_NOTE` and a user attempting to access a different project.