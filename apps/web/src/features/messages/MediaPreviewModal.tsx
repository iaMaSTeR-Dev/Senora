import { uiText, useUILanguage } from "../../app/language";
import React, { useState, useEffect } from 'react';
import { X, Send, Image, Film, FileText, Music } from 'lucide-react';
import { Language } from '../../app/i18n';

interface MediaPreviewModalProps {
  file?: File;
  files?: File[];
  previewUrl?: string;
  isVideo?: boolean;
  isDocument?: boolean;
  uploadProgress?: number;
  onSend: (file: File, caption: string, isViewOnce?: boolean) => void;
  onSendMultiple?: (files: File[], caption: string, isViewOnce?: boolean) => void;
  onCancel: () => void;
  sending?: boolean;
  lang?: Language;
}

export const MediaPreviewModal: React.FC<MediaPreviewModalProps> = ({
  file: initialFile,
  files: initialFiles,
  previewUrl: initialPreviewUrl,
  isVideo,
  isDocument,
  uploadProgress,
  onSend,
  onSendMultiple,
  onCancel,
  sending,
  lang = 'en',
}) => {
  const uiLang = useUILanguage(lang);
  const [fileList, setFileList] = useState<File[]>(() => {
    if (initialFiles && initialFiles.length > 0) return initialFiles;
    if (initialFile) return [initialFile];
    return [];
  });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [caption, setCaption] = useState('');
  const [isViewOnce, setIsViewOnce] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Record<number, string>>({});

  const activeFile = fileList[selectedIndex] || fileList[0];

  useEffect(() => {
    const urls: Record<number, string> = {};
    fileList.forEach((f, idx) => {
      if (idx === 0 && initialPreviewUrl && fileList.length === 1) {
        urls[0] = initialPreviewUrl;
      } else if (f.type.startsWith('image/') || f.type.startsWith('video/')) {
        urls[idx] = URL.createObjectURL(f);
      }
    });
    setPreviewUrls(urls);

    return () => {
      Object.entries(urls).forEach(([, url]) => {
        if (url !== initialPreviewUrl) {
          URL.revokeObjectURL(url);
        }
      });
    };
  }, [fileList]);

  const removeFile = (indexToRemove: number) => {
    if (sending) return;
    const updated = fileList.filter((_, i) => i !== indexToRemove);
    if (updated.length === 0) {
      onCancel();
      return;
    }
    setFileList(updated);
    if (selectedIndex >= updated.length) {
      setSelectedIndex(updated.length - 1);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const isImg = activeFile && !isDocument && activeFile.type.startsWith('image/');
  const isVid = activeFile && (isVideo || activeFile.type.startsWith('video/'));
  const isAud = activeFile && activeFile.type.startsWith('audio/');
  const ext = activeFile ? activeFile.name.split('.').pop()?.toUpperCase() || 'FILE' : '';

  const handleSend = () => {
    if (sending || fileList.length === 0) return;
    if (fileList.length > 1 && onSendMultiple) {
      onSendMultiple(fileList, caption.trim(), isViewOnce);
    } else {
      onSend(fileList[0], caption.trim(), isViewOnce);
    }
  };

  if (!activeFile) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fadeIn select-none">
      <div className="w-full max-w-lg bg-[#17212b] border border-[#242f3d] rounded-3xl overflow-hidden shadow-2xl flex flex-col">
        {/* Top Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#242f3d] bg-[#1f2b38]/70">
          <div className="flex items-center space-x-2">
            {isVid ? (
              <Film className="text-[#24A1DE]" size={18} />
            ) : isImg ? (
              <Image className="text-[#24A1DE]" size={18} />
            ) : isAud ? (
              <Music className="text-emerald-400" size={18} />
            ) : (
              <FileText className="text-[#24A1DE]" size={18} />
            )}
            <span className="text-sm font-semibold text-white">
              {fileList.length > 1
                ? (lang === "fa" ? `ارسال ${fileList.length} فایل` : `Send ${fileList.length} Files`)
                : isVid
                ? (lang === "fa" ? 'ارسال ویدیو' : 'Send Video')
                : isImg
                ? (lang === "fa" ? 'ارسال تصویر' : 'Send Photo')
                : isAud
                ? (lang === "fa" ? 'ارسال فایل صوتی' : 'Send Audio')
                : (lang === "fa" ? 'ارسال فایل' : 'Send File')}
            </span>
            <span className="text-xs text-[#7f91a4]">({formatSize(activeFile.size)})</span>
          </div>
          <button
            onClick={onCancel}
            disabled={sending}
            className="p-1.5 text-[#7f91a4] hover:text-white rounded-lg hover:bg-[#242f3d] transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Media Preview Box */}
        <div className="h-64 sm:h-72 bg-black/50 flex items-center justify-center overflow-hidden p-4 relative">
          {isVid && previewUrls[selectedIndex] ? (
            <video
              src={previewUrls[selectedIndex]}
              controls
              className="max-h-full max-w-full rounded-2xl object-contain bg-black shadow-lg"
            />
          ) : isImg && previewUrls[selectedIndex] ? (
            <img
              src={previewUrls[selectedIndex]}
              alt={uiText("Preview", uiLang)}
              className="max-h-full max-w-full rounded-2xl object-contain shadow-lg"
            />
          ) : (
            /* Document / Audio Card */
            <div className="flex flex-col items-center justify-center space-y-3 text-center">
              <div className="w-20 h-20 rounded-2xl bg-[#24A1DE]/15 text-[#24A1DE] border border-[#24A1DE]/30 flex items-center justify-center shadow-xl">
                {isAud ? <Music size={36} /> : <FileText size={36} />}
              </div>
              <div className="max-w-xs">
                <p className="text-sm font-semibold text-white truncate">{activeFile.name}</p>
                <div className="flex items-center justify-center gap-1.5 text-xs text-[#7f91a4] mt-1 font-mono">
                  <span className="px-1.5 py-0.5 rounded bg-[#242f3d] text-[10px] uppercase font-bold text-[#24A1DE]">
                    {ext}
                  </span>
                  <span>•</span>
                  <span>{formatSize(activeFile.size)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Multiple Files Thumbnail Strip */}
        {fileList.length > 1 && (
          <div className="px-4 py-2 bg-[#17212b] border-t border-[#242f3d] flex items-center gap-2 overflow-x-auto">
            {fileList.map((f, idx) => (
              <div
                key={idx}
                onClick={() => setSelectedIndex(idx)}
                className={`relative flex-shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 cursor-pointer transition ${
                  selectedIndex === idx ? 'border-[#24A1DE] scale-105' : 'border-transparent opacity-70 hover:opacity-100'
                }`}
              >
                {previewUrls[idx] ? (
                  f.type.startsWith('video/') ? (
                    <video src={previewUrls[idx]} className="w-full h-full object-cover" />
                  ) : (
                    <img src={previewUrls[idx]} alt={uiText("thumb", uiLang)} className="w-full h-full object-cover" />
                  )
                ) : (
                  <div className="w-full h-full bg-[#242f3d] flex items-center justify-center text-[#24A1DE]">
                    <FileText size={18} />
                  </div>
                )}
                {!sending && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(idx);
                    }}
                    className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/70 hover:bg-red-600 text-white transition"
                    title={uiText("Remove", uiLang)}
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Real Upload Progress Bar */}
        {sending && uploadProgress !== undefined && (
          <div className="px-5 py-2.5 bg-[#17212b] border-t border-[#242f3d] flex flex-col gap-1.5">
            <div className="flex justify-between items-center text-[11px] font-mono text-white">
              <span className="text-[#24A1DE] font-semibold">
                {lang === "fa" ? 'در حال بارگذاری و رمزنگاری...' : 'Uploading & Encrypting...'}
              </span>
              <span>{Math.min(100, Math.max(0, Math.round(uploadProgress)))}%</span>
            </div>
            <div className="w-full bg-[#242f3d] rounded-full h-2 overflow-hidden">
              <div
                className="bg-[#24A1DE] h-2 rounded-full transition-all duration-150"
                style={{ width: `${Math.min(100, Math.max(0, Math.round(uploadProgress)))}%` }}
              />
            </div>
          </div>
        )}

        {/* Caption & Controls */}
        <div className="p-4 bg-[#1f2b38]/50 border-t border-[#242f3d] flex flex-col space-y-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder={lang === "fa" ? 'افزودن کپشن / توضیح...' : 'Add a caption...'}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend();
              }}
              disabled={sending}
              className="flex-1 px-4 py-2.5 bg-[#242f3d] border border-[#324252] rounded-2xl text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
            />

            {(isImg || isVid) && (
              <button
                type="button"
                onClick={() => setIsViewOnce(!isViewOnce)}
                title={lang === "fa" ? (isViewOnce ? 'مشاهده یک‌باره فعال است (خودکار پاک می‌شود)' : 'فعال‌سازی مشاهده یک‌باره (View Once)') : (isViewOnce ? 'View once active (Burns after viewing)' : 'Enable View Once')}
                className={`relative flex items-center justify-center w-9 h-9 rounded-full font-bold text-xs transition-all cursor-pointer flex-shrink-0 ${
                  isViewOnce
                    ? 'bg-gradient-to-tr from-amber-500 to-rose-500 text-white shadow-lg shadow-rose-500/30 scale-105 border border-amber-300'
                    : 'text-[#7f91a4] hover:text-white border border-[#324252] bg-[#242f3d]/60 hover:bg-[#242f3d]'
                }`}
              >
                <span>1</span>
                {isViewOnce && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-rose-500 rounded-full animate-ping" />
                )}
              </button>
            )}
          </div>

          <div className="flex items-center justify-between">
            <div>
              {isViewOnce && (
                <span className="text-[11px] text-amber-400 flex items-center gap-1 font-medium">
                  🔥 {lang === "fa" ? 'عکس/ویدیو یک‌باره: پس از باز شدن می‌سوزد' : 'View once: self-destructs after opening'}
                </span>
              )}
            </div>
            <div className="flex items-center space-x-3">
              <button
                type="button"
                onClick={onCancel}
                disabled={sending}
                className="px-4 py-2 text-xs font-semibold text-[#7f91a4] hover:text-white hover:bg-[#242f3d] rounded-xl transition cursor-pointer"
              >
                {lang === "fa" ? uiText("انصراف", uiLang) : uiText("Cancel", uiLang)}
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={sending}
                className="flex items-center space-x-2 px-5 py-2.5 bg-[#24A1DE] hover:bg-[#208fc4] disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-lg shadow-[#24A1DE]/25 transition-transform active:scale-95 cursor-pointer"
              >
                {sending ? (
                  <span>{lang === "fa" ? uiText("در حال ارسال...", uiLang) : uiText("Sending...", uiLang)}</span>
                ) : (
                  <>
                    <Send size={14} />
                    <span>
                      {lang === "fa"
                        ? (fileList.length > 1 ? `ارسال ${fileList.length} فایل` : uiText("ارسال", uiLang))
                        : (fileList.length > 1 ? `Send (${fileList.length})` : uiText("Send", uiLang))}
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
