import { uiText, useUILanguage } from "../../app/language";
import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export interface FormattingRange {
  type: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'codeblock' | 'spoiler' | 'quote' | 'link';
  start: number;
  end: number;
  url?: string;
  lang?: string;
}

// Interactive Code Block Component with Copy Button
export const CodeBlockView: React.FC<{ code: string; language?: string }> = ({ code, language }) => {
  const uiLang = useUILanguage();
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="my-2 rounded-xl overflow-hidden bg-[#101720] border border-white/10 text-xs font-mono select-text">
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#17212b] border-b border-white/10 text-slate-400">
        <span className="uppercase text-[10px] tracking-wider font-semibold text-[#24A1DE]">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] hover:text-white transition px-2 py-0.5 rounded hover:bg-white/10 cursor-pointer"
          title={uiText("Copy Code", uiLang)}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-400">{uiText("Copied", uiLang)}</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>{uiText("Copy", uiLang)}</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-slate-200 whitespace-pre leading-relaxed text-xs">
        <code>{code}</code>
      </pre>
    </div>
  );
};

// Interactive Spoiler Component that toggles concealed state on click
export const SpoilerView: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const uiLang = useUILanguage();
  const [revealed, setRevealed] = useState(false);

  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setRevealed((prev) => !prev);
      }}
      className={`inline-block px-1 py-0.5 rounded cursor-pointer transition-all duration-200 select-none ${
        revealed
          ? 'bg-white/10 text-inherit'
          : 'bg-slate-700/80 text-transparent blur-[3px] hover:blur-[2px] hover:bg-slate-600/80 relative'
      }`}
      title={revealed ? uiText("Click to hide spoiler", uiLang) : uiText("Spoiler: click to reveal", uiLang)}
    >
      {children}
    </span>
  );
};

// URL sanitizer to prevent javascript:, vbscript:, and data: XSS attacks
export function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(javascript|vbscript|data):/i.test(trimmed)) {
    return '#';
  }
  if (/^(https?:\/\/|mailto:|tg:\/\/)/i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) {
    return trimmed;
  }
  return 'https://' + trimmed;
}

// Detects RTL scripts (Persian, Arabic, Hebrew)
export function isRTLText(text: string): boolean {
  if (!text) return false;
  const rtlRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
  return rtlRegex.test(text);
}

export interface FormattedTextOptions {
  onMentionClick?: (username: string) => void;
  lang?: 'en' | 'fa';
}

// Parses Markdown / Telegram formatted text into rich React elements
export function renderFormattedText(text: string, options?: FormattedTextOptions): React.ReactNode {
  if (!text) return null;

  // Split lines to detect code blocks and block quotes first
  // Check for multiline code blocks: ```lang?\n ... ```
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(...renderInlineSegments(text.slice(lastIndex, match.index), options));
    }
    const lang = match[1] || '';
    const codeContent = match[2];
    parts.push(
      <CodeBlockView key={`codeblock-${match.index}`} code={codeContent} language={lang} />
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(...renderInlineSegments(text.slice(lastIndex), options));
  }

  return parts;
}

// Renders block quotes and inline formatting
function renderInlineSegments(text: string, options?: FormattedTextOptions): React.ReactNode[] {
  // Split by line to handle blockquotes (> quote)
  const lines = text.split('\n');
  const result: React.ReactNode[] = [];
  let currentQuoteLines: string[] = [];
  let inQuote = false;

  const flushQuote = (keyIdx: number) => {
    if (currentQuoteLines.length > 0) {
      result.push(
        <blockquote
          key={`quote-${keyIdx}`}
          className="border-l-3 border-[#24A1DE] bg-black/25 pl-3 py-1 my-1 rounded-r-lg text-slate-300 italic text-sm"
        >
          {currentQuoteLines.map((line, li) => (
            <div key={`ql-${li}`}>{parseInlineTokens(line, options)}</div>
          ))}
        </blockquote>
      );
      currentQuoteLines = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('> ') || line === '>') {
      inQuote = true;
      currentQuoteLines.push(line.replace(/^>\s?/, ''));
    } else {
      if (inQuote) {
        flushQuote(i);
        inQuote = false;
      }
      result.push(
        <React.Fragment key={`line-${i}`}>
          {parseInlineTokens(line, options)}
          {i < lines.length - 1 && <br />}
        </React.Fragment>
      );
    }
  }

  if (inQuote) {
    flushQuote(lines.length);
  }

  return result;
}

// Parses inline tokens: spoiler, bold, italic, underline, strike, inline code, links, mentions
function parseInlineTokens(line: string, options?: FormattedTextOptions): React.ReactNode[] {
  if (!line) return [];

  // Combined token matcher including Telegram @username mentions and cnv_/usr_ IDs
  const tokenRegex = /(\|\|[\s\S]+?\|\||\[([^\]]+)\]\(([^)]+)\)|https?:\/\/[^\s<]+|`[^`]+`|\*\*[^*]+\*\*|<b>[\s\S]+?<\/b>|__[^_]+__|<u>[\s\S]+?<\/u>|~[^~]+~|<s>[\s\S]+?<\/s>|\*[^*]+\*|_[^_]+_|<i>[\s\S]+?<\/i>|@[a-zA-Z0-9_]{3,32}|\b(?:cnv|usr)_[a-zA-Z0-9_-]{6,}\b)/g;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let tokenCounter = 0;

  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `tok-${match.index}-${tokenCounter++}`;

    if (token.startsWith('||') && token.endsWith('||')) {
      // Spoiler
      const inner = token.slice(2, -2);
      parts.push(<SpoilerView key={key}>{parseInlineTokens(inner, options)}</SpoilerView>);
    } else if (token.startsWith('[') && token.includes('](')) {
      // Markdown link [text](url)
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        const title = linkMatch[1];
        const rawUrl = linkMatch[2];
        const safeUrl = sanitizeUrl(rawUrl);
        parts.push(
          <a
            key={key}
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#24A1DE] hover:underline underline-offset-2 break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {title}
          </a>
        );
      } else {
        parts.push(token);
      }
    } else if (/^https?:\/\//i.test(token)) {
      // Raw URL
      const safeUrl = sanitizeUrl(token);
      parts.push(
        <a
          key={key}
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#24A1DE] hover:underline underline-offset-2 break-all"
          onClick={(e) => e.stopPropagation()}
        >
          {token}
        </a>
      );
    } else if ((token.startsWith('@') && /^@[a-zA-Z0-9_]{3,32}$/.test(token)) || /^(?:cnv|usr)_[a-zA-Z0-9_-]{6,}$/.test(token)) {
      // Telegram @username mention or exact ID
      const identifier = token.startsWith('@') ? token.slice(1) : token;
      parts.push(
        <button
          key={key}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (options?.onMentionClick) {
              options.onMentionClick(identifier);
            }
          }}
          className="inline font-semibold text-[#24A1DE] hover:text-[#52bcf5] hover:underline cursor-pointer select-text transition bg-transparent p-0 m-0 border-none outline-none align-baseline"
          title={options?.lang === 'fa'
            ? (token.startsWith('@') ? `مشاهدهٔ پروفایل @${identifier}` : `باز کردن ${token}`)
            : (token.startsWith('@') ? `View @${identifier}'s profile` : `Open ${token}`)}
        >
          {token}
        </button>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      // Inline Code
      const inner = token.slice(1, -1);
      parts.push(
        <code
          key={key}
          className="px-1.5 py-0.5 rounded bg-black/40 text-rose-300 font-mono text-xs border border-white/10"
        >
          {inner}
        </code>
      );
    } else if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('<b>') && token.endsWith('</b>'))) {
      // Bold
      const inner = token.startsWith('**') ? token.slice(2, -2) : token.slice(3, -4);
      parts.push(<strong key={key} className="font-bold text-white">{parseInlineTokens(inner, options)}</strong>);
    } else if ((token.startsWith('__') && token.endsWith('__')) || (token.startsWith('<u>') && token.endsWith('</u>'))) {
      // Underline
      const inner = token.startsWith('__') ? token.slice(2, -2) : token.slice(3, -4);
      parts.push(<u key={key} className="underline underline-offset-2">{parseInlineTokens(inner, options)}</u>);
    } else if ((token.startsWith('~') && token.endsWith('~')) || (token.startsWith('<s>') && token.endsWith('</s>'))) {
      // Strikethrough
      const inner = token.startsWith('~') ? token.slice(1, -1) : token.slice(3, -4);
      parts.push(<s key={key} className="line-through opacity-75">{parseInlineTokens(inner, options)}</s>);
    } else if ((token.startsWith('*') && token.endsWith('*')) || (token.startsWith('_') && token.endsWith('_')) || (token.startsWith('<i>') && token.endsWith('</i>'))) {
      // Italic
      const inner = token.startsWith('*') || token.startsWith('_') ? token.slice(1, -1) : token.slice(3, -4);
      parts.push(<em key={key} className="italic">{parseInlineTokens(inner, options)}</em>);
    } else {
      parts.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }

  return parts;
}

// Function to apply formatting tags around selection in a textarea
export function applyFormatting(
  textarea: HTMLTextAreaElement,
  formatType: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'codeblock' | 'spoiler' | 'quote' | 'link' | 'code_block',
  linkUrl?: string
): { newText: string; newStart: number; newEnd: number; newSelectionStart: number; newSelectionEnd: number } {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const fullText = textarea.value;
  const selectedText = fullText.substring(start, end);

  let prefix = '';
  let suffix = '';

  switch (formatType) {
    case 'bold':
      prefix = '**';
      suffix = '**';
      break;
    case 'italic':
      prefix = '*';
      suffix = '*';
      break;
    case 'underline':
      prefix = '<u>';
      suffix = '</u>';
      break;
    case 'strike':
      prefix = '~';
      suffix = '~';
      break;
    case 'code':
      prefix = '`';
      suffix = '`';
      break;
    case 'codeblock':
    case 'code_block' as any:
      prefix = '```\n';
      suffix = '\n```';
      break;
    case 'spoiler':
      prefix = '||';
      suffix = '||';
      break;
    case 'quote':
      prefix = '> ';
      suffix = '';
      break;
    case 'link':
      prefix = '[';
      suffix = `](${linkUrl || 'https://'})`;
      break;
  }

  const defaultPlaceholder = selectedText || (formatType === 'link' ? 'link text' : 'text');
  const replacement = `${prefix}${defaultPlaceholder}${suffix}`;
  const newText = fullText.substring(0, start) + replacement + fullText.substring(end);

  const newStart = start + prefix.length;
  const newEnd = newStart + defaultPlaceholder.length;

  return { newText, newStart, newEnd, newSelectionStart: newStart, newSelectionEnd: newEnd };
}
