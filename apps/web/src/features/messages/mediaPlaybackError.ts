import type { Language } from '../../app/i18n';

export function mediaPlaybackError(error: Pick<MediaError, 'code'> | null | undefined, lang: Language): string {
  const fa = lang === 'fa';
  switch (error?.code) {
    case 1: return fa ? 'پخش لغو شد. برای ادامه دوباره پخش را بزنید.' : 'Playback was canceled. Press play to continue.';
    case 2: return fa ? 'انتقال ویدئو قطع شد. دوباره تلاش کنید؛ اگر ادامه داشت دسترسی سرور به فایل را بررسی کنید.' : 'The video transfer was interrupted. Retry playback; if it continues, check the server’s access to the file.';
    case 3: return fa ? 'ویدئو آسیب دیده یا کدک آن با مرورگر سازگار نیست. نسخهٔ MP4 با تصویر H.264 و صدای AAC را امتحان کنید.' : 'The video is damaged or uses a codec this browser cannot decode. Try an MP4 with H.264 video and AAC audio.';
    default: return fa ? 'منبع ویدئو در دسترس نیست یا فرمت و کدک آن با مرورگر سازگار نیست. صرفاً پسوند MP4 سازگاری را تضمین نمی‌کند.' : 'The video source is unavailable or its format/codec is unsupported. An MP4 filename alone does not guarantee browser compatibility.';
  }
}
