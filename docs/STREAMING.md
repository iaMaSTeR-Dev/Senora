# Streaming and download behavior

Chat video, the public watch page and Watch Party share the same player. Ordinary
browser-compatible MP4/WebM files use native HTTP byte-range playback. File
extensions alone do not identify the container or codec. The client also detects
MPEG-TS sources saved with an MP4 extension.

For supported H.264 MPEG-TS sources, the Go backend scans the original source once
to build a bounded in-memory time/keyframe index. Authenticated requests expose
`?stream=index`, `?stream=playlist` and byte-range `?stream=hls` fragments. Existing
membership, shared-link passwords, expiry and bot visibility checks still apply.
The playlist covers the full indexed duration, allowing a jump directly to a later
minute. Indexing may take time for a large source; progress is reported to the player.

The backend creates no transcoded videos, segment files, media cache or temporary
video copies. It reads the existing local/S3 object and retains only metadata in
RAM (16 cached indexes, 30-minute idle TTL, a 16 GiB source limit and bounded
segments/playlists). Abandoned scans are cancelled. An index is rebuilt after a
server restart. This does not remove or relocate existing uploaded files.

The browser buffers playback and keeps up to 64 MiB of recently requested HLS
fragments in RAM. The timeline displays buffered/cached ranges. A cached backward
seek can reuse those bytes; an uncached seek requests the corresponding source
range. This cache is bounded and does not promise to retain an entire long film.

There is no server-side transcoding. Unsupported video/audio codecs still require
a compatible source or client player; not every file named MP4 is playable. The
seekable MPEG-TS path requires supported timing/keyframe information. Native
formats retain the browser's normal seeking behavior.

## Deployment

Preserve Range and If-Range headers and 206/416 responses through your proxy. Avoid
proxy buffering or disk caching for media routes. Keep the SPA watch route and
API pointed at the same release. `MAX_UPLOAD_BYTES` defaults to 500 MiB; larger
uploads require matching backend and proxy limits. Existing larger objects can
still be streamed. For Nginx, review `proxy_buffering off`, `proxy_request_buffering
off` and your upload/read timeouts on the API location.

`/dl` uses bounded jobs, download-size/time budgets, free-disk reservations, process
cancellation and cleanup of failed/abandoned temporary downloads. Downloading and
uploading media can still write original files: the no-disk-copy policy applies
to playback and indexing. See `internal/downloader/budget.go` for configurable
limits and `docs/DEPLOYMENT.md` for storage setup.
