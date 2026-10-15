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
            title="Insert Link"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => setShowLinkInput(false)}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
            title="Cancel"
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
            title="Bold (Ctrl+B)"
          >
            <Bold size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('italic')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Italic (Ctrl+I)"
          >
            <Italic size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('underline')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Underline (Ctrl+U)"
          >
            <Underline size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('strike')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Strikethrough (Ctrl+Shift+X)"
          >
            <Strikethrough size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('code')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Monospace Code"
          >
            <Code size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('codeblock')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Code Block"
          >
            <Terminal size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('spoiler')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Spoiler ||text||"
          >
            <EyeOff size={15} />
          </button>
          <button
            type="button"
            onClick={() => handleFormat('quote')}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Quote"
          >
            <Quote size={15} />
          </button>
          <button
            type="button"
            onClick={() => setShowLinkInput(true)}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Add Link (Ctrl+K)"
          >
            <LinkIcon size={15} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl hover:bg-white/10 text-slate-400 hover:text-white transition ml-1 cursor-pointer"
              title="Close"
            >
              <X size={14} />
            </button>
          )}
        </>
      )}
    </div>
  );
};
