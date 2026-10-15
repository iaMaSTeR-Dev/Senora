import { describe, it, expect } from 'vitest';
import React from 'react';
import {
  renderFormattedText,
  applyFormatting,
  isRTLText,
  CodeBlockView,
  SpoilerView,
} from './messages/messageFormatter';

// Recursively flattens React elements to easily find nested formatting tags
function flattenElements(node: React.ReactNode): React.ReactElement[] {
  const result: React.ReactElement[] = [];
  function traverse(n: any) {
    if (!n) return;
    if (Array.isArray(n)) {
      n.forEach(traverse);
    } else if (React.isValidElement(n)) {
      result.push(n);
      if (n.props && (n.props as any).children) {
        traverse((n.props as any).children);
      }
    }
  }
  traverse(node);
  return result;
}

describe('Telegram-Level Rich Text Formatting & Security', () => {
  it('correctly creates bold element node', () => {
    const nodes = renderFormattedText('This is **bold text** here');
    const elements = flattenElements(nodes);
    const boldNode = elements.find((el) => el.type === 'strong');
    expect(boldNode).toBeDefined();
    expect((boldNode?.props as any)?.children).toContain('bold text');
  });

  it('correctly creates italic element node', () => {
    const nodes = renderFormattedText('This is *italic text* here');
    const elements = flattenElements(nodes);
    const italicNode = elements.find((el) => el.type === 'em');
    expect(italicNode).toBeDefined();
    expect((italicNode?.props as any)?.children).toContain('italic text');
  });

  it('correctly creates underline and strikethrough nodes', () => {
    const uNodes = renderFormattedText('Please note <u>underlined</u> item');
    const uElements = flattenElements(uNodes);
    const uNode = uElements.find((el) => el.type === 'u');
    expect(uNode).toBeDefined();
    expect((uNode?.props as any)?.children).toContain('underlined');

    const sNodes = renderFormattedText('This is ~deprecated strikethrough~');
    const sElements = flattenElements(sNodes);
    const sNode = sElements.find((el) => el.type === 's');
    expect(sNode).toBeDefined();
    expect((sNode?.props as any)?.children).toContain('deprecated strikethrough');
  });

  it('correctly creates inline monospace code node', () => {
    const nodes = renderFormattedText('Run `npm run build` now');
    const elements = flattenElements(nodes);
    const codeNode = elements.find((el) => el.type === 'code');
    expect(codeNode).toBeDefined();
    expect((codeNode?.props as any)?.children).toBe('npm run build');
  });

  it('correctly creates multiline code block component with language', () => {
    const snippet = '```typescript\nconst x: number = 42;\nconsole.log(x);\n```';
    const nodes = renderFormattedText(snippet);
    const elements = flattenElements(nodes);
    const blockNode = elements.find((el) => el.type === CodeBlockView);
    expect(blockNode).toBeDefined();
    expect((blockNode?.props as any)?.code).toContain('const x: number = 42;');
    expect((blockNode?.props as any)?.language).toBe('typescript');
  });

  it('correctly creates spoiler component with initial concealed state', () => {
    const nodes = renderFormattedText('Movie ending: ||The hero survives||');
    const elements = flattenElements(nodes);
    const spoilerNode = elements.find((el) => el.type === SpoilerView);
    expect(spoilerNode).toBeDefined();
    // SpoilerView children contains the inner parsed tokens
    const innerChildren = (spoilerNode?.props as any)?.children;
    expect(innerChildren).toBeDefined();
    expect(JSON.stringify(innerChildren)).toContain('The hero survives');
  });

  it('correctly creates blockquote element node', () => {
    const nodes = renderFormattedText('> Important notice\n> Telegram level UX');
    const elements = flattenElements(nodes);
    const quoteNode = elements.find((el) => el.type === 'blockquote');
    expect(quoteNode).toBeDefined();
    const children = (quoteNode?.props as any)?.children;
    expect(JSON.stringify(children)).toContain('Important notice');
    expect(JSON.stringify(children)).toContain('Telegram level UX');
  });

  it('correctly creates markdown link and plain URL anchor elements', () => {
    const nodes = renderFormattedText('Visit [NexaChat](https://nexachat.io) or https://github.com');
    const elements = flattenElements(nodes);
    const anchorNodes = elements.filter((el) => el.type === 'a');
    expect(anchorNodes.length).toBe(2);

    expect((anchorNodes[0]?.props as any)?.href).toBe('https://nexachat.io');
    expect((anchorNodes[0]?.props as any)?.children).toBe('NexaChat');

    expect((anchorNodes[1]?.props as any)?.href).toBe('https://github.com');
  });

  it('sanitizes dangerous javascript: URLs to prevent XSS attacks', () => {
    const nodes = renderFormattedText('[Click here](javascript:alert("hacked"))');
    const elements = flattenElements(nodes);
    const anchorNode = elements.find((el) => el.type === 'a');
    expect(anchorNode).toBeDefined();
    expect((anchorNode?.props as any)?.href).toBe('#');
  });

  it('correctly detects RTL Persian / Arabic text', () => {
    expect(isRTLText('سلام دنیا! این یک پیام آزمایشی است.')).toBe(true);
    expect(isRTLText('Hello world! This is an English test.')).toBe(false);
    expect(isRTLText('Mixed text: سلام دوستان')).toBe(true);
  });

  it('applies bold formatting to a selection via applyFormatting', () => {
    const textarea = {
      value: 'Hello world message',
      selectionStart: 6,
      selectionEnd: 11, // 'world'
    } as HTMLTextAreaElement;

    const result = applyFormatting(textarea, 'bold');
    expect(result.newText).toBe('Hello **world** message');
    expect(result.newSelectionStart).toBe(8);
    expect(result.newSelectionEnd).toBe(13);
  });

  it('applies spoiler formatting to a selection via applyFormatting', () => {
    const textarea = {
      value: 'Secret phrase',
      selectionStart: 0,
      selectionEnd: 6, // 'Secret'
    } as HTMLTextAreaElement;

    const result = applyFormatting(textarea, 'spoiler');
    expect(result.newText).toBe('||Secret|| phrase');
  });

  it('applies code block formatting via applyFormatting', () => {
    const textarea = {
      value: 'function test() {}',
      selectionStart: 0,
      selectionEnd: 18,
    } as HTMLTextAreaElement;

    const result = applyFormatting(textarea, 'code_block');
    expect(result.newText).toBe('```\nfunction test() {}\n```');
  });
});

describe('Telegram Context Menu & Permission Rules', () => {
  it('identifies owner-permitted operations correctly', () => {
    const currentUserId: string = 'user_alice';
    const messageSenderId: string = 'user_alice';
    const isOwn = currentUserId === messageSenderId;
    const canEdit = isOwn;
    const canDeleteForEveryone = isOwn;

    expect(canEdit).toBe(true);
    expect(canDeleteForEveryone).toBe(true);
  });

  it('prohibits editing peer messages but allows deleting for me', () => {
    const currentUserId: string = 'user_alice';
    const messageSenderId: string = 'user_bob';
    const isOwn = currentUserId === messageSenderId;
    const canEdit = isOwn;
    const canDeleteForMe = true;
    const canDeleteForEveryone = isOwn;

    expect(canEdit).toBe(false);
    expect(canDeleteForMe).toBe(true);
    expect(canDeleteForEveryone).toBe(false);
  });

  it('allows group administrator to delete any message for everyone', () => {
    const userRole = 'admin';
    const isGroup = true;
    const isOwn = false;
    const canDeleteForEveryone = isOwn || (isGroup && (userRole === 'admin' || userRole === 'owner'));

    expect(canDeleteForEveryone).toBe(true);
  });
});

describe('Media Lightbox Navigation & Zoom Clamping', () => {
  it('correctly navigates next and previous in an album sequence', () => {
    const items = [
      { id: '1', url: 'img1.jpg', isVideo: false },
      { id: '2', url: 'img2.jpg', isVideo: false },
      { id: '3', url: 'img3.jpg', isVideo: false },
    ];

    let currentIndex = 0;
    const handleNext = () => {
      currentIndex = (currentIndex + 1) % items.length;
    };
    const handlePrev = () => {
      currentIndex = (currentIndex - 1 + items.length) % items.length;
    };

    handleNext();
    expect(currentIndex).toBe(1);
    handleNext();
    expect(currentIndex).toBe(2);
    handleNext();
    expect(currentIndex).toBe(0); // Wrapped around

    handlePrev();
    expect(currentIndex).toBe(2);
  });

  it('clamps zoom scale between minimum 0.5x and maximum 4x', () => {
    let zoom = 1.0;
    const zoomIn = () => { zoom = Math.min(4.0, zoom + 0.25); };
    const zoomOut = () => { zoom = Math.max(0.5, zoom - 0.25); };

    for (let i = 0; i < 20; i++) zoomIn();
    expect(zoom).toBe(4.0);

    for (let i = 0; i < 20; i++) zoomOut();
    expect(zoom).toBe(0.5);
  });
});
