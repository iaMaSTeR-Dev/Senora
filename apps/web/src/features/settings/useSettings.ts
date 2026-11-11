import { useEffect, useState } from 'react';
import { AppSettings, loadSettings } from './settingsModel';

export function useSettings(): AppSettings {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => {
    const update = () => setSettings(loadSettings());
    window.addEventListener('senora:settings-changed', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('senora:settings-changed', update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return settings;
}

export function shouldAutoDownload(settings: AppSettings, attachment: { isViewOnce?: boolean; isPhoto?: boolean; isVideo?: boolean; isRoundVideo?: boolean; isVoice?: boolean; isSticker?: boolean; contentType?: string; sizeBytes?: number }): boolean {
  if (attachment.isViewOnce || settings.lowDataMode || (attachment.sizeBytes || 0) > 20 * 1024 * 1024) return false;
  if (attachment.isVideo || attachment.isRoundVideo || attachment.contentType?.startsWith('video/')) return settings.autoDownloadVideos;
  if (attachment.isPhoto || attachment.isSticker || attachment.contentType?.startsWith('image/')) return settings.autoDownloadPhotos;
  return settings.autoDownloadFiles;
}
