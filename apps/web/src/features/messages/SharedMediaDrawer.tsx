import { uiText, useUILanguage } from "../../app/language";
import React, { useState } from 'react';
import { Message } from '../../app/types';
import { X, Image, FileText, Mic, Link as LinkIcon, Download, Play, ExternalLink } from 'lucide-react';

interface SharedMediaDrawerProps {
  messages: Message[];
  onClose: () => void;
  onOpenMedia?: (url: string, isVideo: boolean) => void;
  onDownloadFile?: (attachment: any) => void;
  onPlayVoice?: (msgId: string, attachment: any) => void;
}

export const SharedMediaDrawer: React.FC<SharedMediaDrawerProps> = ({
  messages,
  onClose,
  onOpenMedia,
  onDownloadFile,
  onPlayVoice,
}) => {
  const uiLang = useUILanguage();
  const [tab, setTab] = useState<'media' | 'files' | 'voice' | 'links'>('media');

  // Categorize messages
  const photosAndVideos = messages.filter(
    (m) =>
      m.attachmentMeta &&
      (m.attachmentMeta.isPhoto ||
        m.attachmentMeta.isVideo ||
        m.attachmentMeta.isRoundVideo ||
        m.attachmentMeta.contentType?.startsWith('image/') ||
        m.attachmentMeta.contentType?.startsWith('video/'))
  );

  const files = messages.filter(
    (m) =>
      m.attachmentMeta &&
      !m.attachmentMeta.isPhoto &&
      !m.attachmentMeta.isVideo &&
      !m.attachmentMeta.isVoice &&
      !m.attachmentMeta.isRoundVideo &&
      !m.attachmentMeta.isSticker
  );

  const voiceNotes = messages.filter(
    (m) => m.attachmentMeta && m.attachmentMeta.isVoice
  );

  // Extract URLs from text
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const linkMessages: { id: string; url: string; date: string }[] = [];
  for (const m of messages) {
    if (m.plaintext) {
      const matches = m.plaintext.match(urlRegex);
      if (matches) {
        for (const url of matches) {
          linkMessages.push({ id: m.id, url, date: m.created_at });
        }
      }
    }
  }

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-80 md:w-96 max-w-full bg-[#17212b] border-l border-[#242f3d] shadow-2xl flex flex-col animate-slideInRight select-none">
      {/* Drawer Header */}
      <div className="p-4 border-b border-[#242f3d] flex items-center justify-between">
        <h3 className="text-sm font-bold text-white">{uiText("Shared Media", uiLang)}</h3>
        <button onClick={onClose} className="text-[#7f91a4] hover:text-white cursor-pointer">
          <X size={18} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#242f3d] bg-[#17212b]">
        <button
          onClick={() => setTab('media')}
          className={`flex-1 py-2.5 text-xs font-semibold flex items-center justify-center gap-1.5 border-b-2 transition cursor-pointer ${
            tab === 'media'
              ? 'border-[#24A1DE] text-[#24A1DE]'
              : 'border-transparent text-[#7f91a4] hover:text-white'
          }`}
        >
          <Image size={14} />
          <span>{uiText("Media", uiLang)}</span>
        </button>

        <button
          onClick={() => setTab('files')}
          className={`flex-1 py-2.5 text-xs font-semibold flex items-center justify-center gap-1.5 border-b-2 transition cursor-pointer ${
            tab === 'files'
              ? 'border-[#24A1DE] text-[#24A1DE]'
              : 'border-transparent text-[#7f91a4] hover:text-white'
          }`}
        >
          <FileText size={14} />
          <span>{uiText("Files", uiLang)}</span>
        </button>

        <button
          onClick={() => setTab('voice')}
          className={`flex-1 py-2.5 text-xs font-semibold flex items-center justify-center gap-1.5 border-b-2 transition cursor-pointer ${
            tab === 'voice'
              ? 'border-[#24A1DE] text-[#24A1DE]'
              : 'border-transparent text-[#7f91a4] hover:text-white'
          }`}
        >
          <Mic size={14} />
          <span>{uiText("Voice", uiLang)}</span>
        </button>

        <button
          onClick={() => setTab('links')}
          className={`flex-1 py-2.5 text-xs font-semibold flex items-center justify-center gap-1.5 border-b-2 transition cursor-pointer ${
            tab === 'links'
              ? 'border-[#24A1DE] text-[#24A1DE]'
              : 'border-transparent text-[#7f91a4] hover:text-white'
          }`}
        >
          <LinkIcon size={14} />
          <span>{uiText("Links", uiLang)}</span>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 no-scrollbar">
        {/* Media Grid */}
        {tab === 'media' && (
          photosAndVideos.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-xs text-[#7f91a4]">{uiText("No media shared yet", uiLang)}</div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {photosAndVideos.map((m) => (
                <div
                  key={m.id}
                  onClick={() => onOpenMedia?.(`/api/v1/attachments/${m.attachmentMeta?.id}`, !!m.attachmentMeta?.isVideo)}
                  className="aspect-square rounded-lg bg-[#242f3d] overflow-hidden cursor-pointer relative group border border-[#101921]"
                >
                  <img
                    src={`/api/v1/attachments/${m.attachmentMeta?.id}`}
                    alt=""
                    className="w-full h-full object-cover group-hover:scale-105 transition"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition text-white">
                    <Download size={14} />
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {/* Files List */}
        {tab === 'files' && (
          files.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-xs text-[#7f91a4]">{uiText("No files shared yet", uiLang)}</div>
          ) : (
            <div className="space-y-2">
              {files.map((m) => (
                <div
                  key={m.id}
                  onClick={() => onDownloadFile?.(m.attachmentMeta)}
                  className="p-2.5 rounded-xl bg-[#202b36] border border-[#242f3d] flex items-center justify-between hover:bg-[#253240] transition cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-8 w-8 rounded-lg bg-[#24A1DE]/20 text-[#24A1DE] flex items-center justify-center flex-shrink-0">
                      <FileText size={16} />
                    </div>
                    <div className="truncate">
                      <p className="text-xs font-semibold text-white truncate">
                        {m.attachmentMeta?.filename || uiText("Document", uiLang)}
                      </p>
                      <p className="text-[10px] text-[#7f91a4]">
                        {m.attachmentMeta?.sizeBytes
                          ? `${Math.round(m.attachmentMeta.sizeBytes / 1024)} KB`
                          : uiText("File", uiLang)}
                      </p>
                    </div>
                  </div>
                  <Download size={14} className="text-[#7f91a4] hover:text-white" />
                </div>
              ))}
            </div>
          )
        )}

        {/* Voice Notes */}
        {tab === 'voice' && (
          voiceNotes.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-xs text-[#7f91a4]">{uiText("No voice notes shared yet", uiLang)}</div>
          ) : (
            <div className="space-y-2">
              {voiceNotes.map((m) => (
                <div
                  key={m.id}
                  onClick={() => onPlayVoice?.(m.id, m.attachmentMeta)}
                  className="p-2.5 rounded-xl bg-[#202b36] border border-[#242f3d] flex items-center justify-between hover:bg-[#253240] transition cursor-pointer"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="h-8 w-8 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center flex-shrink-0">
                      <Play size={14} />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-white">{uiText("Voice Message", uiLang)}</p>
                      <p className="text-[10px] text-[#7f91a4]">
                        {new Date(m.created_at).toLocaleDateString(uiLang === 'fa' ? 'fa-IR' : 'en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                  </div>
                  <Mic size={14} className="text-emerald-400" />
                </div>
              ))}
            </div>
          )
        )}

        {/* Links */}
        {tab === 'links' && (
          linkMessages.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-xs text-[#7f91a4]">{uiText("No links found in messages", uiLang)}</div>
          ) : (
            <div className="space-y-2">
              {linkMessages.map((item, idx) => (
                <a
                  key={idx}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="p-2.5 rounded-xl bg-[#202b36] border border-[#242f3d] flex items-center justify-between hover:bg-[#253240] transition block"
                >
                  <div className="flex items-center gap-2.5 truncate mr-2">
                    <div className="h-8 w-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center flex-shrink-0">
                      <LinkIcon size={14} />
                    </div>
                    <div className="truncate">
                      <p className="text-xs font-semibold text-[#24A1DE] truncate underline">
                        {item.url}
                      </p>
                      <p className="text-[10px] text-[#7f91a4]">
                        {new Date(item.date).toLocaleDateString(uiLang === 'fa' ? 'fa-IR' : 'en-US')}
                      </p>
                    </div>
                  </div>
                  <ExternalLink size={14} className="text-[#7f91a4] flex-shrink-0" />
                </a>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
};
