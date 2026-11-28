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
- Queues an R2 upload in the background. A cloud failure leaves the asset in the browser or in memory, as indicated by its rack status.

**Save (`ensureAssetsUploaded`)**
- The database write starts without waiting for transfers. Background retries handle samples with available bytes and no valid cloud URL for the current project.

**Load (`restoreAssets`)**
1. Try the local store.
2. After a miss or storage error, download from the available URL, check SHA-256, try caching it, then decode.
3. After a failed transfer, retry from the rack or relink the exact original bytes. The next online event can also trigger a retry.

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

### Saving and retrying transfers

Save Project writes the current composition and available URLs to PostgreSQL first. It
reports how many assets have a cloud URL for this project, are browser-only, are
memory-only, or are missing. Uploads run in the background with a 12-second deadline
per sample transfer. A later accepted collaboration update publishes the uploaded
URL. If live collaboration is unavailable, save explicitly again after upload.

Use **Retry sample transfers** to retry failed downloads and uploads and to check a
stored cloud copy for staleness. The browser also retries when it comes back online.
A sample shared into a different project is uploaded under that project's key.
Downloads are hash-checked even when IndexedDB is unavailable. If both the database
request and WebSocket are unreachable, a server save requires reconnecting.

Cloud object reads still use public URLs. Project roles protect presigning and
project metadata, and do not make an already-distributed object URL private.
Rack deletion does not clean up R2 objects. Presigning validates the claimed hash
and media type, while the original byte integrity check takes place on download.
