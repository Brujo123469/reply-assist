// Incremental parser for Claude's streamed reply format:
//
//   T: <what they said, translated>
//   1: <reply in their language> | <meaning in your language>
//      or, for languages in another script (Japanese, Korean, ...):
//   1: <reply in that script> | <pronunciation in Latin letters> | <meaning>
//   2: ...
//   3: ...
//   R: yes|no   (do the replies fit any conversation? decides phrasebook learning)
//
// Each line is emitted as soon as its newline arrives, so the HUD can show the
// translation before the replies finish streaming.

export function parseLine(line) {
  // NFKC turns full-width "１：" and "｜" (common when replying in Japanese or
  // Chinese) into ASCII; markdown bold around the tag is tolerated too.
  const m = /^\s*[*_]*([T123R])[*_]*\s*[:.)]\s*(.+?)\s*$/i.exec(String(line).normalize('NFKC'));
  if (!m) return null;
  const tag = m[1].toUpperCase();
  const body = m[2].replace(/^[*_]+\s*/, '');
  if (tag === 'T') return { type: 'translation', text: body };
  if (tag === 'R') return { type: 'reusable', value: /^(yes|y|true)\b/i.test(body) };
  const reply = splitReply(body);
  if (!reply.text) return null;
  return { type: 'reply', index: Number(tag) - 1, ...reply };
}

/**
 * "<reply> | <meaning>" or "<reply> | <pronunciation> | <meaning>".
 * reading is only present when there's a pronunciation part.
 */
export function splitReply(line) {
  const parts = String(line).split(/[|｜]/).map((p) => p.trim());
  // "~ " marks a point from Claude's own knowledge rather than the wearer's
  // notes (Q&A assist): shown with a "verify" mark.
  const verify = /^[~〜]\s*/.test(parts[0] ?? '');
  if (verify) parts[0] = parts[0].replace(/^[~〜]\s*/, '');
  const flag = verify ? { verify: true } : {};
  if (parts.length >= 3 && parts[1]) return { text: parts[0], gloss: parts.slice(2).join(' | '), reading: parts[1], ...flag };
  return { text: parts[0] ?? '', gloss: parts.length >= 3 ? parts.slice(2).join(' | ') : parts[1] ?? '', ...flag };
}

export function createReplyParser(onItem) {
  let buffer = '';
  const flushLine = (line) => {
    const item = parseLine(line);
    if (item) onItem(item);
  };
  return {
    push(delta) {
      buffer += delta;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        flushLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    end() {
      if (buffer.trim()) flushLine(buffer);
      buffer = '';
    },
  };
}

/** Parse "<reply> | [<reading> |] <gloss>" lines, used for the instant reply bank. */
export function parseBank(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.):])\s*/, ''))
    .map((line) => ({ ...splitReply(line), source: 'bank' }))
    .filter((item) => item.text && item.text.length <= 60);
}
