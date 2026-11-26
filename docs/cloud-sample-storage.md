# Cloud Sample Storage (Cloudflare R2)

Audio samples used in an arrangement are now uploaded to Cloudflare R2 so a project can be opened on any device or by any collaborator, without relinking the original files.

## Overview

Previously, samples lived only in the browser (IndexedDB via `SampleAssetStore`) or in memory for the session. Project JSON stored only metadata (`id`, `name`, `duration`), so a project opened elsewhere showed "Missing audio · relink original file".

Now:

1. When a sample is imported, the browser uploads it directly to R2 using a short-lived presigned URL.
2. The sample's public URL is saved in the project JSON (`assets[].url`).
3. When a project is loaded and a sample isn't available locally, the browser downloads it from that URL, verifies its hash, caches it locally, and decodes it.

The server never handles the audio bytes. It only validates the request and issues the presigned URL.

## Upload flow

```
Browser                         Spring Boot                     Cloudflare R2
   |  POST /samples/presign         |                                |
   |------------------------------->|  assertEditor(project, user)   |
   |                                |  validate sha256 + content type|
   |  { uploadUrl, publicUrl, key } |  sign PUT URL (10 min)         |
   |<-------------------------------|                                |
   |  PUT uploadUrl (audio bytes)   |                                |
   |------------------------------------------------------------->  |
   |  asset.url = publicUrl         |                                |
```

Samples are content-addressed: the object key is `projects/{projectId}/{sha256}.{ext}`. Re-importing the same file reuses the same key, and objects are served with `Cache-Control: public, max-age=31536000, immutable`.

## API

### `POST /api/projects/{projectId}/samples/presign`

Requires a logged-in session and editor access to the project (owner/editor; viewers are rejected).

**Request body**

```json
{
  "sha256": "<64 lowercase hex chars>",
  "fileName": "kick.wav",
  "contentType": "audio/wav"
}
```

**Response `200`**

```json
{
  "uploadUrl": "https://<account>.r2.cloudflarestorage.com/...signed...",
  "publicUrl": "https://<public-base>/projects/<projectId>/<sha256>.wav",
  "objectKey": "projects/<projectId>/<sha256>.wav"
}
```

**Errors**

| Status | When |
|--------|------|
| `400` | `sha256` is missing or not 64 lowercase hex chars; `contentType` is not `audio/*` |
| `401` | No logged-in user |
| `503` | R2 is not configured on the server (missing credentials or public URL) |
| Access/not-found | Handled by existing `ProjectAccessException` / `ProjectNotFoundException` handlers |

Error responses use the shape `{ "error": "message" }`.

**Notes**

- Allowed extensions: `wav`, `mp3`, `ogg`, `flac`, `m4a`. An unknown or missing extension falls back to `wav`.
- The presigned URL expires after 10 minutes.
- The upload must send the same `Content-Type` and `Cache-Control` headers that were signed. The client does this automatically.

## Configuration

Set these environment variables (or put them in a local `.env` file, which is loaded via `spring.config.import`):

| Variable | Required | Description |
|----------|----------|-------------|
| `R2_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Yes | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | Yes | R2 API token secret |
| `R2_PUBLIC_URL` | Yes | Public base URL of the bucket (custom domain or `r2.dev` URL) |
| `R2_BUCKET` | No | Bucket name. Defaults to `cmpt276-daw-samples` |

The database settings now also come from the environment instead of being hard-coded:

| Variable | Description |
|----------|-------------|
| `DB_URL` | JDBC URL, e.g. `jdbc:postgresql://host/dbname` |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |

If the R2 variables are missing, the app still starts. Presign requests return `503` and samples fall back to browser-only storage.

### Bucket setup

1. Create the R2 bucket and enable public access (custom domain or `r2.dev`).
2. Add a CORS policy so the browser can upload directly. It must allow your app's origin, the `PUT` method, and the `Content-Type` and `Cache-Control` request headers. It must also allow `GET` for downloads.
3. Create an R2 API token scoped to the bucket with object read/write permission.

## Data model

Project JSON assets gain an optional `url` field:

```json
{
  "assets": [
    {
      "id": "<sha256>",
      "name": "kick.wav",
      "duration": 0.42,
      "url": "https://<public-base>/projects/<projectId>/<sha256>.wav"
    }
  ]
}
```

- `url` is optional, so existing projects load unchanged.
- On load, only `http(s)` URLs are accepted. Anything else is dropped.
- `AudioArrangement.toJSON()` writes `url` back when present.

## Client behavior (`ArrangementEditor.js`)

**Import (`importFiles`)**
- Hashes the file (SHA-256) to get the asset ID, decodes it, and stores it in the browser.
- Uploads it to R2 via `uploadAssetToCloud`. A cloud failure does not block the import. It is reported as `"<file> (cloud sync): <error>"` and the sample stays usable locally.
- If an asset exists with a buffer but no URL, re-importing the file uploads it.

**Save (`ensureAssetsUploaded`)**
- Runs before every project save. Any asset without a `url` that exists in the local store is uploaded first, so saved projects always reference cloud copies where possible.

**Load (`restoreAssets`)**
1. Read from the local store.
2. If missing and the asset has a `url`, download it, check the SHA-256 against the asset ID, cache it locally, then decode.
3. If the download fails or the hash doesn't match, the asset is flagged `fetchFailed` and is not retried automatically. The rack offers relinking as before.

**Rack status labels**

| Label | Meaning |
|-------|---------|
| `Ready · cloud & browser` | Uploaded and cached locally |
| `Ready · cloud` | Uploaded, not cached locally |
| `Ready · stored in this browser` | Local only (not uploaded) |
| `Ready · session only` | In memory only |
| `Missing audio · relink original file` | No local copy and cloud fetch failed or no URL |

## Backend changes

- `R2StorageService` (new): builds the S3 presigner against `https://{accountId}.r2.cloudflarestorage.com` (region `auto`, path-style), validates input, and creates presigned PUT URLs.
- `ProjectService.assertEditor`: checks that the project exists and the user can edit it.
- `ProjectController`: new presign endpoint plus handlers mapping `IllegalArgumentException` to `400` and `IllegalStateException` to `503`.
- `pom.xml`: adds `software.amazon.awssdk:s3:2.30.15`.

## Security notes

- Only authenticated project editors can request upload URLs.
- Uploads are limited to `audio/*` content types and an allow-listed set of extensions.
- Objects are keyed by content hash and project ID. Downloads are re-hashed on the client before use.
- Public bucket URLs are unauthenticated. Anyone with a sample's URL can fetch it.

## Limitations

- The server does not verify that uploaded bytes match the claimed SHA-256 or content type. Verification happens client-side on download.
- Objects are never deleted from R2 when a sample is removed from a project.
- Samples are stored per project, so the same file used in two projects is uploaded twice.
