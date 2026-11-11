// MPEG-TS has no MP4 sample index. Seeking outside the buffered window cannot
// be delegated to mpegts.js; do not let controls jump into an empty time range.
export function videoSeekBounds(video: HTMLVideoElement | null): [number, number] {
  if (!video) return [0, 0];
  if (video.dataset.streamEngine === 'mpegts') {
    return video.buffered.length ? [video.buffered.start(0), video.buffered.end(video.buffered.length - 1)] : [0, 0];
  }
  return [0, Number.isFinite(video.duration) ? video.duration : 0];
}

export function clampVideoSeek(video: HTMLVideoElement, target: number): number {
  const [start, end] = videoSeekBounds(video);
  return Math.max(start, Math.min(Math.max(start, end - 0.05), target));
}
