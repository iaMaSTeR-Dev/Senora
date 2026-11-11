import { uiText, useUILanguage } from "../../app/language";
import React, { useState } from 'react';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Terminal,
  EyeOff,
  Quote,
  Link as LinkIcon,
  X,
  Check
} from 'lucide-react';
import { applyFormatting } from './messageFormatter';

interface FormattingToolbarProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onApply: (newText: string) => void;
  onClose?: () => void;
}

export const FormattingToolbar: React.FC<FormattingToolbarProps> = ({
  textareaRef,
  onApply,
  onClose,
}) => {
  const uiLang = useUILanguage();
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const handleFormat = (
    type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'codeblock' | 'spoiler' | 'quote' | 'link',
    url?: string
  ) => {
    const el = textareaRef.current;
    if (!el) return;

    const { newText, newStart, newEnd } = applyFormatting(el, type, url);
    onApply(newText);

    // Refocus and restore selection
    setTimeout(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(newStart, newEnd);
      }
    }, 10);
  };

  const handleLinkSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (linkUrl.trim()) {
      handleFormat('link', linkUrl.trim());
      setLinkUrl('');
      setShowLinkInput(false);
    }
  };

  return (
    <div className="flex items-center gap-1 p-1 bg-[#17212b] border border-[#242f3d] rounded-2xl shadow-xl text-slate-300 animate-fadeIn z-30 select-none">
      {showLinkInput ? (
        <form onSubmit={handleLinkSubmit} className="flex items-center gap-1.5 px-2 py-1">
          <input
            type="text"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://example.com"
            autoFocus
            className="px-2 py-1 rounded-lg bg-[#242f3d] text-white text-xs placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-[#24A1DE] w-48 font-mono"
          />
          <button
            type="submit"
            className="p-1.5 rounded-lg bg-[#24A1DE] text-white hover:bg-[#208fc4] transition cursor-pointer"
            title={uiText("Insert Link", uiLang)}
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => setShowLinkInput(false)}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
            title={uiText("Cancel", uiLang)}
          >
            <X size={14} />
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            onClick={() => handleFormat('bold')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Bold (Ctrl+B)", uiLang)}
          >
            <Bold size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('italic')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Italic (Ctrl+I)", uiLang)}
          >
            <Italic size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('underline')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Underline (Ctrl+U)", uiLang)}
          >
            <Underline size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('strike')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Strikethrough (Ctrl+Shift+X)", uiLang)}
          >
            <Strikethrough size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('code')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Monospace Code", uiLang)}
          >
            <Code size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('codeblock')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Code Block", uiLang)}
          >
            <Terminal size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('spoiler')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Spoiler ||text||", uiLang)}
          >
            <EyeOff size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('quote')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Quote", uiLang)}
          >
            <Quote size={15} />
          </button>
          <button
            type="button"
            onClick={() => setShowLinkInput(true)}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title={uiText("Add Link (Ctrl+K)", uiLang)}
          >
            <LinkIcon size={15} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl hover:bg-white/10 text-slate-400 hover:text-white transition ml-1 cursor-pointer"
              title={uiText("Close", uiLang)}
            >
              <X size={14} />
            </button>
          )}
        </>
      )}
    </div>
  );
};
