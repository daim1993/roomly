'use strict';

/**
 * Minimal, safe rich-text renderer for chat messages.
 * Supports: ```code blocks```, `inline code`, **bold**, *italic*, ~~strike~~,
 * http(s) links and <@userId> mentions. Builds real DOM nodes — user content
 * never touches innerHTML.
 */

const INLINE_SOURCE = [
  '(`[^`\\n]+`)',                       // inline code
  '(\\*\\*[^*\\n]+\\*\\*)',             // bold
  '(\\*[^*\\n]+\\*)',                   // italic
  '(~~[^~\\n]+~~)',                     // strike
  '(<@u_[a-z0-9]+>)',                   // mention
  '(https?:\\/\\/[^\\s<>"\']{4,500})'   // link
].join('|');

function renderInline(text, users, fragment) {
  // A fresh regex per call: this function recurses, and a shared global
  // regex would have its lastIndex clobbered by the recursion.
  const pattern = new RegExp(INLINE_SOURCE, 'g');
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      fragment.append(text.slice(lastIndex, match.index));
    }
    const token = match[0];

    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      fragment.append(code);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      renderInline(token.slice(2, -2), users, strong);
      fragment.append(strong);
    } else if (token.startsWith('~~')) {
      const del = document.createElement('del');
      renderInline(token.slice(2, -2), users, del);
      fragment.append(del);
    } else if (token.startsWith('*')) {
      const em = document.createElement('em');
      renderInline(token.slice(1, -1), users, em);
      fragment.append(em);
    } else if (token.startsWith('<@')) {
      const userId = token.slice(2, -1);
      const user = users && users.get ? users.get(userId) : null;
      const mention = document.createElement('span');
      mention.className = 'mention';
      mention.textContent = `@${user ? user.name : 'unknown'}`;
      fragment.append(mention);
    } else {
      const anchor = document.createElement('a');
      anchor.href = token;
      anchor.textContent = token;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      fragment.append(anchor);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    fragment.append(text.slice(lastIndex));
  }
}

export function renderContent(content, users) {
  const fragment = document.createDocumentFragment();
  const text = String(content || '');
  const parts = text.split(/```/);

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) {
      continue;
    }
    if (index % 2 === 1) {
      // Code block: drop an optional language hint on the first line.
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/^[a-zA-Z0-9+-]*\n/, '').replace(/\n$/, '');
      pre.append(code);
      fragment.append(pre);
    } else {
      renderInline(part, users, fragment);
    }
  }
  return fragment;
}

/** Plain-text preview of a message (for reply refs and DM list rows). */
export function contentPreview(message, users) {
  if (message.deleted) {
    return 'Message deleted';
  }
  let text = String(message.content || '')
    .replace(/<@(u_[a-z0-9]+)>/g, (whole, id) => {
      const user = users && users.get ? users.get(id) : null;
      return `@${user ? user.name : 'someone'}`;
    })
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text && message.attachments && message.attachments.length) {
    text = `📎 ${message.attachments[0].name}`;
  }
  return text || '…';
}
