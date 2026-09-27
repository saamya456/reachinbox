import sanitizeHtml from 'sanitize-html';

// Email body HTML is produced by the browser's editor and must never be
// trusted: it is sanitized on the server before it is stored, and again when
// it is served for display. Only basic formatting survives (what the compose
// editor can produce); scripts, event handlers, iframes, images, forms and
// arbitrary styles are removed.

const EMAIL_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
    'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'a', 'hr', 'code', 'pre',
  ],
  allowedAttributes: { a: ['href', 'target', 'rel'], '*': ['style'] },
  allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
};

export function looksLikeHtml(body: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(body);
}

export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, EMAIL_HTML_OPTIONS).trim();
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Display HTML for any stored body: sanitized HTML, or escaped plain text.
export function bodyToSafeHtml(body: string): string {
  if (looksLikeHtml(body)) return sanitizeEmailHtml(body);
  return escapeHtml(body).replace(/\r?\n/g, '<br>');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', apos: "'" };

// Plain-text rendering (SMTP text part, search snippets, emptiness checks).
export function htmlToText(body: string): string {
  if (!looksLikeHtml(body)) return body.trim();
  const withBreaks = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre)>/gi, '\n');
  const stripped = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} });
  return stripped
    .replace(/&(amp|lt|gt|quot|#39|nbsp|apos);/g, (_, e: string) => ENTITIES[e] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
