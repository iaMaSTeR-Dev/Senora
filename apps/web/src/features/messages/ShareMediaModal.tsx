import React, { useState } from 'react';
import { Attachment, MediaShare } from '../../app/types';
import { api } from '../../protocol/api';
import { serverManager } from '../../protocol/serverManager';
import { X, Share2, Lock, Clock, Download, Copy, Check, ExternalLink, Play, Sparkles } from 'lucide-react';

interface ShareMediaModalProps {
  attachment: Attachment;
  isOpen: boolean;
  onClose: () => void;
}

export const ShareMediaModal: React.FC<ShareMediaModalProps> = ({
  attachment,
  isOpen,
  onClose,
}) => {
  const [password, setPassword] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [expiresInHours, setExpiresInHours] = useState<number>(0);
  const [maxDownloads, setMaxDownloads] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [shareResult, setShareResult] = useState<MediaShare | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const getBaseOrigin = () => {
    const activeServer = serverManager.getActiveServer();
    if (activeServer.url && activeServer.url.startsWith('http')) {
      return activeServer.url.replace(/\/+$/, '');
    }
    return window.location.origin;
  };

  const handleCreateShare = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.createMediaShare(attachment.id, {
        password: usePassword ? password : '',
        expiresInHours: expiresInHours > 0 ? expiresInHours : undefined,
        maxDownloads: maxDownloads > 0 ? maxDownloads : undefined,
      });
      setShareResult(res.share);
    } catch (e: any) {
      setError(e.message || 'Failed to create media share');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2500);
  };

  const origin = getBaseOrigin();
  const directStreamUrl = shareResult ? `${origin}/api/v1/s/${shareResult.id}` : '';
  const vanityStreamUrl = shareResult ? `${origin}/s/${shareResult.id}` : '';
  const webPlayerUrl = shareResult ? `${origin}/watch/${shareResult.id}` : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-100">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/40">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <Share2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">لینک استریم مستقیم و پلیر تحت وب</h2>
              <p className="text-xs text-slate-400">RFC 7233 Byte-Range Stream & Web Player</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[75vh]">
          {/* File summary pill */}
          <div className="flex items-center gap-3 p-3.5 bg-slate-800/60 rounded-xl border border-slate-700/60">
            <div className="w-10 h-10 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center shrink-0">
              <Play className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-white truncate">{attachment.filename}</div>
              <div className="text-xs text-slate-400">
                {(attachment.size_bytes / (1024 * 1024)).toFixed(2)} MB • {attachment.content_type}
              </div>
            </div>
          </div>

          {!shareResult ? (
            <div className="space-y-4">
              {/* Password Protection */}
              <div className="p-4 bg-slate-950/30 rounded-xl border border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                    <Lock className="w-4 h-4 text-amber-400" />
                    <span>محافظت با رمز عبور</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={usePassword}
                    onChange={(e) => setUsePassword(e.target.checked)}
                    className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 bg-slate-800 border-slate-700 cursor-pointer"
                  />
                </div>

                {usePassword && (
                  <input
                    type="password"
                    placeholder="رمز عبور دلخواه برای تماشا یا دانلود..."
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                )}
              </div>

              {/* Expiration Hours */}
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                  <Clock className="w-3.5 h-3.5 text-blue-400" />
                  <span>مدت اعتبار لینک</span>
                </label>
                <select
                  value={expiresInHours}
                  onChange={(e) => setExpiresInHours(Number(e.target.value))}
                  className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value={0}>همیشگی (بدون انقضا)</option>
                  <option value={12}>۱۲ ساعت</option>
                  <option value={24}>۲۴ ساعت (۱ روز)</option>
                  <option value={72}>۳ روز</option>
                  <option value={168}>۷ روز (۱ هفته)</option>
                  <option value={720}>۳۰ روز (۱ ماه)</option>
                </select>
              </div>

              {/* Max Downloads */}
              <div className="space-y-1.5">
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
                  <Download className="w-3.5 h-3.5 text-emerald-400" />
                  <span>محدودیت تعداد دانلود</span>
                </label>
                <select
                  value={maxDownloads}
                  onChange={(e) => setMaxDownloads(Number(e.target.value))}
                  className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  <option value={0}>نامحدود</option>
                  <option value={5}>۵ دانلود</option>
                  <option value={10}>۱۰ دانلود</option>
                  <option value={50}>۵۰ دانلود</option>
                  <option value={100}>۱۰۰ دانلود</option>
                </select>
              </div>

              {error && (
                <div className="p-3 bg-red-900/40 border border-red-700/50 rounded-lg text-xs text-red-200">
                  {error}
                </div>
              )}

              <button
                onClick={handleCreateShare}
                disabled={loading}
                className="w-full py-3 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white font-semibold rounded-xl shadow-lg shadow-indigo-600/25 transition disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>{loading ? 'در حال ایجاد لینک...' : 'تولید لینک مستقیم و وب پلیر'}</span>
              </button>
            </div>
          ) : (
            <div className="space-y-5 animate-fade-in">
              <div className="p-3.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-2.5 text-emerald-400 text-xs">
                <Check className="w-4 h-4 shrink-0" />
                <span>لینک استریم اختصاصی با استاندارد RFC 7233 با موفقیت ساخته شد!</span>
              </div>

              {/* Direct Stream Link */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                  <span>لینک مستقیم استریم (Direct Stream URL)</span>
                  <span className="text-[10px] text-indigo-400">پشتیبانی از دانلود منیجر و پلیرها</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={directStreamUrl}
                    className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 font-mono select-all focus:outline-none"
                  />
                    <button
                    onClick={() => copyToClipboard(directStreamUrl, 'stream')}
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition shrink-0"
                  >
                    {copiedField === 'stream' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedField === 'stream' ? 'کپی شد' : 'کپی'}</span>
                  </button>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
                  <span>لینک کوتاه: <code className="text-slate-300 font-mono">{vanityStreamUrl}</code></span>
                  <button
                    onClick={() => copyToClipboard(vanityStreamUrl, 'vanity')}
                    className="text-indigo-400 hover:underline cursor-pointer"
                  >
                    {copiedField === 'vanity' ? 'کپی شد!' : 'کپی لینک کوتاه'}
                  </button>
                </div>
              </div>

              {/* Standalone Dark Web Player Link */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                  <span>پلیر تحت وب تاریک (Dark Web Player)</span>
                  <span className="text-[10px] text-cyan-400">مشاهده مستقیم در مرورگر</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={webPlayerUrl}
                    className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-300 font-mono select-all focus:outline-none"
                  />
                  <button
                    onClick={() => copyToClipboard(webPlayerUrl, 'watch')}
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-medium flex items-center gap-1.5 transition shrink-0"
                  >
                    {copiedField === 'watch' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedField === 'watch' ? 'کپی شد' : 'کپی'}</span>
                  </button>
                  <a
                    href={webPlayerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition shrink-0"
                    title="باز کردن در تب جدید"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={onClose}
                  className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold rounded-xl transition cursor-pointer"
                >
                  بستن
                </button>
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
};
