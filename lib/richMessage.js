// v0.56: TDLib 1.8.65 messageRichMessage(PageBlock) -> formattedText 평탄화.
// Bot API 10.1 로부터 봇이 본문을 richMessage 로 보내는 경우, 기존 파이프라인은
// content.text 가 비어 v2 가 미표시. 본 모듈은 PageBlock/RichText 트리를 순회해 누적 text 와
// 인라인 텍스트 엔티티(Bold/Italic/Underline/Strikethrough/Spoiler/Code/Pre/TextUrl 등) 를 만든다.
// UTF-16 코드유닛 기준 — JS string.length 가 곧 TDLib offset 규약과 일치.

function _appendEntity(out, type, offset, length) {
  if (!type || length <= 0) return;
  out.entities.push({ _: 'textEntity', offset, length, type });
}

function _renderRichText(rt, out) {
  if (!rt || typeof rt !== 'object') return;
  const t = rt._;
  if (t === 'richTextPlain') {
    if (rt.text) out.text += rt.text;
    return;
  }
  if (t === 'richTexts') {
    for (const child of (rt.texts || [])) _renderRichText(child, out);
    return;
  }
  if (t === 'richTextCustomEmoji') {
    if (rt.alternative_text) {
      const s = out.text.length;
      out.text += rt.alternative_text;
      if (rt.custom_emoji_id) {
        _appendEntity(out,
          { _: 'textEntityTypeCustomEmoji', custom_emoji_id: String(rt.custom_emoji_id) },
          s, out.text.length - s);
      }
    }
    return;
  }
  if (t === 'richTextIcon' || t === 'richTextAnchor') return;
  if (t === 'richTextMathematicalExpression') {
    if (rt.expression) {
      const s = out.text.length;
      out.text += rt.expression;
      _appendEntity(out, { _: 'textEntityTypeCode' }, s, out.text.length - s);
    }
    return;
  }
  const childStart = out.text.length;
  if (rt.text) _renderRichText(rt.text, out);
  const length = out.text.length - childStart;
  let type = null;
  switch (t) {
    case 'richTextBold': type = { _: 'textEntityTypeBold' }; break;
    case 'richTextItalic': type = { _: 'textEntityTypeItalic' }; break;
    case 'richTextUnderline': type = { _: 'textEntityTypeUnderline' }; break;
    case 'richTextStrikethrough': type = { _: 'textEntityTypeStrikethrough' }; break;
    case 'richTextSpoiler': type = { _: 'textEntityTypeSpoiler' }; break;
    case 'richTextFixed': type = { _: 'textEntityTypeCode' }; break;
    case 'richTextUrl':
      type = rt.url ? { _: 'textEntityTypeTextUrl', url: rt.url } : null; break;
    case 'richTextAnchorLink':
    case 'richTextReferenceLink':
      type = rt.url ? { _: 'textEntityTypeTextUrl', url: rt.url } : null; break;
    case 'richTextEmailAddress': type = { _: 'textEntityTypeEmailAddress' }; break;
    case 'richTextPhoneNumber': type = { _: 'textEntityTypePhoneNumber' }; break;
    case 'richTextMention': type = { _: 'textEntityTypeMention' }; break;
    case 'richTextMentionName':
      type = rt.user_id ? { _: 'textEntityTypeMentionName', user_id: rt.user_id } : null; break;
    case 'richTextHashtag': type = { _: 'textEntityTypeHashtag' }; break;
    case 'richTextCashtag': type = { _: 'textEntityTypeCashtag' }; break;
    case 'richTextBotCommand': type = { _: 'textEntityTypeBotCommand' }; break;
    case 'richTextBankCardNumber': type = { _: 'textEntityTypeBankCardNumber' }; break;
    default: type = null; break;
  }
  if (type && length > 0) _appendEntity(out, type, childStart, length);
}

function _ensureBlankLine(out) {
  if (out.text.length === 0) return;
  if (out.text.endsWith('\n\n')) return;
  if (out.text.endsWith('\n')) { out.text += '\n'; return; }
  out.text += '\n\n';
}

function _renderBlock(b, out) {
  if (!b || typeof b !== 'object') return;
  const t = b._;
  switch (t) {
    case 'pageBlockParagraph':
    case 'pageBlockThinking': {
      _ensureBlankLine(out);
      _renderRichText(b.text, out);
      break;
    }
    case 'pageBlockFooter': {
      _ensureBlankLine(out);
      _renderRichText(b.footer, out);
      break;
    }
    case 'pageBlockTitle': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.title, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeBold' }, s, l);
      break;
    }
    case 'pageBlockSubtitle': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.subtitle, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeBold' }, s, l);
      break;
    }
    case 'pageBlockHeader': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.header, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeBold' }, s, l);
      break;
    }
    case 'pageBlockSubheader': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.subheader, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeBold' }, s, l);
      break;
    }
    case 'pageBlockKicker': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.kicker, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeBold' }, s, l);
      break;
    }
    case 'pageBlockSectionHeading': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.text, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeBold' }, s, l);
      break;
    }
    case 'pageBlockPreformatted': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.text, out);
      const l = out.text.length - s;
      if (l > 0) {
        const lang = b.language || '';
        const type = lang
          ? { _: 'textEntityTypePreCode', language: lang }
          : { _: 'textEntityTypePre' };
        _appendEntity(out, type, s, l);
      }
      break;
    }
    case 'pageBlockBlockQuote': {
      _ensureBlankLine(out);
      const s = out.text.length;
      for (const child of (b.blocks || [])) _renderBlock(child, out);
      if (b.text) _renderRichText(b.text, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeBlockQuote' }, s, l);
      if (b.credit) {
        _ensureBlankLine(out);
        const cs = out.text.length;
        out.text += '— ';
        _renderRichText(b.credit, out);
        const cl = out.text.length - cs;
        if (cl > 0) _appendEntity(out, { _: 'textEntityTypeItalic' }, cs, cl);
      }
      break;
    }
    case 'pageBlockPullQuote': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.text, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeBlockQuote' }, s, l);
      if (b.credit) {
        _ensureBlankLine(out);
        const cs = out.text.length;
        out.text += '— ';
        _renderRichText(b.credit, out);
        const cl = out.text.length - cs;
        if (cl > 0) _appendEntity(out, { _: 'textEntityTypeItalic' }, cs, cl);
      }
      break;
    }
    case 'pageBlockList': {
      _ensureBlankLine(out);
      const items = b.items || [];
      items.forEach((item, idx) => {
        if (idx > 0 && !out.text.endsWith('\n')) out.text += '\n';
        const label = item.label || '•';
        const check = item.has_checkbox ? (item.is_checked ? '[x] ' : '[ ] ') : '';
        out.text += label + (label ? ' ' : '') + check;
        for (const child of (item.blocks || [])) _renderBlock(child, out);
      });
      break;
    }
    case 'pageBlockDetails': {
      _ensureBlankLine(out);
      const hs = out.text.length;
      _renderRichText(b.header, out);
      const hl = out.text.length - hs;
      if (hl > 0) _appendEntity(out, { _: 'textEntityTypeBold' }, hs, hl);
      for (const child of (b.blocks || [])) _renderBlock(child, out);
      break;
    }
    case 'pageBlockTable': {
      _ensureBlankLine(out);
      if (b.caption) {
        const cs = out.text.length;
        _renderRichText(b.caption, out);
        const cl = out.text.length - cs;
        if (cl > 0) _appendEntity(out, { _: 'textEntityTypeBold' }, cs, cl);
      }
      const rows = b.cells || [];
      rows.forEach((row, ri) => {
        if (out.text.length > 0 && !out.text.endsWith('\n')) out.text += '\n';
        (row || []).forEach((cell, ci) => {
          if (ci > 0) out.text += ' | ';
          if (cell && cell.text) _renderRichText(cell.text, out);
        });
      });
      break;
    }
    case 'pageBlockDivider': {
      _ensureBlankLine(out);
      out.text += '———';
      break;
    }
    case 'pageBlockMathematicalExpression': {
      if (b.expression) {
        _ensureBlankLine(out);
        const s = out.text.length;
        out.text += b.expression;
        const l = out.text.length - s;
        if (l > 0) _appendEntity(out, { _: 'textEntityTypeCode' }, s, l);
      }
      break;
    }
    case 'pageBlockAuthorDate': {
      _ensureBlankLine(out);
      const s = out.text.length;
      _renderRichText(b.author, out);
      const l = out.text.length - s;
      if (l > 0) _appendEntity(out, { _: 'textEntityTypeItalic' }, s, l);
      break;
    }
    case 'pageBlockCover': {
      if (b.cover) _renderBlock(b.cover, out);
      break;
    }
    case 'pageBlockCollage':
    case 'pageBlockSlideshow':
    case 'pageBlockEmbeddedPost': {
      for (const child of (b.blocks || [])) _renderBlock(child, out);
      if (b.caption && b.caption.text) {
        _ensureBlankLine(out);
        _renderRichText(b.caption.text, out);
      }
      break;
    }
    case 'pageBlockAnimation':
    case 'pageBlockAudio':
    case 'pageBlockPhoto':
    case 'pageBlockVideo':
    case 'pageBlockVoiceNote':
    case 'pageBlockMap':
    case 'pageBlockEmbedded': {
      if (b.caption && b.caption.text) {
        _ensureBlankLine(out);
        _renderRichText(b.caption.text, out);
      }
      break;
    }
    case 'pageBlockAnchor':
    case 'pageBlockChatLink':
    case 'pageBlockRelatedArticles':
      break;
    default: {
      if (b.text) { _ensureBlankLine(out); _renderRichText(b.text, out); }
      else if (b.caption && b.caption.text) { _ensureBlankLine(out); _renderRichText(b.caption.text, out); }
      else if (Array.isArray(b.blocks)) { for (const c of b.blocks) _renderBlock(c, out); }
      break;
    }
  }
}

function flattenRichMessage(rm) {
  if (!rm || rm._ !== 'richMessage') return { text: '', entities: [] };
  const out = { text: '', entities: [] };
  for (const b of (rm.blocks || [])) _renderBlock(b, out);
  const leadMatch = out.text.match(/^\s*/);
  const lead = leadMatch ? leadMatch[0].length : 0;
  const trimmed = out.text.replace(/^\s+|\s+$/g, '');
  if (!trimmed) return { text: '[빈 리치 메시지]', entities: [] };
  const entities = out.entities
    .map(e => ({ _: 'textEntity', offset: e.offset - lead, length: e.length, type: e.type }))
    .filter(e => e.offset >= 0 && e.length > 0 && e.offset < trimmed.length)
    .map(e => (e.offset + e.length > trimmed.length)
      ? { _: 'textEntity', offset: e.offset, length: trimmed.length - e.offset, type: e.type }
      : e)
    .filter(e => e.length > 0);
  return { text: trimmed, entities };
}

// === Stage B-1 (2026-06-19): richMessage -> Markdown 원문 재구성 ===
// 평탄화(text+entities)는 인라인 서식만 보존하므로 표/헤더/목록 같은 블록 마크다운이 손실.
// v2 가 markdown-it 류로 재렌더할 수 있게 충실한 마크다운 문자열을 만들어 content.rich_markdown
// 으로 함께 실어 보낸다. flattenRichMessage 와는 독립적으로 동일 트리를 다시 순회한다.
// richTextPlain 안에 봇이 의도한 표·헤더·목록 리터럴 md 가 들어오므로 **이스케이프 금지**.

function _richTextToMd(rt) {
  if (!rt || typeof rt !== 'object') return '';
  const t = rt._;
  if (t === 'richTextPlain') return rt.text || '';
  if (t === 'richTexts') return (rt.texts || []).map(_richTextToMd).join('');
  if (t === 'richTextCustomEmoji') return rt.alternative_text || '';
  if (t === 'richTextIcon' || t === 'richTextAnchor' || t === 'richTextReference') return '';
  if (t === 'richTextMathematicalExpression') {
    return rt.expression ? '`' + rt.expression + '`' : '';
  }
  const inner = _richTextToMd(rt.text);
  switch (t) {
    case 'richTextBold': return inner ? '**' + inner + '**' : '';
    case 'richTextItalic': return inner ? '*' + inner + '*' : '';
    case 'richTextStrikethrough': return inner ? '~~' + inner + '~~' : '';
    case 'richTextFixed': return inner ? '`' + inner + '`' : '';
    case 'richTextUnderline': return inner;
    case 'richTextSpoiler': return inner ? '||' + inner + '||' : '';
    case 'richTextUrl':
    case 'richTextAnchorLink':
    case 'richTextReferenceLink':
      return rt.url ? '[' + (inner || rt.url) + '](' + rt.url + ')' : inner;
    case 'richTextEmailAddress':
    case 'richTextPhoneNumber':
    case 'richTextMention':
    case 'richTextHashtag':
    case 'richTextCashtag':
    case 'richTextBotCommand':
    case 'richTextBankCardNumber':
    case 'richTextMentionName':
    case 'richTextMarked':
    case 'richTextSubscript':
    case 'richTextSuperscript':
      return inner;
    default:
      if (rt.text) return inner;
      if (Array.isArray(rt.texts)) return rt.texts.map(_richTextToMd).join('');
      return '';
  }
}

function _prefixLines(s, prefix) {
  return (s || '').split('\n').map(line => prefix + line).join('\n');
}

function _blockToMd(b) {
  if (!b || typeof b !== 'object') return '';
  const t = b._;
  switch (t) {
    case 'pageBlockParagraph':
    case 'pageBlockThinking':
      return _richTextToMd(b.text);
    case 'pageBlockFooter':
      return _richTextToMd(b.footer);
    case 'pageBlockTitle':
    case 'pageBlockHeader':
      return '## ' + _richTextToMd(b.title || b.header || b.text);
    case 'pageBlockSubtitle':
    case 'pageBlockSubheader':
    case 'pageBlockKicker':
    case 'pageBlockSectionHeading':
      return '### ' + _richTextToMd(b.subtitle || b.subheader || b.kicker || b.text);
    case 'pageBlockPreformatted': {
      const lang = b.language || '';
      const body = _richTextToMd(b.text);
      return '```' + lang + '\n' + body + '\n```';
    }
    case 'pageBlockBlockQuote':
    case 'pageBlockPullQuote': {
      const parts = [];
      if (Array.isArray(b.blocks)) {
        for (const c of b.blocks) {
          const cm = _blockToMd(c);
          if (cm) parts.push(cm);
        }
      }
      if (b.text) parts.push(_richTextToMd(b.text));
      let body = parts.join('\n\n');
      let out = _prefixLines(body, '> ');
      if (b.credit) {
        const credit = _richTextToMd(b.credit);
        if (credit) out += '\n> — ' + credit;
      }
      return out;
    }
    case 'pageBlockList': {
      const items = b.items || [];
      const lines = [];
      items.forEach((item) => {
        const rawLabel = item.label != null ? String(item.label) : '';
        const isNumeric = /^\d+$/.test(rawLabel);
        const marker = isNumeric ? (rawLabel + '. ') : '- ';
        const check = item.has_checkbox ? (item.is_checked ? '[x] ' : '[ ] ') : '';
        const inner = (item.page_blocks || item.blocks || [])
          .map(_blockToMd).filter(Boolean).join('\n\n');
        if (!inner) {
          lines.push(marker + check + (isNumeric ? '' : rawLabel));
          return;
        }
        const innerLines = inner.split('\n');
        const first = innerLines.shift();
        lines.push(marker + check + first);
        for (const ln of innerLines) lines.push('  ' + ln);
      });
      return lines.join('\n');
    }
    case 'pageBlockDetails': {
      const header = _richTextToMd(b.header);
      const inner = (b.page_blocks || b.blocks || [])
        .map(_blockToMd).filter(Boolean).join('\n\n');
      const head = header ? '**' + header + '**' : '';
      return [head, inner].filter(Boolean).join('\n\n');
    }
    case 'pageBlockTable': {
      const rows = b.cells || [];
      const tableLines = [];
      const caption = b.caption ? _richTextToMd(b.caption) : '';
      if (caption) tableLines.push(caption);
      const rowMd = (row) => '| ' + (row || []).map(cell => {
        const txt = cell && cell.text ? _richTextToMd(cell.text) : '';
        return (txt || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      }).join(' | ') + ' |';
      if (rows.length > 0) {
        const header = rows[0] || [];
        tableLines.push(rowMd(header));
        tableLines.push('| ' + header.map(() => '---').join(' | ') + ' |');
        for (let i = 1; i < rows.length; i++) tableLines.push(rowMd(rows[i]));
      }
      return tableLines.join('\n');
    }
    case 'pageBlockDivider':
      return '---';
    case 'pageBlockMathematicalExpression':
      return b.expression ? '`' + b.expression + '`' : '';
    case 'pageBlockAuthorDate':
      return b.author ? '*' + _richTextToMd(b.author) + '*' : '';
    case 'pageBlockCover':
      return b.cover ? _blockToMd(b.cover) : '';
    case 'pageBlockCollage':
    case 'pageBlockSlideshow':
    case 'pageBlockEmbeddedPost': {
      const inner = (b.blocks || []).map(_blockToMd).filter(Boolean).join('\n\n');
      const cap = b.caption && b.caption.text ? _richTextToMd(b.caption.text) : '';
      return [inner, cap].filter(Boolean).join('\n\n');
    }
    case 'pageBlockAnimation':
    case 'pageBlockAudio':
    case 'pageBlockPhoto':
    case 'pageBlockVideo':
    case 'pageBlockVoiceNote':
    case 'pageBlockMap':
    case 'pageBlockEmbedded':
      return b.caption && b.caption.text ? _richTextToMd(b.caption.text) : '';
    case 'pageBlockAnchor':
    case 'pageBlockChatLink':
    case 'pageBlockRelatedArticles':
    case 'pageBlockFootnote':
      return b.text ? _richTextToMd(b.text) : '';
    default: {
      if (b.text) return _richTextToMd(b.text);
      if (b.caption && b.caption.text) return _richTextToMd(b.caption.text);
      if (Array.isArray(b.blocks)) {
        return b.blocks.map(_blockToMd).filter(Boolean).join('\n\n');
      }
      return '';
    }
  }
}

function richMessageToMarkdown(rm) {
  if (!rm || rm._ !== 'richMessage') return '';
  const parts = [];
  for (const b of (rm.blocks || [])) {
    const md = _blockToMd(b);
    if (md) parts.push(md);
  }
  return parts.join('\n\n').replace(/^\s+|\s+$/g, '');
}

// messageRichMessage content 에 평탄화 결과를 in-place 주입.
// is_full=false 면 getFullRichMessage 로 완전본 시도 후 평탄화.
// Stage B-1: 동일 풀본 rm 으로 content.rich_markdown(마크다운 원문 재구성)도 동시 주입.
async function maybeFlattenRich(message, accountClient) {
  if (!message || !message.content || message.content._ !== 'messageRichMessage') return;
  let rm = message.content.message;
  if (!rm) return;
  if (rm.is_full === false && accountClient && message.chat_id && message.id) {
    try {
      const full = await accountClient.invoke({
        _: 'getFullRichMessage', chat_id: message.chat_id, message_id: message.id,
      });
      if (full && full._ === 'richMessage') rm = full;
    } catch (e) {
      console.error('[richMessage] getFullRichMessage failed chat=' + message.chat_id
        + ' msg=' + message.id + ' err=' + (e && e.message || e));
    }
  }
  const { text, entities } = flattenRichMessage(rm);
  message.content.text = { _: 'formattedText', text, entities };
  try {
    const md = richMessageToMarkdown(rm);
    if (md) message.content.rich_markdown = md;
  } catch (e) {
    console.error('[richMessage] richMessageToMarkdown failed: ' + (e && e.message || e));
  }
}

module.exports = { flattenRichMessage, maybeFlattenRich, richMessageToMarkdown };
