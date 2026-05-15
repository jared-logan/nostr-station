/**
 * RFC 2822 message builder + parser for nostr-mail.
 *
 * nostr-mail (the wire protocol nostrmail.org defines) puts a full
 * RFC 2822 email — headers + body, optionally multipart — inside the
 * `content` field of a kind 1301 event, then gift-wraps the whole
 * thing via NIP-59. Tags on the rumor only carry routing-level
 * information (`["p", recipient]`); everything else (subject, date,
 * message-id, attachments) lives inside the RFC 2822 string.
 *
 * This module is the protocol surface for that format:
 *   - buildMessage(...) → RFC 2822 string for a kind 1301 rumor
 *   - parseMessage(content) → headers + plain body + attachments[]
 *
 * Attachments use multipart/mixed. Two physical forms supported:
 *   - INLINE: bytes are base64 in the part body. Used for ≤32 KiB.
 *   - BLOSSOM: bytes live on Blossom; metadata travels in
 *     X-Nostr-Blossom-* MIME headers. Used for >32 KiB so the rumor
 *     itself stays small. The blob is AES-256-GCM encrypted with the
 *     key embedded in X-Nostr-Encryption-Key / X-Nostr-Encryption-Nonce
 *     (continuing the file-crypto design from the prior PR — the
 *     metadata moves from event tags to MIME headers but the bytes-
 *     at-rest are protected the same way).
 *
 * The parser is intentionally narrow: handles the message shapes our
 * own composer emits and the shapes nogringo/nostr-mail emits per
 * their SDK docs. NOT a general-purpose RFC 2822 / MIME parser. If
 * we ever need to receive arbitrary email-from-the-wider-internet
 * traffic, swap this for `mailparser` from npm.
 */

const CRLF = '\r\n';
const INLINE_THRESHOLD_BYTES = 32 * 1024;

export interface AttachmentSpec {
  name:    string;
  mime:    string;
  size:    number;          // plaintext size
  // EXACTLY one of these two shapes is set:
  inline?: {
    base64: string;         // bytes encoded as base64; size matches `size`
  };
  blossom?: {
    url:    string;         // public URL to the AES-GCM ciphertext
    sha256: string;         // sha256 of the ciphertext blob
    keyHex:   string;       // 64 hex chars — AES-256 key
    nonceHex: string;       // 24 hex chars — GCM nonce
  };
}

export interface BuildMessageInput {
  fromPubkey:  string;      // hex pubkey of the sender (used for display From: header)
  toPubkey:    string;      // hex pubkey of the recipient (used for display To: header)
  subject:     string;
  body:        string;      // plaintext, utf-8
  // Optional threading. We mint a Message-ID for the new mail; if this
  // is a reply, pass the parent's Message-ID and the full References
  // chain (if available) so other RFC 2822 clients can thread.
  messageId:   string;      // mint via mintMessageId() at the call site
  inReplyTo?:  string;
  references?: string[];
  date?:       Date;        // defaults to now
  attachments?: AttachmentSpec[];
}

export interface ParsedAttachment {
  name:     string;
  mime:     string;
  size:     number;
  // Bytes either inline (decoded from base64) or referenced via Blossom.
  // For inline, the caller can render directly. For blossom, the UI
  // links to a proxy-decrypt route that fetches the URL, decrypts with
  // the key/nonce, and streams plaintext back.
  inline?:  Buffer;
  blossom?: {
    url:      string;
    sha256:   string;
    keyHex:   string;
    nonceHex: string;
  };
}

export interface ParsedMessage {
  subject:     string;
  from:        string;
  to:          string;
  date:        string;
  messageId:   string;
  inReplyTo:   string;
  references:  string[];
  body:        string;        // text/plain part, decoded
  attachments: ParsedAttachment[];
}

// ── Build ───────────────────────────────────────────────────────────────────

export function buildMessage(input: BuildMessageInput): string {
  const date     = input.date ?? new Date();
  const headers: Array<[string, string]> = [
    ['From',       input.fromPubkey],
    ['To',         input.toPubkey],
    ['Subject',    encodeHeaderValue(input.subject)],
    ['Date',       rfc5322Date(date)],
    ['Message-ID', input.messageId],
  ];
  if (input.inReplyTo) headers.push(['In-Reply-To', input.inReplyTo]);
  if (input.references && input.references.length > 0) {
    headers.push(['References', input.references.join(' ')]);
  }
  headers.push(['MIME-Version', '1.0']);

  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    headers.push(['Content-Type', 'text/plain; charset=utf-8']);
    headers.push(['Content-Transfer-Encoding', '8bit']);
    return formatHeaders(headers) + CRLF + CRLF + input.body;
  }

  // Multipart/mixed: text/plain part + one part per attachment.
  const boundary = mintBoundary();
  headers.push(['Content-Type', `multipart/mixed; boundary="${boundary}"`]);

  const parts: string[] = [];
  // Body part.
  parts.push(buildBodyPart(input.body));
  for (const a of attachments) {
    parts.push(buildAttachmentPart(a));
  }

  const partsText = parts.map(p => `--${boundary}${CRLF}${p}`).join(CRLF);
  return formatHeaders(headers) + CRLF + CRLF
       + partsText + CRLF
       + `--${boundary}--${CRLF}`;
}

function buildBodyPart(body: string): string {
  const h: Array<[string, string]> = [
    ['Content-Type', 'text/plain; charset=utf-8'],
    ['Content-Transfer-Encoding', '8bit'],
  ];
  return formatHeaders(h) + CRLF + CRLF + body;
}

function buildAttachmentPart(a: AttachmentSpec): string {
  const h: Array<[string, string]> = [
    ['Content-Type', `${a.mime}; name="${escapeHeaderQuoted(a.name)}"`],
    ['Content-Disposition', `attachment; filename="${escapeHeaderQuoted(a.name)}"`],
  ];
  if (a.inline) {
    h.push(['Content-Transfer-Encoding', 'base64']);
    return formatHeaders(h) + CRLF + CRLF + wrapBase64(a.inline.base64);
  }
  if (a.blossom) {
    h.push(['Content-Transfer-Encoding', 'none']);
    h.push(['X-Nostr-Blossom-URL',                a.blossom.url]);
    h.push(['X-Nostr-Blossom-Sha256',             a.blossom.sha256]);
    h.push(['X-Nostr-Blossom-Size',               String(a.size)]);
    h.push(['X-Nostr-Encryption-Algorithm',       'aes-256-gcm']);
    h.push(['X-Nostr-Encryption-Key',             a.blossom.keyHex]);
    h.push(['X-Nostr-Encryption-Nonce',           a.blossom.nonceHex]);
    return formatHeaders(h) + CRLF + CRLF;  // empty body — bytes live on Blossom
  }
  throw new Error('attachment must have either inline or blossom set');
}

// ── Parse ───────────────────────────────────────────────────────────────────

export function parseMessage(content: string): ParsedMessage {
  // Normalise line endings: the spec is CRLF but real-world emitters
  // sometimes use bare LF. Convert to CRLF up-front so the rest of the
  // parser only needs to handle one shape.
  const normalised = content.replace(/\r?\n/g, CRLF);
  const blankIdx = normalised.indexOf(CRLF + CRLF);
  const headerText = blankIdx < 0 ? normalised : normalised.slice(0, blankIdx);
  const bodyText   = blankIdx < 0 ? ''         : normalised.slice(blankIdx + 4);

  const headers = parseHeaders(headerText);
  const ct      = (headers['content-type'] || 'text/plain; charset=utf-8');

  const parsed: ParsedMessage = {
    subject:     decodeHeaderValue(headers['subject']    || ''),
    from:        headers['from']                          || '',
    to:          headers['to']                            || '',
    date:        headers['date']                          || '',
    messageId:   headers['message-id']                    || '',
    inReplyTo:   headers['in-reply-to']                   || '',
    references:  (headers['references'] || '').split(/\s+/).filter(Boolean),
    body:        '',
    attachments: [],
  };

  if (/^multipart\//i.test(ct)) {
    const boundary = extractBoundary(ct);
    if (!boundary) {
      // Malformed multipart header — treat the whole body as plaintext.
      parsed.body = bodyText;
      return parsed;
    }
    const parts = splitMultipart(bodyText, boundary);
    // First text/plain part wins as the body. Everything else with
    // Content-Disposition: attachment becomes an attachment.
    let bodyClaimed = false;
    for (const part of parts) {
      const ph = parseHeaders(part.headerText);
      const partCt   = ph['content-type'] || 'text/plain; charset=utf-8';
      const partDisp = ph['content-disposition'] || '';
      const partEnc  = (ph['content-transfer-encoding'] || '8bit').toLowerCase();

      if (!bodyClaimed && /^text\/plain/i.test(partCt) && !/attachment/i.test(partDisp)) {
        parsed.body = decodePartBody(part.bodyText, partEnc, partCt);
        bodyClaimed = true;
        continue;
      }
      if (/attachment/i.test(partDisp)) {
        parsed.attachments.push(parseAttachment(ph, part.bodyText, partEnc, partCt));
      }
    }
  } else {
    // Single-part message.
    const enc = (headers['content-transfer-encoding'] || '8bit').toLowerCase();
    parsed.body = decodePartBody(bodyText, enc, ct);
  }

  return parsed;
}

function parseAttachment(
  headers: Record<string, string>,
  body:    string,
  enc:     string,
  ct:      string,
): ParsedAttachment {
  // name preference: filename param in Content-Disposition → name in CT → empty
  const dispName = extractParam(headers['content-disposition'] || '', 'filename');
  const ctName   = extractParam(ct,                                'name');
  const name     = dispName || ctName || '';
  const mime     = (ct.split(';')[0] || '').trim().toLowerCase() || 'application/octet-stream';

  // Blossom path: presence of X-Nostr-Blossom-URL header → no inline body.
  const url      = headers['x-nostr-blossom-url']    || '';
  const sha256   = headers['x-nostr-blossom-sha256'] || '';
  const size     = Number(headers['x-nostr-blossom-size'] || 0);
  const keyHex   = headers['x-nostr-encryption-key']   || '';
  const nonceHex = headers['x-nostr-encryption-nonce'] || '';
  if (url) {
    return {
      name, mime, size,
      blossom: { url, sha256, keyHex, nonceHex },
    };
  }

  // Inline path: decode base64 from the body.
  const cleanedBody = body.replace(/[\r\n\t ]+/g, '');
  const buf = enc === 'base64' ? Buffer.from(cleanedBody, 'base64') : Buffer.from(body);
  return { name, mime, size: buf.length, inline: buf };
}

function decodePartBody(body: string, enc: string, ct: string): string {
  let buf: Buffer;
  switch (enc) {
    case 'base64':
      buf = Buffer.from(body.replace(/[\r\n\t ]+/g, ''), 'base64');
      break;
    case 'quoted-printable':
      buf = Buffer.from(decodeQuotedPrintable(body), 'binary');
      break;
    default:
      // 8bit / 7bit / binary / unknown — return the raw string verbatim
      // (already a JS string in the source charset; we don't try to
      // re-interpret bytes).
      return stripTrailingNewlines(body);
  }
  const charset = (extractParam(ct, 'charset') || 'utf-8').toLowerCase();
  // node's Buffer.toString accepts 'utf-8' / 'utf8' / 'ascii' / 'latin1'.
  // Map common aliases to a node-supported encoding.
  const enc2: BufferEncoding =
    charset === 'utf-8' || charset === 'utf8' ? 'utf8' :
    charset === 'us-ascii' || charset === 'ascii' ? 'ascii' :
    charset === 'iso-8859-1' || charset === 'latin1' ? 'latin1' :
    'utf8';
  return stripTrailingNewlines(buf.toString(enc2));
}

function stripTrailingNewlines(s: string): string {
  return s.replace(/(\r?\n)+$/, '');
}

// ── Header parsing ─────────────────────────────────────────────────────────

function parseHeaders(headerText: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headerText) return out;
  // Unfold lines: a header value continued on the next line starts with
  // SP or TAB. Per RFC 5322 §2.2.3.
  const unfolded = headerText.replace(/\r\n[ \t]+/g, ' ');
  for (const line of unfolded.split(CRLF)) {
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name  = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    // If the same header appears twice, the first wins (matches what most
    // RFC 2822 parsers do for non-list headers).
    if (!(name in out)) out[name] = value;
  }
  return out;
}

function splitMultipart(body: string, boundary: string): Array<{ headerText: string; bodyText: string }> {
  const delim    = `--${boundary}`;
  const endDelim = `--${boundary}--`;
  const parts: Array<{ headerText: string; bodyText: string }> = [];
  // Skip the prologue (anything before the first delimiter).
  let i = body.indexOf(delim);
  if (i < 0) return parts;
  i += delim.length;
  // Each delimiter line ends with CRLF; skip past it.
  if (body.slice(i, i + 2) === CRLF) i += 2;

  while (i < body.length) {
    // Find the next boundary occurrence.
    const nextEnd  = body.indexOf(endDelim, i);
    const nextNorm = body.indexOf(delim,    i);
    // The closing delim is also matched by `delim` (since endDelim
    // starts with delim), so pick the earliest occurrence — if both
    // start at the same offset, that's the closing delim and we stop.
    let next = nextNorm;
    if (nextEnd >= 0 && (next < 0 || nextEnd < next)) next = nextEnd;
    if (next < 0) break;

    const segment = body.slice(i, next);
    // Each segment is `<headers>CRLF CRLF<body>CRLF`. Trim the trailing CRLF.
    const cleanSegment = segment.replace(/\r\n$/, '');
    const blank = cleanSegment.indexOf(CRLF + CRLF);
    if (blank < 0) {
      parts.push({ headerText: cleanSegment, bodyText: '' });
    } else {
      parts.push({
        headerText: cleanSegment.slice(0, blank),
        bodyText:   cleanSegment.slice(blank + 4),
      });
    }
    if (next === nextEnd) break;
    i = next + delim.length;
    if (body.slice(i, i + 2) === CRLF) i += 2;
  }
  return parts;
}

function extractBoundary(contentType: string): string | null {
  return extractParam(contentType, 'boundary');
}

function extractParam(headerValue: string, name: string): string | null {
  // Matches `name=value` or `name="quoted value"`. RFC 2045 §5.1 spec
  // is more elaborate; this covers the shapes we care about.
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*("([^"\\\\]|\\\\.)*"|[^;\\s]+)`, 'i');
  const m  = headerValue.match(re);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, '$1');
  return v;
}

// ── Encoders ───────────────────────────────────────────────────────────────

function formatHeaders(headers: Array<[string, string]>): string {
  return headers.map(([k, v]) => `${k}: ${v}`).join(CRLF);
}

function encodeHeaderValue(value: string): string {
  // Subjects with non-ASCII characters need RFC 2047 encoded-word form
  // ("=?utf-8?B?<base64>?=") so the bytes survive the SMTP-style
  // 7-bit-safe transport. Our transport (gift-wrapped JSON) is 8-bit-
  // clean so this is purely for compatibility with clients that
  // re-display the raw header. Plain-ASCII subjects ride through
  // untouched.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?utf-8?B?${b64}?=`;
}

function decodeHeaderValue(value: string): string {
  // Decode a single encoded-word run. We don't try to merge adjacent
  // encoded-words separated by FWS — overkill for our payload set.
  return value.replace(/=\?utf-8\?([Bb])\?([^?]+)\?=/gi, (_m, _enc, payload) => {
    try { return Buffer.from(payload, 'base64').toString('utf8'); }
    catch { return ''; }
  }).replace(/=\?utf-8\?([Qq])\?([^?]+)\?=/gi, (_m, _enc, payload) => {
    return decodeQuotedPrintable(payload.replace(/_/g, ' '));
  });
}

function decodeQuotedPrintable(s: string): string {
  // Decode =XX hex escapes back to bytes, then interpret as utf-8.
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 61 /* '=' */ && i + 2 < s.length) {
      const hex = s.slice(i + 1, i + 3);
      if (hex === CRLF) { i += 2; continue; }  // soft line break
      const v = parseInt(hex, 16);
      if (!Number.isNaN(v)) {
        bytes.push(v);
        i += 2;
        continue;
      }
    }
    bytes.push(c);
  }
  return Buffer.from(bytes).toString('utf8');
}

function escapeHeaderQuoted(s: string): string {
  return s.replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
}

function wrapBase64(b64: string, columns = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += columns) lines.push(b64.slice(i, i + columns));
  return lines.join(CRLF);
}

function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/^(\w{3}), /, '$1, ');  // already RFC-1123 / 5322 compliant via toUTCString
}

function mintBoundary(): string {
  // RFC 2046 §5.1.1: 1-70 chars from a restricted set. Use hex + a
  // recognisable prefix so the wire is debuggable.
  return `nm-${randomHex(16)}`;
}

export function mintMessageId(domain = 'nostr-station'): string {
  return `<${randomHex(16)}@${domain}>`;
}

function randomHex(bytes: number): string {
  // Use Web Crypto where available (browser, modern node), fall back
  // to Math.random with the obvious caveats (we're only minting
  // collision-resistant identifiers, not key material).
  const g: any = globalThis as any;
  if (g.crypto?.getRandomValues) {
    const buf = new Uint8Array(bytes);
    g.crypto.getRandomValues(buf);
    return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return out;
}

// ── Threshold helper ──────────────────────────────────────────────────────

export function shouldInlineByteCount(bytes: number): boolean {
  return bytes <= INLINE_THRESHOLD_BYTES;
}
export { INLINE_THRESHOLD_BYTES };
