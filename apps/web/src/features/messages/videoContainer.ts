// File extensions and stored MIME types are not reliable for HLS downloads.
export function isTransportStream(bytes: Uint8Array): boolean {
  for (const stride of [188, 192, 204]) {
    for (let offset = 0; offset < stride && offset + stride * 3 < bytes.length; offset++) {
      if ([0, 1, 2, 3].every(packet => bytes[offset + packet * stride] === 0x47)) return true;
    }
  }
  return false;
}

export async function probeTransportStream(src: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(src, { headers: { Range: 'bytes=0-1023' }, signal, cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error('Media source unavailable');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(1024);
  let length = 0;
  try {
    while (length < bytes.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, bytes.length - length);
      bytes.set(value.subarray(0, count), length);
      length += count;
    }
  } finally {
    // An origin may ignore Range. Never read its whole movie for detection.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return isTransportStream(bytes.subarray(0, length));
}

export function continuousStreamURL(src: string): string {
  const url = new URL(src, window.location.href);
  if (url.origin === window.location.origin &&
      /^\/api\/v1\/(s\/|attachments\/)/.test(url.pathname)) {
    url.searchParams.set('stream', 'continuous');
  }
  return url.href;
}
