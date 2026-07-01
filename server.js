const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const tdl = require('tdl');
const { getTdjson } = require('prebuilt-tdlib');
const archive = require('./chat-archive');
const { markSavedMessages } = require('./lib/savedMessages');
const { flattenRichMessage, maybeFlattenRich, richMessageToMarkdown } = require('./lib/richMessage');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 100 * 1024 * 1024,  // 100MB
  transports: ['polling'],  // Cloudflare Tunnel WSS 미지원 → polling 전용
  allowEIO3: true,
  pingTimeout: 30000,       // 30초 ping 타임아웃
  pingInterval: 10000,      // 10초 간격 ping (Cloudflare 100초 내 여유)
  httpCompression: true,
  cors: { origin: '*' }
});

// v0.27: chatUpdate 를 같은 메시지의 newMessage emit 뒤로 직렬화
// TDLib 는 updateNewMessage 직후 updateChatLastMessage 를 별도 콜백으로 전달하는데,
// updateNewMessage 는 enrich(async) 후 emit 되는 반면 updateChatLastMessage 는 즉시 emit 되어
// 클라가 chatUpdate(lastMessageId=새 메시지) 를 먼저 받고 newMessage 를 나중에 받는 역전이 발생.
// v2 클라의 selectIsViewportNewest 가 viewportIds[last] < lastMessageId 로 판정하여 addViewportId 를
// 스킵 → 열린 채팅에서 새 메시지가 렌더되지 않음.
const pendingNewMsg = new Map();   // key=`${accountId}:${chatId}` -> Set<msgId>
const heldChatUpdates = new Map(); // key -> Array<{ msgId, payload, timer }>

function _pkey(accountId, chatId) { return accountId + ':' + String(chatId); }
function _addPending(key, msgId) {
  if (!pendingNewMsg.has(key)) pendingNewMsg.set(key, new Set());
  pendingNewMsg.get(key).add(msgId);
}
function _removePending(key, msgId) {
  const s = pendingNewMsg.get(key);
  if (s) { s.delete(msgId); if (!s.size) pendingNewMsg.delete(key); }
}
function _isPending(key, msgId) {
  const s = pendingNewMsg.get(key);
  return !!(s && s.has(msgId));
}
function _flushHeld(key, msgId) {
  const arr = heldChatUpdates.get(key);
  if (!arr) return;
  const remain = [];
  for (const h of arr) {
    if (h.msgId === msgId) {
      clearTimeout(h.timer);
      io.emit('chatUpdate', h.payload);
      console.log('[v0.27 order] flush chatUpdate after newMessage key', key, 'msg', msgId);
    } else {
      remain.push(h);
    }
  }
  if (remain.length) heldChatUpdates.set(key, remain);
  else heldChatUpdates.delete(key);
}

const PORT = process.env.PORT || 9071;

// v0.4: MIME 타입 헬퍼
function getMimeType(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const mimeTypes = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    js: 'application/javascript',
    json: 'application/json',
    html: 'text/html',
    css: 'text/css'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// Telegram API 자격증명
const API_ID = process.env.TELEGRAM_API_ID || '';
const API_HASH = process.env.TELEGRAM_API_HASH || '';

// TDLib 설정
tdl.configure({ tdjson: getTdjson() });

// === 다계정 지원 (v0.11) ===
const ACCOUNTS = {
  main: {
    id: 'main',
    label: '본계정',
    dbDir: path.join(__dirname, 'tdlib-db', 'main'),
    filesDir: path.join(__dirname, 'tdlib-files', 'main'),
    client: null,
    authState: null,
    isAuthorized: false,
    initialized: false,
    myUserId: null,   // v0.13: 본인 user_id (Saved Messages 식별용)
  },
  sub: {
    id: 'sub',
    label: '부계정',
    dbDir: path.join(__dirname, 'tdlib-db', 'sub'),
    filesDir: path.join(__dirname, 'tdlib-files', 'sub'),
    client: null,
    authState: null,
    isAuthorized: false,
    initialized: false,
    myUserId: null,   // v0.13: 본인 user_id (Saved Messages 식별용)
  },
};
let activeAccountId = 'main';

// 활성 계정의 client/authState/isAuthorized 를 가리키는 reactive 게터
function activeAcc() { return ACCOUNTS[activeAccountId]; }
function getClient(id) { return ACCOUNTS[id || activeAccountId].client; }

// 레거시 호환: 기존 코드의 client / authState / isAuthorized 참조를 그대로 지원
let client = null;            // = activeAcc().client
let authState = null;         // = activeAcc().authState
let isAuthorized = false;     // = activeAcc().isAuthorized

function refreshActiveAliases() {
  const a = activeAcc();
  client = a.client;
  authState = a.authState;
  isAuthorized = a.isAuthorized;
}

// v0.38: weba langpack 캐시 (langPack:langCode → { version, strings, keysToRemove } / ApiLanguage).
// fetchLanguage/fetchLangPack/fetchLangDifference 가 공유. TDLib 반복 호출을 줄이려는 단순 메모.
const _v38LangCache = {
  pack: new Map(), // 'weba:ko' → { version, strings, keysToRemove }
  lang: new Map(), // 'weba:ko' → ApiLanguage
};

function _v38BuildApiLanguage(p) {
  // TDLib languagePackInfo → telegram-tt-ref buildApiLanguage 와 동일 ApiLanguage 형태.
  if (!p) return null;
  return {
    langCode: p.id,
    baseLangCode: p.base_language_pack_id || undefined,
    name: p.name,
    nativeName: p.native_name,
    pluralCode: p.plural_code,
    isOfficial: !!p.is_official || undefined,
    isRtl: !!p.is_rtl || undefined,
    isBeta: !!p.is_beta || undefined,
    stringsCount: p.total_string_count,
    translatedCount: p.translated_string_count,
    translationsUrl: p.translation_url || '',
  };
}

function _v38LangVersion(strings) {
  // v0.39: strings 내용 기반 결정적 정수 해시(djb2, 32bit unsigned).
  // - 동일 strings → 동일 version (noop 안정, 무한 갱신 방지).
  // - strings 변경 또는 클라 오염 캐시(version=local_string_count)와 불일치 → merge 강제.
  const s = JSON.stringify(strings);
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

async function _v38BuildWebaLangPack(client, reqLangPack, langCode) {
  // weba 한국어 팩을 한 번 구성하여 캐시. fetchLangPack/fetchLangDifference 공통 헬퍼.
  // 반환: { version, strings, keysToRemove } — strings 는 신 LangPackStringValue 형태
  //   ({ zero?, one?, two?, few?, many?, other } — Value 접미 없음).
  const cacheKey = reqLangPack + ':' + langCode;
  const cached = _v38LangCache.pack.get(cacheKey);
  if (cached) return cached;
  try {
    try {
      await client.invoke({
        _: 'setOption',
        name: 'localization_target',
        value: { _: 'optionValueString', value: reqLangPack },
      });
    } catch (optErr) {
      console.warn('[v0.38 langpack] setOption soft-fail:', optErr.message);
    }
    try {
      await client.invoke({ _: 'synchronizeLanguagePack', language_pack_id: langCode });
    } catch (syncErr) {
      console.warn('[v0.38 langpack] synchronizeLanguagePack soft-fail:', syncErr.message);
    }
    const s = await client.invoke({
      _: 'getLanguagePackStrings',
      language_pack_id: langCode,
      keys: [],
    });
    const rawStrings = (s && s.strings) || [];
    const strings = {};
    const keysToRemove = [];
    for (const item of rawStrings) {
      if (!item || !item.key) continue;
      const v = item.value;
      if (!v) continue;
      if (v._ === 'languagePackStringValueOrdinary') {
        if (typeof v.value === 'string') strings[item.key] = v.value;
      } else if (v._ === 'languagePackStringValuePluralized') {
        const plural = {};
        if (v.zero_value) plural.zero = v.zero_value;
        if (v.one_value) plural.one = v.one_value;
        if (v.two_value) plural.two = v.two_value;
        if (v.few_value) plural.few = v.few_value;
        if (v.many_value) plural.many = v.many_value;
        // ref 타입상 other 는 required — TDLib 도 보통 채워줌. 비어있으면 폴백 빈문자.
        plural.other = v.other_value || '';
        strings[item.key] = plural;
      } else if (v._ === 'languagePackStringValueDeleted') {
        keysToRemove.push(item.key);
      }
    }
    // v0.39: version 은 strings 결정적 해시. local_string_count(비단조) 폐기.
    // 011 리포트 확정 결함 (b): 기존 클라 오염 캐시(version=local_string_count)와 불일치
    // 강제 → applyLangPackDifference noop early-return 회피, strings 머지 적용.
    const version = _v38LangVersion(strings);
    const built = { version, strings, keysToRemove };
    _v38LangCache.pack.set(cacheKey, built);
    return built;
  } catch (e) {
    console.error('[v0.38 langpack] build error:', e.message);
    return null;
  }
}

// Optimistic rendering: tempId → TDLib localId 매핑
const tempIdMap = new Map(); // tempId → { chatId, tdlibLocalId }

// Photo fileId 캐시 (downloadMedia용)
if (!global._photoFileIdCache) global._photoFileIdCache = {};

// v0.28: 아바타 fileId 캐시 (loadProfilePhoto / downloadMedia avatar 분기용)
// key: avatarPhotoId = photo.small.remote.id (영문자, 안정 식별자) — converters.ts 와 형식 일치
// value: { fileId, accountId } — fileId = photo.small.id (TDLib 로컬 file id, downloadFile 호출용)
if (!global._avatarFileIdCache) global._avatarFileIdCache = new Map();

// v0.55: TDLib chatMemberStatus → ApiChat 의 isCreator/adminRights/isNotJoined 매핑.
// selectCanManage(v2 global/selectors/management.ts) 가 isChatAdmin(=adminRights||isCreator)
// 와 isNotJoined 를 참조하여 그룹/채널 프로필 헤더의 연필(수정) 버튼 표시 여부를 결정.
// telegram-tt 의 ApiChatAdminRights 형식과 일치.
function buildChatStatusFields(statusObj) {
  if (!statusObj) return {};
  const t = statusObj._;
  if (t === 'chatMemberStatusCreator') {
    return {
      isCreator: true,
      adminRights: {
        changeInfo: true, postMessages: true, editMessages: true, deleteMessages: true,
        banUsers: true, inviteUsers: true, pinMessages: true, addAdmins: true,
        anonymous: statusObj.is_anonymous || undefined,
        manageCall: true, manageTopics: true,
        postStories: true, editStories: true, deleteStories: true,
      },
    };
  }
  if (t === 'chatMemberStatusAdministrator') {
    const r = statusObj.rights || {};
    return {
      adminRights: {
        changeInfo: r.can_change_info || undefined,
        postMessages: r.can_post_messages || undefined,
        editMessages: r.can_edit_messages || undefined,
        deleteMessages: r.can_delete_messages || undefined,
        banUsers: r.can_restrict_members || undefined,
        inviteUsers: r.can_invite_users || undefined,
        pinMessages: r.can_pin_messages || undefined,
        addAdmins: r.can_promote_members || undefined,
        anonymous: r.is_anonymous || undefined,
        manageCall: r.can_manage_video_chats || undefined,
        manageTopics: r.can_manage_topics || undefined,
        postStories: r.can_post_stories || undefined,
        editStories: r.can_edit_stories || undefined,
        deleteStories: r.can_delete_stories || undefined,
      },
    };
  }
  if (t === 'chatMemberStatusLeft' || t === 'chatMemberStatusBanned') {
    return { isNotJoined: true };
  }
  return {};
}

function buildApiChatFromTdlibChat(c, { isArchived = false, activeAccountId, statusFields = {} } = {}) {
  let chatType = 'chatTypePrivate';
  if (c.type?._ === 'chatTypeBasicGroup') chatType = 'chatTypeBasicGroup';
  else if (c.type?._ === 'chatTypeSupergroup') {
    chatType = c.type.is_channel ? 'chatTypeChannel' : 'chatTypeSuperGroup';
  } else if (c.type?._ === 'chatTypeSecret') chatType = 'chatTypeSecret';

  let avatarPhotoId;
  const small = c.photo?.small;
  const smallRemoteId = small?.remote?.id;
  const smallFileId = small?.id;
  if (smallRemoteId && smallFileId) {
    avatarPhotoId = String(smallRemoteId);
    global._avatarFileIdCache.set(avatarPhotoId, { fileId: smallFileId, accountId: activeAccountId });
  }

  return {
    id: String(c.id),
    title: c.title || '',
    type: chatType,
    unreadCount: c.unread_count || 0,
    unreadMentionsCount: c.unread_mention_count || 0,
    lastReadInboxMessageId: c.last_read_inbox_message_id || 0,
    lastReadOutboxMessageId: c.last_read_outbox_message_id || 0,
    creationDate: 0,
    folderId: isArchived ? 1 : undefined,
    isMuted: !!(c.notification_settings && c.notification_settings.mute_for > 0),
    isListed: true,
    avatarPhotoId,
    hasVideoAvatar: !!c.photo?.has_animation,
    ...statusFields,
    draftMessage: (() => {
      const cid = String(c.id);
      const dm = c.draft_message;
      const t = dm?.content?.text?.text;
      if (dm && t && t.trim()) {
        return {
          text: t,
          entities: dm.content?.text?.entities || [],
          date: dm.date || 0,
          ...(dm.reply_to?.message_id ? { replyToMessageId: dm.reply_to.message_id } : {}),
        };
      }
      if (draftCache.has(cid)) { const cv = draftCache.get(cid); if (cv && cv.text && cv.text.trim()) return cv; }
      return null;
    })(),
  };
}

async function buildApiChatWithStatus(client, c, options = {}) {
  let statusFields = {};
  try {
    if (c.type?._ === 'chatTypeBasicGroup' && c.type.basic_group_id) {
      const bg = await client.invoke({ _: 'getBasicGroup', basic_group_id: c.type.basic_group_id });
      statusFields = buildChatStatusFields(bg?.status);
    } else if (c.type?._ === 'chatTypeSupergroup' && c.type.supergroup_id) {
      const sg = await client.invoke({ _: 'getSupergroup', supergroup_id: c.type.supergroup_id });
      statusFields = buildChatStatusFields(sg?.status);
    }
  } catch (e) {
    console.error('[buildApiChatWithStatus] status fetch failed chat_id', c.id, e.message);
  }
  return buildApiChatFromTdlibChat(c, { ...options, statusFields });
}

function buildApiUserFromTdlibUser(u, activeAccountId) {
  let avatarPhotoId;
  const small = u.profile_photo?.small;
  const smallRemoteId = small?.remote?.id;
  const smallFileId = small?.id;
  if (smallRemoteId && smallFileId) {
    avatarPhotoId = String(smallRemoteId);
    global._avatarFileIdCache.set(avatarPhotoId, { fileId: smallFileId, accountId: activeAccountId });
  }
  const username = u.usernames?.active_usernames?.[0] || u.username || '';
  return {
    id: String(u.id),
    type: u.type?._ === 'userTypeBot' ? 'userTypeBot' : 'userTypeRegular',
    isMin: false,
    firstName: u.first_name || '',
    lastName: u.last_name || '',
    phoneNumber: u.phone_number || '',
    username,
    usernames: username ? [{ username, isActive: true, isEditable: false }] : undefined,
    hasUsername: username ? true : undefined,
    isVerified: !!u.is_verified,
    isPremium: !!u.is_premium,
    isContact: u.is_contact || undefined,
    isCloseFriend: u.is_close_friend || undefined,
    avatarPhotoId,
    hasVideoAvatar: !!u.profile_photo?.has_animation,
  };
}

async function buildSearchChatEntities(client, chatIds, activeAccountId, isArchived = false) {
  const chats = [];
  const userIds = new Set();
  const seenChatIds = new Set();
  for (const chatId of chatIds || []) {
    try {
      const c = await client.invoke({ _: 'getChat', chat_id: chatId });
      if (!c || seenChatIds.has(String(c.id))) continue;
      seenChatIds.add(String(c.id));
      chats.push(c);
      if (c.type?._ === 'chatTypePrivate' && c.type.user_id) userIds.add(c.type.user_id);
    } catch (e) {
      console.error('[searchChats] getChat failed chat_id', chatId, e.message);
    }
  }
  const apiChats = await Promise.all(chats.map((c) => buildApiChatWithStatus(client, c, { isArchived, activeAccountId })));
  const apiUsers = [];
  await Promise.all(Array.from(userIds).map(async (uid) => {
    try {
      const u = await client.invoke({ _: 'getUser', user_id: uid });
      if (u) apiUsers.push(buildApiUserFromTdlibUser(u, activeAccountId));
    } catch (e) {
      console.error('[searchChats] getUser failed user_id', uid, e.message);
    }
  }));
  return { chats: apiChats, users: apiUsers };
}

// v0.56: messageRichMessage 평탄화 헬퍼는 lib/richMessage.js 로 분리(테스트 용이).
// (이하 인라인 정의는 lib 로 이관되었음 — 본 영역은 buildSharedApiMessage 로 이어짐.)
function _DEPRECATED_INLINE_PLACEHOLDER_(out, type, offset, length) {
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
      const type = rt.custom_emoji_id
        ? { _: 'textEntityTypeCustomEmoji', custom_emoji_id: String(rt.custom_emoji_id) }
        : null;
      if (type) _appendEntity(out, type, s, out.text.length - s);
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

// v0.47: 공유미디어/히스토리 공용 메시지 빌더.
// fetchMessages 의 루프 본문(텍스트/사진/photoFileId 캐시/캡션/action)을 모듈 레벨로 추출하여
// searchMessagesInChat 핸들러와 공유. 동작은 fetchMessages 와 100% 동일.
function buildSharedApiMessage(m, numChatId) {
  const apiMsg = {
    id: m.id,
    chatId: String(numChatId),
    date: m.date,
    senderId: m.sender_id?.user_id ? String(m.sender_id.user_id)
      : m.sender_id?.chat_id ? String(m.sender_id.chat_id) : undefined,
    isOutgoing: m.is_outgoing || false,
    isForwardingAllowed: m.can_be_forwarded !== false,
    isProtected: m.can_be_forwarded === false,
    content: {
      text: m.content?.text ? { text: m.content.text.text || '', entities: m.content.text.entities } : undefined,
    },
    // reply_to 전달 (v2 converters가 처리)
    reply_to: m.reply_to || undefined,
  };

  // 사진 메시지: photo 데이터 포함
  if (m.content?._ === 'messagePhoto' && m.content.photo) {
    const sizes = m.content.photo.sizes || [];
    const photoId = String(m.content.photo.id || m.id);
    apiMsg.content.photo = {
      id: photoId,
      date: m.date,
      sizes: sizes.map(s => ({
        type: s.type || 'm',
        width: s.width || 0,
        height: s.height || 0,
        photoFileId: s.photo?.id,
      })),
    };
    // downloadMedia용 캐시: "photoId_sizeType" → fileId
    sizes.forEach(s => {
      if (s.photo?.id) {
        global._photoFileIdCache[`${photoId}_${s.type || 'm'}`] = s.photo.id;
      }
    });
    // v0.17.2: 가장 큰 size 를 'x' 별칭 + 'full' 별칭으로 동시 적재
    // (v2 의 target:'full' → photo{id} → server 의 requestedSize fallback 'x' 매핑 정합)
    const largestSize = sizes.reduce((max, s) => {
      if (!s.photo?.id) return max;
      const area = (s.width || 0) * (s.height || 0);
      const maxArea = (max?.width || 0) * (max?.height || 0);
      return area > maxArea ? s : max;
    }, null);
    if (largestSize?.photo?.id) {
      global._photoFileIdCache[`${photoId}_x`] = largestSize.photo.id;
      global._photoFileIdCache[`${photoId}_full`] = largestSize.photo.id;
      // v0.17.3: 진단 강화 — 응답에 박힐 photoFileId 들도 함께 로그
      const sizesDetail = sizes.map(s => (s.type || '?') + ':' + (s.photo?.id || 'NO_ID') + '(' + (s.width || 0) + 'x' + (s.height || 0) + ')').join(',');
      console.log('[fetchMessages photo] msgId=' + m.id + ' photoId=' + photoId + ' sizes=[' + sizesDetail + '] largest=' + (largestSize.type || '?') + ' largestFileId=' + largestSize.photo.id);
    }
    // 캡션
    if (m.content.caption?.text) {
      apiMsg.content.text = { text: m.content.caption.text, entities: m.content.caption.entities };
    }
  }

  // v0.56: messageRichMessage 동기 평탄화 안전망 (사전 maybeFlattenRich 미적용 빌더 경로)
  if (!apiMsg.content.text && m.content?._ === 'messageRichMessage' && m.content.message) {
    try {
      const { text, entities } = flattenRichMessage(m.content.message);
      apiMsg.content.text = { text, entities };
    } catch (e) {}
  }

  // Stage B-1 (2026-06-19): rich_markdown 동시 주입 (v2 markdown-it 렌더 준비).
  // maybeFlattenRich 가 사전에 채워둔 m.content.rich_markdown 우선, 없으면 동기 재구성.
  // [018] content._='messageText' 미설정으로 v2 converter switch 미진입 → unsupported 회귀 해소.
  if (m.content?._ === 'messageRichMessage') {
    if (apiMsg.content.text) apiMsg.content._ = 'messageText';
    if (m.content.rich_markdown) {
      apiMsg.content.rich_markdown = m.content.rich_markdown;
    } else if (m.content.message) {
      try {
        const md = richMessageToMarkdown(m.content.message);
        if (md) apiMsg.content.rich_markdown = md;
      } catch (e) {}
    }
  }

  // messageSticker: TDLib content 를 그대로 노출해 v2 converters.ts buildMediaContent 가 처리하도록 한다.
  // buildSharedApiMessage 가 action 으로 치환하면 v2 buildMediaContent 가 스티커 케이스를 못 만남.
  if (m.content?._ === 'messageSticker' && m.content.sticker) {
    apiMsg.content._ = m.content._;
    apiMsg.content.sticker = m.content.sticker;
  }

  // [042] Phase1: v2 buildMediaContent 가 blobUrl 없이 렌더 가능한 미디어 타입은
  // 원시 content 패스스루(content._ + 해당 미디어 객체). 다운로드는 소켓 downloadFile(로컬 id).
  // video/animation/videoNote(blobUrl=/api/file/{remote.id})·photo 내구성은 Phase2(별도).
  const PHASE1_MEDIA = {
    messageDocument: 'document',
    messageVoiceNote: 'voice_note',
    messageAudio: 'audio',
    messageLocation: 'location',
    messageVenue: 'venue',
    messageContact: 'contact',
    messagePoll: 'poll',
  };
  if (!apiMsg.content.text && !apiMsg.content.photo && !apiMsg.content._) {
    const _mk = m.content?._ && PHASE1_MEDIA[m.content._];
    if (_mk && m.content[_mk]) {
      apiMsg.content._ = m.content._;
      apiMsg.content[_mk] = m.content[_mk];
      if (m.content.caption?.text) {
        apiMsg.content.text = { text: m.content.caption.text, ...(m.content.caption.entities ? { entities: m.content.caption.entities } : {}) };
      }
    } else if (m.content?._ && m.content._ !== 'messageText') {
      apiMsg.content.action = { type: m.content._ };
    }
  }

  return apiMsg;
}

// v0.28: avatarPhotoId(remote.id) → { entry, via } 결정적 해석
// 1) cache hit → via='cache'
// 2) cache miss → 활성 계정 client 로 getRemoteFile(fileTypeProfilePhoto) 호출, 성공 시 cache 갱신 → via='remote'
// 3) 양쪽 실패 → null
async function resolveAvatarEntry(avatarPhotoId, fallbackAccountId) {
  const key = String(avatarPhotoId);
  const cached = global._avatarFileIdCache.get(key);
  if (cached) return { entry: cached, via: 'cache' };
  const accId = fallbackAccountId || (typeof activeAccountId !== 'undefined' ? activeAccountId : null);
  if (!accId) return null;
  const acc = ACCOUNTS[accId];
  if (!acc?.client) return null;
  try {
    const rf = await acc.client.invoke({
      _: 'getRemoteFile',
      remote_file_id: key,
      file_type: { _: 'fileTypeProfilePhoto' },
    });
    if (rf?.id) {
      const entry = { fileId: rf.id, accountId: accId };
      global._avatarFileIdCache.set(key, entry);
      return { entry, via: 'remote' };
    }
  } catch (e) {
    console.error('[resolveAvatarEntry] getRemoteFile fail photoId=' + key + ' acc=' + accId + ' msg=' + (e?.message || e));
  }
  return null;
}

// v0.8: newMessage emit 전 reply/forward/그룹발신자 메타 보강 (단일 메시지)
// 동일 보강 로직이 getMessages/getMessagesAround 핸들러 내부에도 존재 (batch 처리용).
// 본 함수는 단일 메시지(updateNewMessage) 경로에서만 사용한다.
async function enrichMessageMeta(message) {
  if (!message || !client) return;
  const chatId = message.chat_id;
  if (!chatId) return;

  // v0.56: messageRichMessage 평탄화 — action fallback / content.text 미설정 보다 선행
  try { await maybeFlattenRich(message, client); }
  catch (e) { console.error('[enrichMessageMeta] richMessage flatten error:', e.message); }

  let isGroupChat = false;
  try {
    const chat = await client.invoke({ _: 'getChat', chat_id: chatId });
    const t = chat.type?._;
    if (t === 'chatTypeBasicGroup') isGroupChat = true;
    else if (t === 'chatTypeSupergroup') {
      const sg = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id });
      isGroupChat = !sg.is_channel;
    }
  } catch (e) {}

  if (message.forward_info) {
    const origin = message.forward_info.origin;
    if (origin) {
      if (origin.sender_name) {
        message._forwardFrom = origin.sender_name;
      } else if (origin.sender_user_id) {
        try {
          const fwdUser = await client.invoke({ _: 'getUser', user_id: origin.sender_user_id });
          message._forwardFrom = fwdUser.first_name + (fwdUser.last_name ? ' ' + fwdUser.last_name : '');
        } catch (e) { message._forwardFrom = '사용자'; }
      } else if (origin.chat_id || origin.sender_chat_id) {
        try {
          const fwdChat = await client.invoke({ _: 'getChat', chat_id: origin.chat_id || origin.sender_chat_id });
          message._forwardFrom = fwdChat.title || '채팅';
        } catch (e) { message._forwardFrom = '채팅'; }
      }
    }
  }

  if (isGroupChat && !message.is_outgoing && message.sender_id?.user_id) {
    const userId = message.sender_id.user_id;
    try {
      const user = await client.invoke({ _: 'getUser', user_id: userId });
      message._senderName = user.first_name + (user.last_name ? ' ' + user.last_name : '');
    } catch (e) { message._senderName = '사용자'; }
    message._senderId = userId;
  }

  const replyToMsgId = message.reply_to?.message_id || message.reply_to_message_id || message.reply_in_chat_id;
  if (replyToMsgId) {
    try {
      const replyMsg = await client.invoke({ _: 'getMessage', chat_id: chatId, message_id: replyToMsgId });
      if (replyMsg) {
        let replySenderName = replyMsg.is_outgoing ? '나' : '상대방';
        if (isGroupChat && !replyMsg.is_outgoing && replyMsg.sender_id?.user_id) {
          try {
            const u = await client.invoke({ _: 'getUser', user_id: replyMsg.sender_id.user_id });
            replySenderName = u.first_name + (u.last_name ? ' ' + u.last_name : '');
          } catch (e) { replySenderName = '사용자'; }
        }
        message._replyTo = {
          id: replyMsg.id,
          senderName: replySenderName,
          text: replyMsg.content?.text?.text || replyMsg.content?.caption?.text || '[미디어]',
          isOutgoing: replyMsg.is_outgoing
        };
      }
    } catch (e) {
      console.error('[enrichMessageMeta] reply load error:', e.message);
    }
  }
}

// v0.19: messagePhoto 의 sizes 에 photoFileId 박기 + _photoFileIdCache 적재.
// fetchMessages / updateNewMessage / updateMessageSendSucceeded 가 공통 사용.
// raw TDLib message 의 content.photo.sizes[].photo.id 를 평탄화된 s.photoFileId 로 in-place 주입한다.
// (v2 converters.buildApiPhoto 는 sizes.filter(s => s.photoFileId) 로 selectableSizes 를 만든다)
// sizes 가 비어있으면 getMessage 로 재조회(분기 B 폴백).
async function ensurePhotoFileIds(message) {
  if (!message || message.content?._ !== 'messagePhoto' || !message.content.photo) return;
  let photo = message.content.photo;
  let sizes = photo.sizes || [];

  // 분기 B: sizes 비어있거나 photo.id 미적재 시 getMessage 로 재조회
  if (sizes.length === 0 || !sizes.some(s => s.photo?.id)) {
    try {
      const full = await client.invoke({ _: 'getMessage', chat_id: message.chat_id, message_id: message.id });
      if (full?.content?.photo) {
        message.content.photo = full.content.photo;
        photo = message.content.photo;
        sizes = photo.sizes || [];
        console.log('[v0.19 getMessage refetch] msgId=' + message.id + ' refetched sizes=' + sizes.length);
      }
    } catch (e) {
      console.warn('[v0.19 getMessage refetch] msgId=' + message.id + ' failed:', e.message);
    }
  }

  const photoId = String(photo.id || message.id);
  let injected = 0;
  sizes.forEach(s => {
    const fid = s.photo?.id;
    if (fid) {
      s.photoFileId = fid;
      global._photoFileIdCache[`${photoId}_${s.type || 'm'}`] = fid;
      injected++;
    }
  });
  const largest = sizes.reduce((max, s) => {
    if (!s.photo?.id) return max;
    const area = (s.width || 0) * (s.height || 0);
    const maxArea = (max?.width || 0) * (max?.height || 0);
    return area > maxArea ? s : max;
  }, null);
  if (largest?.photo?.id) {
    global._photoFileIdCache[`${photoId}_x`] = largest.photo.id;
    global._photoFileIdCache[`${photoId}_full`] = largest.photo.id;
  }
  console.log('[v0.19 ensurePhotoFileIds] msgId=' + message.id + ' photoId=' + photoId +
              ' sizesInjected=' + injected + '/' + sizes.length);
}

// 세션 설정
app.use(session({
  secret: 'telegram-web-secret-key',
  resave: false,
  saveUninitialized: true
}));

app.use(express.json());

// Host-based routing:
//   default: serve the v2 client dist for every host.
//   optional V1_HOST: serve legacy v1 static files from public/ when the request host matches.
const V2_DIST = process.env.V2_DIST_PATH
  ? path.resolve(__dirname, process.env.V2_DIST_PATH)
  : path.join(__dirname, '..', 'telegram-web-relay-client', 'dist');
const V1_HOST = (process.env.V1_HOST || '').trim().toLowerCase();

app.use((req, res, next) => {
  const isPassThrough = req.path === '/health' || req.path.startsWith('/socket.io') || req.path.startsWith('/api');
  const isV1Host = V1_HOST && req.hostname.toLowerCase() === V1_HOST;
  if (!isPassThrough && !isV1Host) {
    express.static(V2_DIST, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.set('Cache-Control', 'no-store');
      },
    })(req, res, () => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(V2_DIST, 'index.html'));
    });
  } else {
    next();
  }
});
app.use(express.static('public', { etag: false, maxAge: 0, setHeaders: (res) => { res.set('Cache-Control', 'no-store'); } }));

// TDLib 초기화 (계정 단위)
async function initAccount(id) {
  if (!API_ID || !API_HASH) {
    console.error('⚠️  TELEGRAM_API_ID와 TELEGRAM_API_HASH 환경변수를 설정하세요!');
    return;
  }
  const acc = ACCOUNTS[id];
  if (!acc) {
    console.error(`❌ initAccount: 알 수 없는 계정 id: ${id}`);
    return;
  }
  if (acc.initialized && acc.client) {
    console.log(`ℹ️  initAccount(${id}): 이미 초기화됨`);
    return;
  }
  try {
    acc.client = tdl.createClient({
      apiId: parseInt(API_ID),
      apiHash: API_HASH,
      databaseDirectory: acc.dbDir,
      filesDirectory: acc.filesDir,
    });
    acc.client.on('error', (e) => console.error(`[${id}] tdlib error:`, e));
    acc.client.on('update', (update) => handleUpdate(update, id));
    acc.initialized = true;
    console.log(`✅ TDLib 클라이언트 생성 완료 (${id} = ${acc.label})`);
    if (id === activeAccountId) refreshActiveAliases();
  } catch (err) {
    console.error(`❌ TDLib 초기화 실패 (${id}):`, err.message);
  }
}

async function initTdlib() {
  // v0.11: 메인 계정만 즉시 초기화. 부계정은 사용자가 명시적으로 switchAccount 시 lazy 초기화.
  await initAccount('main');
}

// TDLib 업데이트 핸들러
function handleUpdate(update, accountId = 'main') {
  // DEBUG: chatAction 이벤트 감지 확인
  if (update._ === 'updateChatAction') {
    console.log(`[DEBUG updateChatAction] raw:`, JSON.stringify(update).substring(0, 300));
  }
  switch (update._) {
    case 'updateAuthorizationState':
      ACCOUNTS[accountId].authState = update.authorization_state;
      if (accountId === activeAccountId) authState = ACCOUNTS[accountId].authState;
      handleAuthState(ACCOUNTS[accountId].authState, accountId);
      break;
    case 'updateNewMessage':
      console.log('[newMessage] id:', update.message?.id, 'chat:', update.message?.chat_id, 'sending_state:', update.message?.sending_state?._, 'account:', accountId);
      if (update.message) update.message._account = accountId;
      // Skip sending-state messages (temp); final version comes via updateMessageSendSucceeded
      if (!update.message?.sending_state) {
        // v0.27: 같은 메시지에 대한 chatUpdate 가 newMessage emit 이전에 도착하지 못하도록 pending 등록.
        // updateChatLastMessage 가 이 msgId 를 매칭하면 hold → newMessage emit 직후 flush.
        const _v27_key = _pkey(accountId, update.message.chat_id);
        const _v27_mid = update.message.id;
        _addPending(_v27_key, _v27_mid);
        (async () => {
          const t0 = Date.now();
          try {
            await enrichMessageMeta(update.message);
          } catch (e) {
            console.error('[newMessage] enrich error:', e.message);
          }
          try {
            await ensurePhotoFileIds(update.message);
          } catch (e) {
            console.error('[newMessage] ensurePhotoFileIds error:', e.message);
          }
          console.log('[newMessage] enrich took', Date.now() - t0, 'ms');
          io.emit('newMessage', update.message);
          // v0.27: pending 해제 + hold 된 chatUpdate flush (있다면)
          _removePending(_v27_key, _v27_mid);
          _flushHeld(_v27_key, _v27_mid);
          // v0.21: 권위 unread_count 동기화 — newMessage 직후 TDLib 의 권위 unread 상태를
          // chatReadInbox 로 follow-up emit. client 의 +1 자체 가산을 무력화하고
          // 서버 권위값으로 set 한다 (incoming/outgoing 무관). 활성 계정만 처리.
          if (accountId === activeAccountId) {
            try {
              const freshChat = await ACCOUNTS[accountId].client.invoke({
                _: 'getChat', chat_id: update.message.chat_id
              });
              console.log(`[v0.21 unread] chatId=${update.message.chat_id} server=${freshChat.unread_count} lastRead=${freshChat.last_read_inbox_message_id}`);
              io.emit('chatReadInbox', {
                chatId: update.message.chat_id,
                lastReadInboxMessageId: freshChat.last_read_inbox_message_id,
                unreadCount: freshChat.unread_count,
                account: accountId,
              });
            } catch (e) {
              console.error('[v0.21 unread] getChat error:', e.message);
            }
          }
        })();
      }
      break;
    case 'updateMessageSendSucceeded': {
      console.log('[msgSendOK] old:', update.old_message_id, 'new:', update.message?.id, 'chat:', update.message?.chat_id);
      // telegram-tt 참조: src/global/actions/apiUpdaters/messages.ts:463-493
      // tempId 매핑 찾기
      const mapping = tempIdMap.get(update.old_message_id);
      if (update.message) update.message._account = accountId;
      // v0.19: outgoing photo photoFileId 평탄화 후 emit (sender 측 무한 로딩 해소)
      (async () => {
        // outgoing 전달 forward_info -> _forwardFrom 해석 (라이브 발신 헤더 '알 수 없음' 수정)
        try {
          await enrichMessageMeta(update.message);
        } catch (e) {
          console.error('[msgSendOK] enrich error:', e.message);
        }
        try {
          await ensurePhotoFileIds(update.message);
        } catch (e) {
          console.error('[msgSendOK] ensurePhotoFileIds error:', e.message);
        }
        // v0.56: messageRichMessage 평탄화 (스트리밍 최종본이 richMessage 인 경우)
        try {
          await maybeFlattenRich(update.message, ACCOUNTS[accountId]?.client || client);
        } catch (e) {
          console.error('[msgSendOK] richMessage flatten error:', e.message);
        }
        if (mapping) {
          io.emit('messageSendSucceeded', {
            oldMessageId: mapping.tempId,
            message: update.message,
            account: accountId
          });
          tempIdMap.delete(update.old_message_id);
          console.log(`[msgSendOK] optimistic 교체: ${mapping.tempId} -> ${update.message.id}`);
        } else {
          console.log(`[msgSendOK] tempId 매핑 없음, old=${update.old_message_id}`);
        }
        // Also emit as newMessage (backward compatibility)
        io.emit('newMessage', update.message);
      })();
      break;
    }
    case 'updateMessageContent':
      // 메시지 본문 편집(스트리밍 LLM 응답 / 사용자 메시지 편집).
      // TDLib 스펙: chat_id, message_id, new_content(MessageContent)
      // 현재 v1 클라이언트는 텍스트 메시지(messageText)만 messageEdited 로 갱신함.
      console.log('[msgEdit content] chat:', update.chat_id, 'msg:', update.message_id,
                  'type:', update.new_content?._);
      if (update.new_content?._ === 'messageText') {
        const newText = update.new_content.text?.text || '';
        io.emit('messageEdited', {
          chatId: update.chat_id,
          messageId: update.message_id,
          text: newText,
          account: accountId
        });
      } else if (update.new_content?._ === 'messageRichMessage') {
        // v0.56: 스트리밍 LLM 응답이 richMessage 인 경우 평탄화하여 동일 messageEdited 채널로 송신
        (async () => {
          try {
            const synthetic = {
              chat_id: update.chat_id,
              id: update.message_id,
              content: update.new_content,
            };
            await maybeFlattenRich(synthetic, ACCOUNTS[accountId]?.client || client);
            const newText = synthetic.content?.text?.text || '';
            io.emit('messageEdited', {
              chatId: update.chat_id,
              messageId: update.message_id,
              text: newText,
              account: accountId
            });
          } catch (e) {
            console.error('[v0.56 richMessage edit] flatten error:', e.message);
          }
        })();
      }
      // v0.29 Phase2: v2 인라인 키보드 콜백 → 봇 메시지 편집(페이지네이션/키보드 갱신)
      // 흐름. updateMessageContent 가 본문 변경을 알려도 reply_markup 은 같이 오지 않으므로
      // 전체 메시지를 다시 가져와 raw 형태로 emit. v2 setupUpdates 의 messageContentUpdated
      // 핸들러가 buildApiMessage(Phase1) 로 reply_markup → inlineButtons 재변환한다.
      (async () => {
        try {
          const fullMsg = await client.invoke({
            _: 'getMessage', chat_id: update.chat_id, message_id: update.message_id,
          });
          if (fullMsg) {
            fullMsg._account = accountId;
            try { await maybeFlattenRich(fullMsg, client); }
            catch (e) { console.error('[v0.56 contentUpdate richFlatten]:', e.message); }
            io.emit('messageContentUpdated', fullMsg);
          }
        } catch (e) {
          console.error('[v0.29 contentUpdate] getMessage failed chat', update.chat_id,
                        'msg', update.message_id, e.message);
        }
      })();
      break;
    case 'updateMessageEdited':
      // 편집 메타(edit_date) 갱신 알림. 본문 변경은 updateMessageContent 로 분리되어 옴.
      console.log('[msgEdit meta] chat:', update.chat_id, 'msg:', update.message_id,
                  'edit_date:', update.edit_date);
      // v0.29 Phase2: TDLib 스펙상 reply_markup 단독 편집은 updateMessageContent 없이
      // updateMessageEdited 만 발화 가능(예: 동일 본문에 다음 페이지 키보드만 부착).
      // updateMessageContent 와 동일하게 full message 재전송 — v2 가 inlineButtons 갱신.
      (async () => {
        try {
          const fullMsg = await client.invoke({
            _: 'getMessage', chat_id: update.chat_id, message_id: update.message_id,
          });
          if (fullMsg) {
            fullMsg._account = accountId;
            try { await maybeFlattenRich(fullMsg, client); }
            catch (e) { console.error('[v0.56 metaEdit richFlatten]:', e.message); }
            io.emit('messageContentUpdated', fullMsg);
          }
        } catch (e) {
          console.error('[v0.29 metaEdit] getMessage failed chat', update.chat_id,
                        'msg', update.message_id, e.message);
        }
      })();
      break;
    case 'updateDeleteMessages':
      // v0.7.2: 외부 디바이스 발 다중 삭제 실시간 반영
      // from_cache=true 는 TDLib 내부 캐시 만료 신호이며 사용자 가시 삭제가 아님 → 스킵
      if (update.from_cache) break;
      console.log('[messagesDeleted] chat:', update.chat_id, 'ids:', update.message_ids?.length, 'permanent:', update.is_permanent);
      io.emit('messagesDeleted', {
        chatId: update.chat_id,
        messageIds: update.message_ids || [],
        isPermanent: !!update.is_permanent,
        account: accountId
      });
      break;
    case 'updateChatLastMessage': {
      const mainPos = (update.positions || []).find(p => p.list?._ === 'chatListMain');
      const payload = {
        chatId: update.chat_id,
        lastMessage: update.last_message,
        order: mainPos?.order || null,
        isPinned: !!mainPos?.is_pinned,
        inMain: !!mainPos,
        account: accountId
      };
      // v0.27: 같은 메시지의 newMessage emit 이 아직 비동기 enrich 중이라면 chatUpdate 를 hold.
      // newMessage emit 직후 _flushHeld 가 풀어주거나, 안전 타임아웃(1500ms) 으로 강제 flush.
      const _v27_key = _pkey(accountId, update.chat_id);
      const _v27_lastId = update.last_message?.id;
      if (_v27_lastId && _isPending(_v27_key, _v27_lastId)) {
        const timer = setTimeout(() => {
          const arr = heldChatUpdates.get(_v27_key);
          if (arr) {
            const h = arr.find(x => x.msgId === _v27_lastId);
            if (h) {
              io.emit('chatUpdate', h.payload);
              heldChatUpdates.set(_v27_key, arr.filter(x => x !== h));
              console.log('[v0.27 order] safety-flush chatUpdate key', _v27_key, 'msg', _v27_lastId);
            }
          }
        }, 1500);
        if (!heldChatUpdates.has(_v27_key)) heldChatUpdates.set(_v27_key, []);
        heldChatUpdates.get(_v27_key).push({ msgId: _v27_lastId, payload, timer });
        console.log('[v0.27 order] hold chatUpdate (pending newMessage) key', _v27_key, 'msg', _v27_lastId);
      } else {
        io.emit('chatUpdate', payload);
      }
      break;
    }
    case 'updateChatPosition': {
      if (update.position?.list?._ !== 'chatListMain') break;
      io.emit('chatPosition', {
        chatId: update.chat_id,
        order: update.position.order || '0',
        isPinned: !!update.position.is_pinned,
        inMain: update.position.order !== '0' && update.position.order !== 0,
        account: accountId
      });
      break;
    }
    case 'updateChatDraftMessage': {
      const dm = update.draft_message;
      const t = dm?.content?.text?.text;
      const draftMessage = (dm && t && t.trim()) ? {
        text: t,
        entities: dm.content?.text?.entities || [],
        date: dm.date || 0,
        ...(dm.reply_to?.message_id ? { replyToMessageId: dm.reply_to.message_id } : {}),
      } : null;
      console.log('[updateChatDraftMessage] chatId:', update.chat_id, 'text:', t ? JSON.stringify(t).slice(0, 40) : '(empty/null)');
      draftCache.set(String(update.chat_id), draftMessage);
      io.emit('chatDraft', { chatId: String(update.chat_id), draftMessage, account: accountId });
      break;
    }
    case 'updateChatNotificationSettings': {
      const ns = update.notification_settings;
      const isMuted = !!(ns && ns.mute_for > 0);
      console.log('[updateChatNotificationSettings] chatId:', update.chat_id, 'isMuted:', isMuted);
      io.emit('chatNotifySettings', { chatId: String(update.chat_id), isMuted, account: accountId });
      break;
    }
    case 'updateChatReadInbox':
      // telegram-tt 참조: src/global/actions/apiUpdaters/chats.ts:162-178
      // updateChatInbox → chat의 unreadCount와 lastReadInboxMessageId 업데이트
      io.emit('chatReadInbox', {
        chatId: update.chat_id,
        lastReadInboxMessageId: update.last_read_inbox_message_id,
        unreadCount: update.unread_count,
        account: accountId
      });
      break;
    case 'updateChatReadOutbox':
      io.emit('chatReadOutbox', {
        chatId: update.chat_id,
        lastReadOutboxMessageId: update.last_read_outbox_message_id,
        account: accountId
      });
      break;
    case 'updateChatAction':
      // v1.3: 입력 중 표시 — telegram-tt 기반 개선
      // telegram-tt: SendMessageCancelAction → typingStatus = undefined (즉시 제거)
      // telegram-tt: SendMessageTypingAction → typingStatus = { action, timestamp }
      (async () => {
        let userName = '상대방';
        try {
          const userId = update.sender_id?.user_id;
          if (userId) {
            const user = await client.invoke({ _: 'getUser', user_id: userId });
            userName = user.first_name || user.username || '상대방';
          }
        } catch (e) {}
        const connCount = io.sockets.sockets ? io.sockets.sockets.size : 0;
        console.log(`[typing] chat=${update.chat_id} user=${userName} action=${update.action?._} clients=${connCount}`);
        io.emit('chatAction', {
          chatId: update.chat_id,
          senderId: update.sender_id,
          action: update.action,
          userName,
          account: accountId
        });
      })();
      break;
  }
}

// 인증 상태 처리
function handleAuthState(state, accountId = activeAccountId) {
  console.log(`Auth state (${accountId}):`, state._);
  io.emit('authState', { state: state._, account: accountId });

  switch (state._) {
    case 'authorizationStateWaitPhoneNumber':
      io.emit('needPhone', { account: accountId });
      break;
    case 'authorizationStateWaitCode':
      io.emit('needCode', { account: accountId });
      break;
    case 'authorizationStateWaitPassword':
      io.emit('needPassword', { account: accountId });
      break;
    case 'authorizationStateReady':
      ACCOUNTS[accountId].isAuthorized = true;
      if (accountId === activeAccountId) isAuthorized = true;
      io.emit('authorized', { account: accountId });
      console.log(`✅ 텔레그램 로그인 완료 (${accountId})`);

      // v0.13: 본인 user_id 캐싱 (Saved Messages 식별용) — 활성/비활성 계정 모두
      (async () => {
        try {
          const me = await ACCOUNTS[accountId].client.invoke({ _: 'getMe' });
          ACCOUNTS[accountId].myUserId = me?.id || null;
          console.log(`[${accountId}] myUserId = ${ACCOUNTS[accountId].myUserId}`);
        } catch (e) {
          console.error(`[${accountId}] getMe 실패:`, e.message);
        }
      })();

      // 주요 채팅 openChat 은 활성 계정에서만 실행
      if (accountId === activeAccountId) {
        (async () => {
          const mainChats = (process.env.MAIN_CHATS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
          for (const chatId of mainChats) {
            try {
              await ACCOUNTS[accountId].client.invoke({ _: 'openChat', chat_id: chatId });
              console.log(`[openChat] ${chatId} opened for typing events`);
            } catch (e) {
              console.log(`[openChat] ${chatId} failed: ${e.message}`);
            }
          }
        })();
      }
      break;
  }
}

// v0.13: chat 객체에 Saved Messages 표시 메타(_isSavedMessages, _displayTitle) 부여.
// 모든 chat emit 지점에서 호출하여 일관된 표시를 보장한다.
// 순수 로직은 lib/savedMessages.js 의 markSavedMessages (단위 테스트 대상)에 위임.
function annotateSavedMessages(chat, accountId = activeAccountId) {
  return markSavedMessages(chat, ACCOUNTS[accountId] ? ACCOUNTS[accountId].myUserId : null);
}

// Socket.io 연결
// === 드래프트 캐시 (TDLib 동일 클라이언트 비에코 보완) ===
// TDLib는 setChatDraftMessage 호출 시 updateChatDraftMessage를 같은 클라이언트에 돌려주지 않아
// getChat 로컬 캐시가 즉시 갱신되지 않는다. 서버 레이어에서 캐시를 유지해 fetchChats에 오버레이.
const draftCache = new Map(); // chatId(string) -> { text, entities, date, replyToMessageId? } | null
// === 청크 업로드 버퍼 (회사망 5KB POST 한계 우회) ===
const pendingUploads = new Map(); // uploadId -> { prefix, fileName, mimeType, kind, total, parts[], received, socketId, ts }
setInterval(() => {
  const now = Date.now();
  for (const [uid, u] of pendingUploads) {
    if (now - u.ts > 5 * 60 * 1000) pendingUploads.delete(uid);
  }
}, 60 * 1000);

io.on('connection', (socket) => {
  console.log('클라이언트 연결:', socket.id);

  // 현재 인증 상태 전송
  if (authState) {
    socket.emit('authState', { state: authState._ });
    if (isAuthorized) socket.emit('authorized');
  }

  // v2: 클라이언트가 초기 authState 재요청
  socket.on('getAuthState', () => {
    console.log('[getAuthState] requested, current:', authState?._);
    if (authState) {
      socket.emit('authState', { state: authState._ });
    }
  });

  // 전화번호 입력 (활성 계정 대상, ack 콜백 옵셔널)
  socket.on('sendPhone', async (phone, ack) => {
    try {
      const acc = ACCOUNTS[activeAccountId];
      await acc.client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: phone });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit('error', err.message);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // 인증코드 입력 (활성 계정 대상, ack 콜백 옵셔널)
  socket.on('sendCode', async (code, ack) => {
    try {
      const acc = ACCOUNTS[activeAccountId];
      await acc.client.invoke({ _: 'checkAuthenticationCode', code });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit('error', err.message);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // 2단계 비밀번호 (활성 계정 대상, ack 콜백 옵셔널)
  socket.on('sendPassword', async (password, ack) => {
    try {
      const acc = ACCOUNTS[activeAccountId];
      await acc.client.invoke({ _: 'checkAuthenticationPassword', password });
      if (typeof ack === 'function') ack({ ok: true });
    } catch (err) {
      socket.emit('error', err.message);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  // v0.11: 계정 목록 조회
  socket.on('getAccounts', (ack) => {
    const list = Object.values(ACCOUNTS).map(a => ({
      id: a.id,
      label: a.label,
      initialized: a.initialized,
      isAuthorized: a.isAuthorized,
      authState: a.authState?._ || null,
      active: a.id === activeAccountId,
    }));
    if (typeof ack === 'function') ack({ accounts: list, activeAccountId });
    else socket.emit('accounts', { accounts: list, activeAccountId });
  });

  // v0.16(v2): 현재 인증된 본인 user 정보 조회 (v2 client 의 currentUserId 매핑용)
  // v2 의 selectIsChatWithSelf 는 chatId === global.currentUserId 비교를 하는데
  // v2 backend(TDLib socket) 가 init 흐름에서 updateCurrentUser 를 emit 하지 않으면
  // 자기 자신과의 채팅이 본명으로 표시되고 Saved Messages 아이콘이 사라진다.
  socket.on('getCurrentUser', async (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      const acc = ACCOUNTS[activeAccountId];
      if (!acc || !acc.client) {
        if (ack) ack({ ok: false, error: 'active account not ready' });
        return;
      }
      // myUserId 캐시 활용, 없으면 getMe 1회
      if (!acc.myUserId) {
        try {
          const me = await acc.client.invoke({ _: 'getMe' });
          acc.myUserId = me?.id || null;
        } catch (e) {
          if (ack) ack({ ok: false, error: `getMe 실패: ${e.message}` });
          return;
        }
      }
      const me = await acc.client.invoke({ _: 'getUser', user_id: acc.myUserId });
      if (!me) {
        if (ack) ack({ ok: false, error: 'getUser(me) returned empty' });
        return;
      }
      // v0.28: self profile photo 메타 — avatarPhotoId 는 remote.id(영문자) 로 통일, _avatarFileIdCache 키도 동일
      let selfAvatarPhotoId;
      const selfSmall = me.profile_photo?.small;
      const selfSmallRemoteId = selfSmall?.remote?.id;
      const selfSmallFileId = selfSmall?.id;
      if (selfSmallRemoteId && selfSmallFileId) {
        selfAvatarPhotoId = String(selfSmallRemoteId);
        global._avatarFileIdCache.set(selfAvatarPhotoId, { fileId: selfSmallFileId, accountId: activeAccountId });
      }
      const payload = {
        ok: true,
        user: {
          id: String(me.id),
          firstName: me.first_name || '',
          lastName: me.last_name || '',
          phoneNumber: me.phone_number || '',
          username: me.usernames?.active_usernames?.[0] || me.username || '',
          isVerified: !!me.is_verified,
          isPremium: !!me.is_premium,
          // v0.55: getCanAddContact 가 !user.isSelf 체크 — 본인은 "사용자 추가" 미표시 보장.
          isSelf: true,
          avatarPhotoId: selfAvatarPhotoId,
          hasVideoAvatar: !!me.profile_photo?.has_animation,
        },
      };
      if (ack) ack(payload);
    } catch (err) {
      console.error('[getCurrentUser] error:', err.message);
      if (ack) ack({ ok: false, error: err.message });
    }
  });

  // v0.11: 활성 계정 전환 (부계정은 최초 전환 시 lazy 초기화)
  socket.on('switchAccount', async ({ account } = {}, ack) => {
    try {
      if (!ACCOUNTS[account]) throw new Error(`알 수 없는 계정: ${account}`);
      if (!ACCOUNTS[account].initialized) {
        await initAccount(account);
      }
      activeAccountId = account;
      refreshActiveAliases();
      const a = ACCOUNTS[account];
      // 현재 authState 가 있으면 클라이언트에 즉시 통보
      if (a.authState) {
        io.emit('authState', { state: a.authState._, account });
        if (a.isAuthorized) io.emit('authorized', { account });
      }
      io.emit('accountSwitched', { account, label: a.label });
      if (typeof ack === 'function') ack({ ok: true, account });
    } catch (err) {
      console.error('[switchAccount] error:', err.message);
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
      socket.emit('error', err.message);
    }
  });

  // 채팅 목록 조회 (v2: ack callback 지원)
  socket.on('getChats', async (...args) => {
    const ackCallback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    try {
      // v0.13: myUserId 미설정 시 lazy getMe 1회 호출 (reload 후 authState 재발생 안 하는 경우 대비)
      const acc = ACCOUNTS[activeAccountId];
      if (acc && !acc.myUserId) {
        try {
          const me = await client.invoke({ _: 'getMe' });
          acc.myUserId = me?.id || null;
          console.log(`[${activeAccountId}] myUserId = ${acc.myUserId} (lazy via getChats)`);
        } catch (e) {
          console.error(`[${activeAccountId}] lazy getMe 실패:`, e.message);
        }
      }

      const chats = await client.invoke({
        _: 'getChats',
        chat_list: { _: 'chatListMain' },
        limit: 50
      });
      
      // 각 채팅의 상세 정보 조회 (v0.6: 온라인 상태/멤버 수 포함)
      const chatDetails = [];
      for (const chatId of chats.chat_ids) {
        const chat = await client.invoke({ _: 'getChat', chat_id: chatId });
        
        // v0.6: 추가 정보
        chat._isOnline = false;
        chat._statusText = '';
        chat._memberCount = 0;
        
        // 1:1 채팅 (Private)
        if (chat.type?._ === 'chatTypePrivate') {
          try {
            const user = await client.invoke({ _: 'getUser', user_id: chat.type.user_id });
            chat._user = user; // v2 fetchChats 가 ApiUser(usernames/type) 빌드에 사용 (봇/개인 DM @username 표시)
            if (user.status?._ === 'userStatusOnline') {
              chat._isOnline = true;
              chat._statusText = '온라인';
            } else if (user.status?._ === 'userStatusRecently') {
              chat._statusText = '최근 접속';
            } else if (user.status?.was_online) {
              const lastSeen = new Date(user.status.was_online * 1000);
              chat._statusText = formatLastSeen(lastSeen);
            }
          } catch (e) {}
        }
        // 그룹 채팅
        else if (chat.type?._ === 'chatTypeBasicGroup') {
          try {
            const group = await client.invoke({ _: 'getBasicGroup', basic_group_id: chat.type.basic_group_id });
            chat._memberCount = group.member_count || 0;
            chat._statusText = `참가자 ${chat._memberCount}명`;
          } catch (e) {}
        }
        // 슈퍼그룹/채널
        else if (chat.type?._ === 'chatTypeSupergroup') {
          try {
            const supergroup = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id });
            chat._memberCount = supergroup.member_count || 0;
            chat._statusText = supergroup.is_channel ? `구독자 ${chat._memberCount}명` : `참가자 ${chat._memberCount}명`;
          } catch (e) {}
        }
        
        // v0.28: 안읽은 수만 유지. _avatarData(v1 base64 inline) 는 v2 가 소비하지 않아 제거 —
        // getChats 매 호출마다 downloadFile 동기 호출이 발생하던 비용 제거.
        chat._unreadCount = chat.unread_count || 0;

        // v0.15: 정렬용 메타 — chatListMain 위치 (BigInt order, is_pinned)
        const mainPos = (chat.positions || []).find(p => p.list?._ === 'chatListMain');
        chat._order = mainPos?.order || '0';
        chat._isPinned = !!mainPos?.is_pinned;

        // v0.13: Saved Messages(저장된 메시지) 표시 메타 부여
        annotateSavedMessages(chat);

        chatDetails.push(chat);
      }
      
      if (ackCallback) ackCallback(chatDetails);
      socket.emit('chats', chatDetails);
    } catch (err) {
      if (ackCallback) ackCallback([]);
      socket.emit('error', err.message);
    }
  });
  
  // v0.6: 마지막 접속 시간 포맷
  function formatLastSeen(date) {
    const now = new Date();
    const diff = now - date;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (mins < 1) return '방금 전까지 접속함';
    if (mins < 60) return `${mins}분 전까지 접속함`;
    if (hours < 24) return `${hours}시간 전까지 접속함`;
    if (days < 7) return `${days}일 전까지 접속함`;
    return `${date.getMonth() + 1}/${date.getDate()}에 접속함`;
  }

  // 메시지 조회 (인피니티 스크롤 지원)
  // 읽음 처리 (viewMessages)
  socket.on('markRead', async (...markReadArgs) => {
    const markReadAck = typeof markReadArgs[markReadArgs.length - 1] === 'function' ? markReadArgs[markReadArgs.length - 1] : null;
    const { chatId, messageIds } = markReadArgs[0] || {};
    try {
      if (!chatId || !messageIds || messageIds.length === 0) { if (markReadAck) markReadAck(); return; }
      const maxId = messageIds.reduce((a, b) => (a > b ? a : b), 0);
      await client.invoke({
        _: 'viewMessages',
        chat_id: chatId,
        message_ids: messageIds,
        force_read: true
      });
      console.log(`[v0.20 markRead] chatId=${chatId}, count=${messageIds.length}, max=${maxId}`);
      if (markReadAck) markReadAck();
    } catch (err) {
      console.error('[v0.20 markRead] error:', err.message);
      if (markReadAck) markReadAck();
    }
  });

  socket.on('getMessages', async (...getMessagesArgs) => {
    const getMessagesAck = typeof getMessagesArgs[getMessagesArgs.length - 1] === 'function' ? getMessagesArgs[getMessagesArgs.length - 1] : null;
    const { chatId, limit = 30, fromMessageId = 0, isHistory = false } = getMessagesArgs[0] || {};
    try {
      // 처음 로드 시에만 채팅 열기
      if (fromMessageId === 0) {
        await client.invoke({ _: 'openChat', chat_id: chatId });
        await new Promise(r => setTimeout(r, 300));  // TDLib 캐시 동기화 대기
      }
      
      let messages = await client.invoke({
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: limit
      });
      
      // TDLib이 가끔 적게 반환하면 재시도
      if (fromMessageId === 0 && messages.messages?.length < 5 && messages.messages?.length > 0) {
        await new Promise(r => setTimeout(r, 200));
        messages = await client.invoke({
          _: 'getChatHistory',
          chat_id: chatId,
          from_message_id: fromMessageId,
          offset: 0,
          limit: limit
        });
      }
      
      console.log(`getMessages: chatId=${chatId}, fromId=${fromMessageId}, count=${messages.messages?.length || 0}`);
      // Entity debug: log first message with entities
      const entityMsg = messages.messages?.find(m => m.content?.text?.entities?.length > 0);
      if (!messages.messages || messages.messages.length === 0) {
        socket.emit('messages', { chatId, messages: [], isHistory });
        return;
      }
      
      // v0.8: 채팅 타입 확인 (그룹인지)
      let chatType = 'private';
      try {
        const chat = await client.invoke({ _: 'getChat', chat_id: chatId });
        if (chat.type?._ === 'chatTypeBasicGroup') chatType = 'basicGroup';
        else if (chat.type?._ === 'chatTypeSupergroup') {
          const sg = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id });
          chatType = sg.is_channel ? 'channel' : 'supergroup';
        }
      } catch (e) {}
      
      // v0.8: 그룹이면 발신자 이름 조회 (user 캐시)
      const userCache = {};
      const isGroupChat = chatType === 'basicGroup' || chatType === 'supergroup';
      
      // v0.3: 답장 원본 메시지 조회 + v0.8: 발신자 이름
      for (const msg of messages.messages) {
        // v0.56: messageRichMessage 평탄화 (히스토리 로드 경로 getMessages)
        try { await maybeFlattenRich(msg, client); } catch (e) { console.error('[getMessages] richMessage flatten error:', e.message); }
        // v0.9: 전달 메시지 정보
        if (msg.forward_info) {
          console.log('Forward info:', msg.id, JSON.stringify(msg.forward_info).substring(0, 200));
          const origin = msg.forward_info.origin;
          if (origin) {
            if (origin.sender_name) {
              msg._forwardFrom = origin.sender_name;
            } else if (origin.sender_user_id) {
              try {
                const fwdUser = await client.invoke({ _: 'getUser', user_id: origin.sender_user_id });
                msg._forwardFrom = fwdUser.first_name + (fwdUser.last_name ? ' ' + fwdUser.last_name : '');
              } catch (e) { msg._forwardFrom = '사용자'; }
            } else if (origin.chat_id || origin.sender_chat_id) {
              try {
                const fwdChat = await client.invoke({ _: 'getChat', chat_id: origin.chat_id || origin.sender_chat_id });
                msg._forwardFrom = fwdChat.title || '채팅';
              } catch (e) { msg._forwardFrom = '채팅'; }
            }
          }
        }

        // v0.8: 발신자 이름 (그룹 채팅용)
        if (isGroupChat && !msg.is_outgoing && msg.sender_id?.user_id) {
          const userId = msg.sender_id.user_id;
          if (!userCache[userId]) {
            try {
              const user = await client.invoke({ _: 'getUser', user_id: userId });
              userCache[userId] = user.first_name + (user.last_name ? ' ' + user.last_name : '');
            } catch (e) { userCache[userId] = '사용자'; }
          }
          msg._senderName = userCache[userId];
          msg._senderId = userId;
        }
        
        // TDLib reply_to 구조 확인
        const replyToMsgId = msg.reply_to?.message_id || msg.reply_to_message_id || msg.reply_in_chat_id;
        if (replyToMsgId) {
          console.log('Reply found:', msg.id, '->', replyToMsgId, 'reply_to:', JSON.stringify(msg.reply_to || {}));
          try {
            const replyMsg = await client.invoke({
              _: 'getMessage',
              chat_id: chatId,
              message_id: replyToMsgId
            });
            if (replyMsg) {
              // v0.8: 답장 발신자 이름도 조회
              let replySenderName = replyMsg.is_outgoing ? '나' : '상대방';
              if (isGroupChat && !replyMsg.is_outgoing && replyMsg.sender_id?.user_id) {
                const replyUserId = replyMsg.sender_id.user_id;
                if (!userCache[replyUserId]) {
                  try {
                    const user = await client.invoke({ _: 'getUser', user_id: replyUserId });
                    userCache[replyUserId] = user.first_name + (user.last_name ? ' ' + user.last_name : '');
                  } catch (e) { userCache[replyUserId] = '사용자'; }
                }
                replySenderName = userCache[replyUserId];
              }
              msg._replyTo = {
                id: replyMsg.id,
                senderName: replySenderName,
                text: replyMsg.content?.text?.text || replyMsg.content?.caption?.text || '[미디어]',
                isOutgoing: replyMsg.is_outgoing
              };
              console.log('Reply loaded:', msg._replyTo);
            }
          } catch (e) { 
            console.error('Reply load error:', e.message);
          }
        }
      }
      
      // 먼저 텍스트만 보내기 (빠른 응답) - v0.8: chatType 추가
      // 디버그: reply 포함 여부 확인
      const repliedMsgs = messages.messages.filter(m => m._replyTo);
      if (repliedMsgs.length > 0) {
        repliedMsgs.forEach(m => console.log('[Emit check]', m.id, '_replyTo:', m._replyTo ? `text="${(m._replyTo.text||'').substring(0,40)}"` : 'MISSING'));
      }
      if (getMessagesAck) getMessagesAck(messages.messages || []);
      socket.emit('messages', { chatId, messages: messages.messages, isHistory, chatType });
      
      // v0.6: 채팅 정보에서 읽음 상태 가져오기 (비동기)
      client.invoke({ _: 'getChat', chat_id: chatId }).then(chat => {
        if (chat.last_read_outbox_message_id) {
          socket.emit('chatInfo', { chatId, lastReadOutbox: chat.last_read_outbox_message_id });
        }
      }).catch(() => {});
      
      // 이미지가 있는 메시지만 처리
      const photoMessages = messages.messages.filter(m => m.content?._ === 'messagePhoto');
      if (photoMessages.length === 0) return;
      
      // 이미지 다운로드 후 업데이트
      for (const msg of photoMessages) {
        const sizes = msg.content.photo?.sizes || [];
        const smallSize = sizes.find(s => s.type === 's') || sizes[0];
        if (smallSize?.photo?.id) {
          try {
            const file = await client.invoke({
              _: 'downloadFile',
              file_id: smallSize.photo.id,
              priority: 1,
              synchronous: true
            });
            if (file.local?.path) {
              const fs = require('fs');
              const data = fs.readFileSync(file.local.path);
              msg._imageData = 'data:image/jpeg;base64,' + data.toString('base64');
            }
          } catch (e) { console.error('Image download error:', e.message); }
        }
      }
      
      // 이미지 포함해서 다시 보내기
      socket.emit('messages', { chatId, messages: messages.messages, isHistory });
      
    } catch (err) {
      console.error('getMessages error:', err.message);
      if (getMessagesAck) getMessagesAck([]);
      socket.emit('error', err.message);
    }
  });

  // v1.1: 특정 메시지 주변 로드 (답장 원글 이동용)
  socket.on('getMessagesAround', async ({ chatId, messageId, limit = 20 }) => {
    try {
      console.log(`getMessagesAround: chatId=${chatId}, messageId=${messageId}, limit=${limit}`);
      
      // 해당 메시지 존재 확인
      let targetMsg;
      try {
        targetMsg = await client.invoke({ _: 'getMessage', chat_id: chatId, message_id: messageId });
      } catch (e) {
        console.error('Target message not found:', e.message);
        socket.emit('messagesAround', { chatId, messages: [], targetMessageId: messageId, error: 'not_found' });
        return;
      }
      
      // 해당 메시지 이후(아래) 메시지 가져오기: offset을 음수로 설정
      const halfLimit = Math.floor(limit / 2);
      const messages = await client.invoke({
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: messageId,
        offset: -halfLimit,
        limit: limit
      });
      
      if (!messages.messages || messages.messages.length === 0) {
        socket.emit('messagesAround', { chatId, messages: [], targetMessageId: messageId });
        return;
      }
      
      // 채팅 타입 확인
      let chatType = 'private';
      try {
        const chat = await client.invoke({ _: 'getChat', chat_id: chatId });
        if (chat.type?._ === 'chatTypeBasicGroup') chatType = 'basicGroup';
        else if (chat.type?._ === 'chatTypeSupergroup') {
          const sg = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id });
          chatType = sg.is_channel ? 'channel' : 'supergroup';
        }
      } catch (e) {}
      
      const isGroupChat = chatType === 'basicGroup' || chatType === 'supergroup';
      const userCache = {};
      
      // 발신자 이름 + 답장 정보 로드
      for (const msg of messages.messages) {
        if (isGroupChat && !msg.is_outgoing && msg.sender_id?.user_id) {
          const userId = msg.sender_id.user_id;
          if (!userCache[userId]) {
            try {
              const user = await client.invoke({ _: 'getUser', user_id: userId });
              userCache[userId] = user.first_name + (user.last_name ? ' ' + user.last_name : '');
            } catch (e) { userCache[userId] = '사용자'; }
          }
          msg._senderName = userCache[userId];
          msg._senderId = userId;
        }
        
        const replyToMsgId = msg.reply_to?.message_id || msg.reply_to_message_id;
        if (replyToMsgId) {
          try {
            const replyMsg = await client.invoke({ _: 'getMessage', chat_id: chatId, message_id: replyToMsgId });
            if (replyMsg) {
              let replySenderName = replyMsg.is_outgoing ? '나' : '상대방';
              if (isGroupChat && !replyMsg.is_outgoing && replyMsg.sender_id?.user_id) {
                const uid = replyMsg.sender_id.user_id;
                if (!userCache[uid]) {
                  try {
                    const u = await client.invoke({ _: 'getUser', user_id: uid });
                    userCache[uid] = u.first_name + (u.last_name ? ' ' + u.last_name : '');
                  } catch (e) { userCache[uid] = '사용자'; }
                }
                replySenderName = userCache[uid];
              }
              msg._replyTo = { id: replyMsg.id, senderName: replySenderName, text: replyMsg.content?.text?.text || replyMsg.content?.caption?.text || '[미디어]', isOutgoing: replyMsg.is_outgoing };
            }
          } catch (e) {}
        }
      }
      
      socket.emit('messagesAround', { chatId, messages: messages.messages, targetMessageId: messageId, chatType });
      
      // 이미지 처리
      const photoMessages = messages.messages.filter(m => m.content?._ === 'messagePhoto');
      for (const msg of photoMessages) {
        const sizes = msg.content.photo?.sizes || [];
        const smallSize = sizes.find(s => s.type === 's') || sizes[0];
        if (smallSize?.photo?.id) {
          try {
            const file = await client.invoke({ _: 'downloadFile', file_id: smallSize.photo.id, priority: 1, synchronous: true });
            if (file.local?.path) {
              const fs = require('fs');
              const data = fs.readFileSync(file.local.path);
              msg._imageData = 'data:image/jpeg;base64,' + data.toString('base64');
            }
          } catch (e) {}
        }
      }
      if (photoMessages.length > 0) {
        socket.emit('messagesAround', { chatId, messages: messages.messages, targetMessageId: messageId, chatType });
      }
      
    } catch (err) {
      console.error('getMessagesAround error:', err.message);
      socket.emit('messagesAround', { chatId, messages: [], targetMessageId: messageId, error: err.message });
    }
  });

  // 메시지 전송 (v0.3: 답장 지원, v1.4: optimistic rendering)
  socket.on('sendMessage', async (...sendMsgArgs) => {
    const sendMsgAck = typeof sendMsgArgs[sendMsgArgs.length - 1] === 'function' ? sendMsgArgs[sendMsgArgs.length - 1] : null;
    const { chatId, text, replyToMessageId, tempId } = sendMsgArgs[0] || {};
    try {
      const params = {
        _: 'sendMessage',
        chat_id: chatId,
        input_message_content: {
          _: 'inputMessageText',
          text: { _: 'formattedText', text }
        }
      };

      // v0.3: 답장인 경우
      if (replyToMessageId) {
        params.reply_to = {
          _: 'inputMessageReplyToMessage',
          message_id: replyToMessageId
        };
      }

      const result = await client.invoke(params);

      // v1.4: tempId 매핑 저장 (optimistic rendering용)
      if (tempId && result?.id) {
        tempIdMap.set(result.id, { chatId, tempId });
        console.log(`[sendMessage] tempId 매핑: ${result.id} -> ${tempId}`);
      }

      if (sendMsgAck) sendMsgAck(result);
    } catch (err) {
      if (sendMsgAck) sendMsgAck(undefined);
      socket.emit('error', err.message);
    }
  });

  // 이미지 전송 (v0.3: 답장 지원, v1.4: optimistic rendering)
  socket.on('sendImage', async ({ chatId, imageData, caption, replyToMessageId, tempId }) => {
    try {
      // base64 데이터에서 실제 데이터 추출
      const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!matches) {
        socket.emit('error', '잘못된 이미지 형식입니다');
        return;
      }

      const ext = matches[1];
      const base64Data = matches[2];
      const buffer = Buffer.from(base64Data, 'base64');

      // 임시 파일로 저장
      const fs = require('fs');
      const tempPath = path.join(__dirname, 'tdlib-files', `temp_${Date.now()}.${ext}`);
      fs.writeFileSync(tempPath, buffer);

      // 이미지 전송
      const params = {
        _: 'sendMessage',
        chat_id: chatId,
        input_message_content: {
          _: 'inputMessagePhoto',
          photo: { _: 'inputFileLocal', path: tempPath },
          caption: caption ? { _: 'formattedText', text: caption } : null
        }
      };

      // v0.3: 답장인 경우
      if (replyToMessageId) {
        params.reply_to = {
          _: 'inputMessageReplyToMessage',
          message_id: replyToMessageId
        };
      }

      const result = await client.invoke(params);

      // v1.4: tempId 매핑 저장
      if (tempId && result?.id) {
        tempIdMap.set(result.id, { chatId, tempId });
        console.log(`[sendImage] tempId 매핑: ${result.id} -> ${tempId}`);
      }

      // 임시 파일 및 디렉토리 삭제 (약간의 지연 후)
      setTimeout(() => {
        try {
          fs.unlinkSync(tempPath);
        } catch (e) {}
      }, 5000);

    } catch (err) {
      socket.emit('error', err.message);
    }
  });
  
  // v0.3: 메시지 삭제
  socket.on('deleteMessage', async ({ chatId, messageId }) => {
    try {
      await client.invoke({
        _: 'deleteMessages',
        chat_id: chatId,
        message_ids: [messageId],
        revoke: true  // 모두에게 삭제
      });
      // 삭제 완료 알림 → 클라이언트가 목록 새로고침
      socket.emit('messageDeleted', { chatId, messageId });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });
  
  // v0.4: 파일 전송 (v1.4: optimistic rendering)
  socket.on('sendFile', async ({ chatId, fileData, fileName, mimeType, caption, replyToMessageId, tempId }) => {
    try {
      // base64 데이터에서 실제 데이터 추출
      const matches = fileData.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        socket.emit('error', '잘못된 파일 형식입니다');
        return;
      }

      const base64Data = matches[2];
      const buffer = Buffer.from(base64Data, 'base64');

      // 임시 디렉토리에 원본 파일명으로 저장
      const fs = require('fs');
      const tempDir = path.join(__dirname, 'tdlib-files', `upload_${Date.now()}`);
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, fileName);
      fs.writeFileSync(tempPath, buffer);

      // 파일 전송 (원본 파일명 유지)
      const params = {
        _: 'sendMessage',
        chat_id: chatId,
        input_message_content: {
          _: 'inputMessageDocument',
          document: { _: 'inputDocument', document: { _: 'inputFileLocal', path: tempPath } }
        }
      };

      // 캡션 추가
      if (caption) {
        params.input_message_content.caption = { _: 'formattedText', text: caption };
      }

      if (replyToMessageId) {
        params.reply_to = {
          _: 'inputMessageReplyToMessage',
          message_id: replyToMessageId
        };
      }

      const result = await client.invoke(params);

      // v1.4: tempId 매핑 저장
      if (tempId && result?.id) {
        tempIdMap.set(result.id, { chatId, tempId });
        console.log(`[sendFile] tempId 매핑: ${result.id} -> ${tempId}`);
      }

      // 임시 파일 삭제 (약간의 지연 후)
      setTimeout(() => {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }, 5000);

    } catch (err) {
      socket.emit('error', err.message);
    }
  });
  
  // v1.0: 채팅 멤버 검색 (멘션 자동완성용)
  socket.on('searchMembers', async ({ chatId, query }) => {
    console.log(`[searchMembers] chatId=${chatId} query="${query}"`);
    try {
      if (!chatId) return;
      const chat = await client.invoke({ _: 'getChat', chat_id: chatId });
      let members = [];
      
      if (chat.type?._ === 'chatTypeSupergroup') {
        const result = await client.invoke({
          _: 'getSupergroupMembers',
          supergroup_id: chat.type.supergroup_id,
          filter: query 
            ? { _: 'supergroupMembersFilterSearch', query }
            : { _: 'supergroupMembersFilterRecent' },
          offset: 0,
          limit: 20
        });
        for (const m of (result.members || [])) {
          try {
            const user = await client.invoke({ _: 'getUser', user_id: m.user_id });
            members.push({
              userId: user.id,
              name: user.first_name + (user.last_name ? ' ' + user.last_name : ''),
              username: user.usernames?.active_usernames?.[0] || user.username || ''
            });
          } catch(e) {}
        }
      } else if (chat.type?._ === 'chatTypeBasicGroup') {
        const result = await client.invoke({
          _: 'getBasicGroupFullInfo',
          basic_group_id: chat.type.basic_group_id
        });
        for (const m of (result.members || [])) {
          try {
            const user = await client.invoke({ _: 'getUser', user_id: m.user_id });
            const name = user.first_name + (user.last_name ? ' ' + user.last_name : '');
            const username = user.usernames?.active_usernames?.[0] || user.username || '';
            if (!query || name.toLowerCase().includes(query.toLowerCase()) || username.toLowerCase().includes(query.toLowerCase())) {
              members.push({ userId: user.id, name, username });
            }
          } catch(e) {}
        }
      } else if (chat.type?._ === 'chatTypePrivate') {
        // 1:1 DM — 상대방만
        try {
          const user = await client.invoke({ _: 'getUser', user_id: chat.type.user_id });
          members.push({
            userId: user.id,
            name: user.first_name + (user.last_name ? ' ' + user.last_name : ''),
            username: user.usernames?.active_usernames?.[0] || user.username || ''
          });
        } catch(e) {}
      }
      
      socket.emit('members', { chatId, members });
    } catch (e) {
      console.error('searchMembers error:', e.message);
      socket.emit('members', { chatId, members: [] });
    }
  });

  // v0.28: 프로필 아바타 다운로드 (v2 downloadMedia avatar/profile 분기용 보조 채널)
  // - avatarPhotoId = remote.id(영문자). cache miss 시 getRemoteFile 로 결정적 해석.
  socket.on('loadProfilePhoto', async ({ avatarPhotoId } = {}, ack) => {
    try {
      if (!avatarPhotoId) {
        if (ack) ack({ ok: false, error: 'missing-photoId' });
        return;
      }
      const resolved = await resolveAvatarEntry(avatarPhotoId, activeAccountId);
      if (!resolved?.entry) {
        console.log('[loadProfilePhoto] FAIL photoId=' + avatarPhotoId + ' reason=unresolved');
        if (ack) ack({ ok: false, error: 'unresolved' });
        return;
      }
      const { entry, via } = resolved;
      const acc = ACCOUNTS[entry.accountId];
      if (!acc?.client) {
        if (ack) ack({ ok: false, error: 'account-down' });
        return;
      }
      const file = await acc.client.invoke({ _: 'downloadFile', file_id: entry.fileId, priority: 1, synchronous: true });
      if (!file.local?.path) {
        console.log('[loadProfilePhoto] FAIL photoId=' + avatarPhotoId + ' via=' + via + ' reason=no-path');
        if (ack) ack({ ok: false, error: 'no-path' });
        return;
      }
      const fs = require('fs');
      const data = fs.readFileSync(file.local.path);
      console.log('[loadProfilePhoto] OK photoId=' + avatarPhotoId + ' via=' + via + ' bytes=' + data.length);
      if (ack) ack({ ok: true, base64: data.toString('base64'), mimeType: 'image/jpeg' });
    } catch (e) {
      console.error('[loadProfilePhoto] error:', e?.message || e);
      if (ack) ack({ ok: false, error: String(e?.message || e) });
    }
  });

  // v1.0: 원본 이미지 다운로드 (이미지 뷰어용)
  socket.on('getFullImage', async ({ messageId, chatId }) => {
    try {
      if (!messageId || !chatId) return;
      const msg = await client.invoke({ _: 'getMessage', chat_id: chatId, message_id: messageId });
      if (msg.content?._ !== 'messagePhoto') return;
      
      const sizes = msg.content.photo?.sizes || [];
      // 가장 큰 사이즈 선택 (x > m > s)
      const bestSize = sizes[sizes.length - 1];
      if (!bestSize?.photo?.id) return;
      
      const file = await client.invoke({
        _: 'downloadFile',
        file_id: bestSize.photo.id,
        priority: 1,
        synchronous: true
      });
      
      if (file.local?.path) {
        const fs = require('fs');
        const data = fs.readFileSync(file.local.path);
        const base64 = 'data:image/jpeg;base64,' + data.toString('base64');
        socket.emit('fullImage', { messageId, imageData: base64 });
      }
    } catch (e) {
      console.error('getFullImage error:', e.message);
    }
  });

  // v0.4: 파일 다운로드
  socket.on('downloadFile', async ({ messageId, fileId, fileName }) => {
    try {
      console.log('Download request:', fileId, 'fileName:', fileName);
      const file = await client.invoke({
        _: 'downloadFile',
        file_id: fileId,
        priority: 1,
        synchronous: true
      });
      
      if (file.local?.path) {
        const fs = require('fs');
        const data = fs.readFileSync(file.local.path);
        const base64 = data.toString('base64');
        const mimeType = getMimeType(fileName);
        // 원본 파일명 사용
        socket.emit('fileDownloaded', { 
          fileName: fileName,  // 클라이언트에서 전달받은 원본 파일명
          data: `data:${mimeType};base64,${base64}` 
        });
        console.log('File sent:', fileName);
      }
    } catch (err) {
      console.error('Download error:', err.message);
      socket.emit('error', '파일 다운로드 실패: ' + err.message);
    }
  });

  // v0.5: 메시지 전달
  socket.on('forwardMessage', async ({ fromChatId, messageId, toChatId }) => {
    try {
      await client.invoke({
        _: 'forwardMessages',
        chat_id: toChatId,
        from_chat_id: fromChatId,
        message_ids: [messageId],
        send_copy: false,
        remove_caption: false
      });
      socket.emit('forwarded', { success: true });
    } catch (err) {
      socket.emit('error', '전달 실패: ' + err.message);
    }
  });
  
  // v0.5: 메시지 편집
  socket.on('editMessageText', async ({ chatId, messageId, text }) => {
    try {
      await client.invoke({
        _: 'editMessageText',
        chat_id: chatId,
        message_id: messageId,
        input_message_content: {
          _: 'inputMessageText',
          text: { _: 'formattedText', text: text }
        }
      });
      // 메시지 목록 갱신을 위해 업데이트 이벤트 발생
      socket.emit('messageEdited', { chatId, messageId, text });
    } catch (err) {
      socket.emit('error', '편집 실패: ' + err.message);
    }
  });

  // ========== API Request Handler (for telegram-web-v2) ==========
  socket.on('api:request', async ({ id, method, params }) => {
    try {
      let result;
      switch (method) {
        case 'saveDraft': {
          const chatId = params?.chatId ?? params?.chat?.id;
          const text = (params?.text ?? '').toString();
          const entities = params?.entities || [];
          const replyToMessageId = params?.replyToMessageId;
          const hasText = text.trim().length > 0;
          if (!hasText) {
            // 안전장치: 빈 draft 저장은 무력화 — 타 클라이언트 draft 보호 (스퓨리어스 빈 saveDraft가 원격 draft 삭제하던 회귀 차단)
            console.log('[saveDraft] chatId:', chatId, 'EMPTY → no-op (draft 보호)');
            result = { ok: true, skipped: 'empty' };
            break;
          }
          await client.invoke({
            '@type': 'setChatDraftMessage',
            chat_id: Number(chatId),
            message_thread_id: 0,
            draft_message: {
              '@type': 'draftMessage',
              ...(replyToMessageId ? { reply_to: { '@type': 'inputMessageReplyToMessage', message_id: replyToMessageId } } : {}),
              content: {
                '@type': 'draftMessageContentText',
                text: { '@type': 'formattedText', text, entities },
              },
            },
          });
          console.log('[saveDraft] chatId:', chatId, 'hasText: true ok');
          // TDLib does not echo updateChatDraftMessage for same-client changes — emit manually
          const ownDraftMsg = {
            text,
            entities,
            date: Math.floor(Date.now() / 1000),
            ...(replyToMessageId ? { replyToMessageId } : {}),
          };
          draftCache.set(String(chatId), ownDraftMsg);
          io.emit('chatDraft', { chatId: String(chatId), draftMessage: ownDraftMsg, account: activeAccountId });
          result = { ok: true };
          break;
        }
        case 'updateChatNotifySettings':
        case 'setChatNotificationSettings': {
          // v2(telegram-tt 포크)는 음소거를 callApi('updateChatNotifySettings', { chat, settings: { mutedUntil } }) 로 호출하고
          // 이 포크는 callApi 메서드명을 그대로 브리지로 포워딩하므로, telegram-tt 메서드명을 직접 처리한다.
          const nChatId = Number(params?.chatId ?? params?.chat?.id);
          if (!nChatId) { result = { ok: false, error: 'no chatId' }; break; }
          const mutedUntilRaw = (params?.mutedUntil !== undefined) ? params.mutedUntil : params?.settings?.mutedUntil;
          if (mutedUntilRaw === undefined) {
            // mutedUntil 없는 updateChatNotifySettings (예: silent posting 토글) — 음소거 무관, no-op
            result = { ok: true, skipped: 'no mutedUntil' };
            break;
          }
          const mutedUntil = Number(mutedUntilRaw) || 0;
          const now = Math.floor(Date.now() / 1000);
          const MAX_I32 = 2147483647;
          let muteFor;
          if (mutedUntil <= now) muteFor = 0;                 // 해제 (UNMUTE_TIMESTAMP=0 또는 과거 ts)
          else if (mutedUntil >= MAX_I32) muteFor = MAX_I32;  // 영구 (MUTE_INDEFINITE_TIMESTAMP)
          else muteFor = mutedUntil - now;                    // 시간별 음소거 (남은 초)
          // 기존 설정 보존(sound/preview 등) 위해 getChat 후 mute_for 만 덮어씀
          let ns;
          try {
            const chat = await client.invoke({ '@type': 'getChat', chat_id: nChatId });
            ns = (chat && chat.notification_settings) ? { ...chat.notification_settings } : {};
          } catch (e) { ns = {}; }
          ns['@type'] = 'chatNotificationSettings';
          ns.use_default_mute_for = false;
          ns.mute_for = muteFor;
          await client.invoke({ '@type': 'setChatNotificationSettings', chat_id: nChatId, notification_settings: ns });
          console.log('[setChatNotificationSettings] chatId:', nChatId, 'muteFor:', muteFor, 'mutedUntil:', mutedUntil);
          result = { ok: true, muteFor };
          break;
        }
        case 'fetchChats': {
          const isArchived = params && params.archived;
          const tdChatList = isArchived ? { '@type': 'chatListArchive' } : { '@type': 'chatListMain' };
          const chatList = await client.invoke({ '@type': 'getChats', chat_list: tdChatList, limit: (params && params.limit) || 50 });
          const chats = [];
          for (const chatId of (chatList.chat_ids || [])) {
            try {
              const chat = await client.invoke({ '@type': 'getChat', chat_id: chatId });
              chats.push(chat);
            } catch(e) { /* skip */ }
          }
          // Build chatIds as strings (telegram-tt expects string ids)
          const stringChatIds = (chatList.chat_ids || []).map(id => String(id));
          // Identify pinned chats (have is_pinned position in chatListMain)
          const targetListType = isArchived ? 'chatListArchive' : 'chatListMain';
          const pinnedChatIds = chats
            .filter(c => c.positions?.some(p => p.list?._ === targetListType && p.is_pinned))
            .map(c => String(c.id));
          console.log('[fetchChats]', isArchived ? 'ARCHIVED' : 'ACTIVE', 'total:', chats.length, 'pinned:', pinnedChatIds.length);
          // Convert chats to ApiChat format matching telegram-tt expectations
          // v0.55/v0.65: fetchChats/searchChats share one builder so type/status/avatar fields stay identical.
          const apiChats = await Promise.all(chats.map((c) => (
            buildApiChatWithStatus(client, c, { isArchived, activeAccountId })
          )));
          // Build lastMessageByChatId
          const lastMessageByChatId = {};
          const messages = [];
          chats.forEach(c => {
            if (c.last_message) {
              lastMessageByChatId[String(c.id)] = c.last_message.id;
              // v0.58 [039]: 채팅 목록 lastMessage 도 히스토리 경로(fetchMessages)와 동일하게
              // buildSharedApiMessage 로 빌드한다. 기존 인라인 빌더는 content.text 만 읽어
              // richMessage(content.message, 텍스트 없음)·미디어를 빈 콘텐츠로 만들었고, v2 가
              // 이를 MessageUnsupported 로 렌더했다. (Clear site data 직후 열려있지 않은 채팅의
              // 마지막 메시지가 "지원되지 않습니다" 로 보이던 근본 원인 — 빌더 불일치.)
              // buildSharedApiMessage 는 richMessage 평탄화(content._='messageText'+text)+
              // photo/sticker+미지원 action 폴백을 일괄 처리 → lastMessage 가 항상 히스토리와 일치.
              messages.push(buildSharedApiMessage(c.last_message, c.id));
            }
          });
          // v0.17: result.users — chatTypePrivate 채팅 user_id + self 모아 getUser batch
          // v0.65: searchChats 와 동일 user builder 공유(아바타 fileId 캐시/username shape 포함).
          const userIdSet = new Set();
          chats.forEach(c => {
            if (c.type?._ === 'chatTypePrivate' && c.type.user_id) userIdSet.add(c.type.user_id);
          });
          const myUserIdForUsers = ACCOUNTS[activeAccountId]?.myUserId;
          if (myUserIdForUsers) userIdSet.add(myUserIdForUsers);
          const apiUsers = [];
          await Promise.all(Array.from(userIdSet).map(async (uid) => {
            try {
              const u = await client.invoke({ _: 'getUser', user_id: uid });
              if (u) apiUsers.push(buildApiUserFromTdlibUser(u, activeAccountId));
            } catch (e) {
              console.error('[fetchChats] getUser failed for user_id', uid, ':', e.message);
            }
          }));
          result = {
            chatIds: stringChatIds,
            chats: apiChats,
            users: apiUsers,
            draftsById: {},
            replyingToById: {},
            orderedPinnedIds: pinnedChatIds,
            userStatusesById: {},
            notifyExceptionById: {},
            messages,
            lastMessageByChatId,
            totalChatCount: stringChatIds.length,
          };
          break;
        }
        case 'fetchMessages': {
          const chatId = (params && params.chat && params.chat.id) || (params && params.chatId);
          const numChatId = Number(chatId);
          const msgs = await client.invoke({
            '@type': 'getChatHistory',
            chat_id: numChatId,
            from_message_id: (params && params.offsetId) || 0,
            offset: (params && params.addOffset) || 0,
            limit: (params && params.limit) || 30,
            only_local: false
          });
          const apiMessages = [];
          for (const m of ((msgs && msgs.messages) || [])) {
            try { await maybeFlattenRich(m, client); }
            catch (e) { console.error('[fetchMessages] richMessage flatten error:', e.message); }
            const apiMsg = buildSharedApiMessage(m, numChatId);
            if (m.forward_info) {
              apiMsg.forward_info = m.forward_info;
              const origin = m.forward_info.origin;
              if (origin) {
                if (origin.sender_name) {
                  apiMsg._forwardFrom = origin.sender_name;
                } else if (origin.sender_user_id) {
                  try {
                    const fwdUser = await client.invoke({ '@type': 'getUser', user_id: origin.sender_user_id });
                    apiMsg._forwardFrom = fwdUser.first_name + (fwdUser.last_name ? ' ' + fwdUser.last_name : '');
                  } catch (e) { apiMsg._forwardFrom = '사용자'; }
                } else if (origin.chat_id || origin.sender_chat_id) {
                  try {
                    const fwdChat = await client.invoke({ '@type': 'getChat', chat_id: origin.chat_id || origin.sender_chat_id });
                    apiMsg._forwardFrom = fwdChat.title || '채팅';
                  } catch (e) { apiMsg._forwardFrom = '채팅'; }
                }
              }
            }
            apiMessages.push(apiMsg);
          }
          result = { messages: apiMessages, users: [], chats: [], totalCount: (msgs && msgs.total_count) || apiMessages.length };
          break;
        }
        case 'fetchCurrentUser': {
          const me = await client.invoke({ '@type': 'getMe' });
          result = me;
          break;
        }
        case 'sendMessage': {
          const sChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
          console.log('[api:request] sendMessage to chat:', sChatId, 'text:', (params?.text || '').substring(0, 50));
          const sent = await client.invoke({
            '@type': 'sendMessage',
            chat_id: sChatId,
            reply_to: (params && params.replyInfo) ? { '@type': 'inputMessageReplyToMessage', message_id: params.replyInfo.replyToMsgId } : undefined,
            input_message_content: {
              '@type': 'inputMessageText',
              text: { '@type': 'formattedText', text: (params && params.text) || '' }
            }
          });
          result = sent;
          break;
        }
        case 'editMessage': {
          const eChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
          const eMessageId = Number((params && params.message && params.message.id) || (params && params.messageId));
          const eText = (params && params.text) || '';
          console.log('[api:request] editMessage chat:', eChatId, 'msg:', eMessageId, 'text:', eText.substring(0, 50));
          const edited = await client.invoke({
            '@type': 'editMessageText',
            chat_id: eChatId,
            message_id: eMessageId,
            input_message_content: {
              '@type': 'inputMessageText',
              text: { '@type': 'formattedText', text: eText }
            }
          });
          socket.emit('messageEdited', { chatId: eChatId, messageId: eMessageId, text: eText });
          result = edited;
          break;
        }
        case 'deleteMessages': {
          const dChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
          const dMessageIds = (params && params.messageIds) || [];
          const dRevoke = !!(params && (params.shouldDeleteForAll !== undefined ? params.shouldDeleteForAll : params.revoke));
          if (!dChatId || !dMessageIds.length) { result = { ok: false, error: 'no chatId or messageIds' }; break; }
          console.log('[api:request] deleteMessages chat:', dChatId, 'ids:', dMessageIds, 'revoke:', dRevoke);
          await client.invoke({
            _: 'deleteMessages',
            chat_id: dChatId,
            message_ids: dMessageIds,
            revoke: dRevoke,
          });
          result = { ok: true };
          break;
        }
        case 'forwardMessages': {
          try {
            const fromChatId = Number(params?.fromChat?.id);
            const toChatId   = Number(params?.toChat?.id);
            const ids = (params?.messages || []).map(m => Number(m.id)).filter(Boolean);
            if (!fromChatId || !toChatId || !ids.length) { result = null; break; }
            ids.sort((a, b) => a - b); // TDLib forwardMessages: message_ids 오름차순 필수
            await client.invoke({
              _: 'forwardMessages',
              chat_id: toChatId,
              from_chat_id: fromChatId,
              message_ids: ids,
              send_copy: !!params?.noAuthors,
              remove_caption: !!params?.noCaptions,
            });
            result = null;
          } catch (e) {
            console.error('[api:request] forwardMessages error:', e.message);
            result = null;
          }
          break;
        }
        case 'sendImage': {
          const fs = require('fs');
          const sChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
          const imageData = (params && params.imageData) || '';
          const matches = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
          if (!matches) {
            console.warn('[api:request] sendImage invalid format, chat:', sChatId);
            result = { error: 'invalid image format' };
            break;
          }
          const ext = matches[1];
          const buffer = Buffer.from(matches[2], 'base64');
          const tdDir = path.join(__dirname, 'tdlib-files');
          if (!fs.existsSync(tdDir)) fs.mkdirSync(tdDir, { recursive: true });
          const tempPath = path.join(tdDir, `temp_${Date.now()}.${ext}`);
          fs.writeFileSync(tempPath, buffer);
          const inv = {
            '@type': 'sendMessage',
            chat_id: sChatId,
            input_message_content: {
              '@type': 'inputMessagePhoto',
              photo: { '@type': 'inputPhoto', photo: { '@type': 'inputFileLocal', path: tempPath } },
            },
          };
          if (params && params.replyInfo) {
            inv.reply_to = { '@type': 'inputMessageReplyToMessage', message_id: params.replyInfo.replyToMsgId };
          }
          if (params && params.caption) {
            inv.input_message_content.caption = { '@type': 'formattedText', text: params.caption };
          }
          const sent = await client.invoke(inv);
          console.log('[api:request] sendImage to chat:', sChatId, 'bytes:', buffer.length, 'ext:', ext);
          setTimeout(() => { try { fs.unlinkSync(tempPath); } catch (e) {} }, 5000);
          result = sent;
          break;
        }
        case 'sendFile': {
          const fs = require('fs');
          const sChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
          const fileData = (params && params.fileData) || '';
          const matches = fileData.match(/^data:([^;]+);base64,(.+)$/);
          if (!matches) {
            console.warn('[api:request] sendFile invalid format, chat:', sChatId);
            result = { error: 'invalid file format' };
            break;
          }
          const buffer = Buffer.from(matches[2], 'base64');
          const tdDir = path.join(__dirname, 'tdlib-files');
          if (!fs.existsSync(tdDir)) fs.mkdirSync(tdDir, { recursive: true });
          const safeName = ((params && params.fileName) || `file_${Date.now()}`).replace(/[^\w.\-]/g, '_');
          const tempPath = path.join(tdDir, `temp_${Date.now()}_${safeName}`);
          fs.writeFileSync(tempPath, buffer);
          const inv = {
            '@type': 'sendMessage',
            chat_id: sChatId,
            input_message_content: {
              '@type': 'inputMessageDocument',
              document: { '@type': 'inputDocument', document: { '@type': 'inputFileLocal', path: tempPath } },
            },
          };
          if (params && params.replyInfo) {
            inv.reply_to = { '@type': 'inputMessageReplyToMessage', message_id: params.replyInfo.replyToMsgId };
          }
          if (params && params.caption) {
            inv.input_message_content.caption = { '@type': 'formattedText', text: params.caption };
          }
          const sent = await client.invoke(inv);
          console.log('[api:request] sendFile to chat:', sChatId, 'name:', safeName, 'bytes:', buffer.length);
          setTimeout(() => { try { fs.unlinkSync(tempPath); } catch (e) {} }, 5000);
          result = sent;
          break;
        }
        case 'uploadBegin': {
          const crypto = require('crypto');
          const total = Number(params && params.totalChunks) || 0;
          const uploadId = crypto.randomUUID();
          pendingUploads.set(uploadId, {
            prefix: (params && params.dataUriPrefix) || '',
            fileName: (params && params.fileName) || ('file_' + Date.now()),
            mimeType: (params && params.mimeType) || 'application/octet-stream',
            kind: (params && params.kind) === 'image' ? 'image' : 'file',
            total,
            parts: new Array(total),
            received: 0,
            socketId: socket.id,
            ts: Date.now(),
          });
          console.log('[api:request] uploadBegin id:', uploadId, 'chunks:', total, 'name:', (params && params.fileName));
          result = { uploadId };
          break;
        }
        case 'uploadChunk': {
          const u = pendingUploads.get(params && params.uploadId);
          if (!u) { result = { error: 'unknown uploadId' }; break; }
          const idx = Number(params && params.index);
          if (u.parts[idx] === undefined) u.received++;
          u.parts[idx] = String((params && params.data) || '');
          u.ts = Date.now();
          result = { ok: true, received: u.received, total: u.total };
          break;
        }
        case 'uploadCommit': {
          const fs = require('fs');
          const u = pendingUploads.get(params && params.uploadId);
          if (!u) { result = { error: 'unknown uploadId' }; break; }
          if (u.received !== u.total || u.parts.some((p) => p === undefined)) {
            result = { error: 'incomplete upload', received: u.received, total: u.total };
            break;
          }
          const buffer = Buffer.from(u.parts.join(''), 'base64');
          const sChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
          const tdDir = path.join(__dirname, 'tdlib-files');
          if (!fs.existsSync(tdDir)) fs.mkdirSync(tdDir, { recursive: true });
          const safeName = u.fileName.replace(/[^\w.\-]/g, '_');
          const tempPath = path.join(tdDir, `temp_${Date.now()}_${safeName}`);
          fs.writeFileSync(tempPath, buffer);
          const inv = {
            '@type': 'sendMessage',
            chat_id: sChatId,
            input_message_content: u.kind === 'image'
              ? { '@type': 'inputMessagePhoto', photo: { '@type': 'inputPhoto', photo: { '@type': 'inputFileLocal', path: tempPath } } }
              : { '@type': 'inputMessageDocument', document: { '@type': 'inputDocument', document: { '@type': 'inputFileLocal', path: tempPath } } },
          };
          if (params && params.replyInfo) {
            inv.reply_to = { '@type': 'inputMessageReplyToMessage', message_id: params.replyInfo.replyToMsgId };
          }
          if (params && params.caption) {
            inv.input_message_content.caption = { '@type': 'formattedText', text: params.caption };
          }
          const sent = await client.invoke(inv);
          console.log('[api:request] uploadCommit chat:', sChatId, 'name:', safeName, 'bytes:', buffer.length, 'chunks:', u.total);
          pendingUploads.delete(params.uploadId);
          setTimeout(() => { try { fs.unlinkSync(tempPath); } catch (e) {} }, 5000);
          result = sent;
          break;
        }
        case 'downloadMedia': {
          // mediaHash 형식: "photo{id}?size={type}" → photo sizes에서 fileId 찾아 다운로드
          const mediaUrl = params?.url || '';

          // v0.28: avatar / profile URL 분기 — remote.id 단일 형식.
          // (1) cache hit → 즉시 downloadFile
          // (2) cache miss → getRemoteFile(fileTypeProfilePhoto) 로 결정적 해석 후 cache 갱신
          // (3) 양쪽 실패 → null ack (이전 parseInt 폴백은 remote.id 영문자라 무의미하여 제거)
          const avatarMatch = mediaUrl.match(/^(avatar|profile)([^?]+)\?(.+)$/);
          if (avatarMatch) {
            const avatarPhotoId = avatarMatch[3];
            const resolved = await resolveAvatarEntry(avatarPhotoId, activeAccountId);
            if (resolved?.entry) {
              const { entry, via } = resolved;
              const acc = ACCOUNTS[entry.accountId];
              if (acc?.client) {
                try {
                  const file = await acc.client.invoke({ _: 'downloadFile', file_id: entry.fileId, priority: 1, synchronous: true });
                  if (file.local?.path) {
                    const fs = require('fs');
                    const data = fs.readFileSync(file.local.path);
                    console.log('[downloadMedia avatar] OK photoId=' + avatarPhotoId + ' via=' + via + ' bytes=' + data.length);
                    // mediaLoader.prepareMedia 가 dataBlob 을 그대로 img src 로 사용 → data URI 반환
                    result = { dataBlob: 'data:image/jpeg;base64,' + data.toString('base64'), mimeType: 'image/jpeg' };
                    break;
                  } else {
                    console.log('[downloadMedia avatar] FAIL photoId=' + avatarPhotoId + ' via=' + via + ' reason=no-path');
                  }
                } catch (e) {
                  console.error('[downloadMedia avatar] FAIL photoId=' + avatarPhotoId + ' via=' + via + ' reason=' + (e?.message || e));
                }
              } else {
                console.log('[downloadMedia avatar] FAIL photoId=' + avatarPhotoId + ' via=' + via + ' reason=no-account accountId=' + entry.accountId);
              }
            } else {
              console.log('[downloadMedia avatar] FAIL photoId=' + avatarPhotoId + ' reason=unresolved (cache miss + getRemoteFile fail)');
            }
            result = null;
            break;
          }

          const match = mediaUrl.match(/^photo(\d+)(?:\?size=(\w+))?$/);
          if (match) {
            const photoMsgId = parseInt(match[1]);
            const requestedSize = match[2] || 'x';

            // v0.17.2: cache lookup 다단계 fallback
            // (1) 정확 매칭 → (2) 'x' 별칭 (largestSize) → (3) 'full' 별칭 → 최종 cache miss
            let cacheKey = `${photoMsgId}_${requestedSize}`;
            let cachedFileId = global._photoFileIdCache?.[cacheKey];
            let cacheState = 'hit-' + requestedSize;
            if (!cachedFileId && requestedSize !== 'x') {
              cacheKey = `${photoMsgId}_x`;
              cachedFileId = global._photoFileIdCache?.[cacheKey];
              if (cachedFileId) cacheState = 'fallback-x';
            }
            if (!cachedFileId) {
              cacheKey = `${photoMsgId}_full`;
              cachedFileId = global._photoFileIdCache?.[cacheKey];
              if (cachedFileId) cacheState = 'fallback-full';
            }

            if (cachedFileId) {
              try {
                const file = await client.invoke({ _: 'downloadFile', file_id: cachedFileId, priority: 1, synchronous: true });
                if (file.local?.path) {
                  const fs = require('fs');
                  const data = fs.readFileSync(file.local.path);
                  console.log('[downloadMedia photo] OK msgId=' + photoMsgId + ' reqSize=' + requestedSize + ' cache=' + cacheState + ' bytes=' + data.length);
                  result = { dataBlob: 'data:image/jpeg;base64,' + data.toString('base64'), mimeType: 'image/jpeg' };
                  break;
                } else {
                  console.log('[downloadMedia photo] no-path msgId=' + photoMsgId + ' reqSize=' + requestedSize + ' cache=' + cacheState);
                }
              } catch (e) {
                console.error('[downloadMedia photo] error msgId=' + photoMsgId + ' reqSize=' + requestedSize + ' cache=' + cacheState + ' msg=' + (e?.message || e));
              }
            } else {
              console.log('[downloadMedia photo] cache-miss msgId=' + photoMsgId + ' reqSize=' + requestedSize + ' (no exact/x/full fallback)');
            }
          }
          const docMatch = mediaUrl.match(/^document(\d+)(?:\?size=(\w+))?$/);
          if (docMatch) {
            const docFileId = parseInt(docMatch[1]);
            try {
              const file = await client.invoke({ _: 'downloadFile', file_id: docFileId, priority: 1, synchronous: true });
              if (file.local?.path) {
                const fs = require('fs');
                const data = fs.readFileSync(file.local.path);
                let mime = 'image/webp';
                if (data.length >= 12 && data.slice(0, 4).toString('ascii') === 'RIFF' && data.slice(8, 12).toString('ascii') === 'WEBP') mime = 'image/webp';
                else if (data.slice(0, 4).toString('hex') === '1a45dfa3') mime = 'video/webm';
                else if (data.slice(0, 2).toString('hex') === '1f8b') mime = 'application/gzip';
                console.log('[downloadMedia sticker/doc] OK fileId=' + docFileId + ' mime=' + mime + ' bytes=' + data.length);
                result = { dataBlob: 'data:' + mime + ';base64,' + data.toString('base64'), mimeType: mime };
                break;
              } else {
                console.log('[downloadMedia sticker/doc] no-path fileId=' + docFileId);
              }
            } catch (e) {
              console.error('[downloadMedia sticker/doc] error fileId=' + docFileId + ' ' + (e?.message || e));
            }
          }
          // 프로필 사진 등 다른 mediaHash는 null 반환
          result = null;
          break;
        }
        case 'sendMessageAction': {
          // typing 표시 — 에러 안 나게 빈 응답
          result = null;
          break;
        }
        case 'fetchMembers': {
          // 그룹 멤버 목록 조회
          const chatForMembers = params?.chat;
          const chatIdForMembers = chatForMembers ? Number(chatForMembers.id) : null;
          if (!chatIdForMembers) { result = null; break; }

          try {
            const chatObj = await client.invoke({ _: 'getChat', chat_id: chatIdForMembers });
            let membersList = [];

            if (chatObj.type?._ === 'chatTypeSupergroup') {
              const sgResult = await client.invoke({
                _: 'getSupergroupMembers',
                supergroup_id: chatObj.type.supergroup_id,
                filter: { _: 'supergroupMembersFilterRecent' },
                offset: params?.offset || 0,
                limit: 50
              });
              for (const m of (sgResult.members || [])) {
                try {
                  const user = await client.invoke({ _: 'getUser', user_id: m.user_id });
                  const firstName = user.first_name || '';
                  const lastName = user.last_name || '';
                  membersList.push({
                    userId: String(user.id),
                    firstName,
                    lastName,
                    username: user.usernames?.active_usernames?.[0] || user.username || '',
                    isAdmin: m.status?._ === 'chatMemberStatusAdministrator' || undefined,
                    isOwner: m.status?._ === 'chatMemberStatusCreator' || undefined,
                    isContact: user.is_contact || undefined,
                  });
                } catch(e) {}
              }
            } else if (chatObj.type?._ === 'chatTypeBasicGroup') {
              const bgResult = await client.invoke({
                _: 'getBasicGroupFullInfo',
                basic_group_id: chatObj.type.basic_group_id
              });
              for (const m of (bgResult.members || [])) {
                try {
                  const user = await client.invoke({ _: 'getUser', user_id: m.user_id });
                  membersList.push({
                    userId: String(user.id),
                    firstName: user.first_name || '',
                    lastName: user.last_name || '',
                    username: user.usernames?.active_usernames?.[0] || user.username || '',
                    isAdmin: m.status?._ === 'chatMemberStatusAdministrator' || undefined,
                    isOwner: m.status?._ === 'chatMemberStatusCreator' || undefined,
                    isContact: user.is_contact || undefined,
                  });
                } catch(e) {}
              }
            }

            // telegram-tt가 기대하는 형식으로 반환
            const apiMembers = membersList.map(m => ({ userId: m.userId, isAdmin: m.isAdmin, isOwner: m.isOwner }));
            const apiUsers = membersList.map(m => ({
              id: m.userId,
              type: 'userTypeRegular',
              firstName: m.firstName,
              lastName: m.lastName || undefined,
              usernames: m.username ? [{ username: m.username, isActive: true, isEditable: false }] : undefined,
              hasUsername: !!m.username,
              phoneNumber: '',
              isMin: false,
              isContact: m.isContact,
            }));
            const userStatusesById = {};
            membersList.forEach(m => { userStatusesById[m.userId] = { type: 'userStatusEmpty' }; });

            result = { members: apiMembers, users: apiUsers, userStatusesById };
          } catch(e) {
            console.error('[fetchMembers] error:', e.message);
            result = null;
          }
          break;
        }
        case 'fetchPinnedMessages':
        case 'abortChatRequests':
        case 'fetchFullChat': {
          // stub — 아직 미구현이지만 timeout 에러 방지
          result = null;
          break;
        }
        case 'fetchCommonChats': {
          // v0.48: 1:1 유저 프로필 "그룹" 탭(공통그룹) 배선.
          // 입력: { user: { id, accessHash? } } 또는 { userId }, maxId(offset chat id)
          // TDLib: getGroupsInCommon { user_id, offset_chat_id, limit } → { chat_ids[], total_count }
          // 반환: { chatIds: string[], count, chats: ApiChat[] } — chats 는 fetchChats 빌더 재사용
          // 클라(global/actions/api/users.ts:loadCommonChats) 는 chatIds/count 만 사용하지만,
          // GroupChatInfo 가 global.chats[chatId] 를 lookup 하므로 누락 시 빈 줄로 보임.
          // 따라서 chats 도 함께 반환하고 클라 측에서 updateChats 로 merge 한다.
          try {
            const rawUid = params && (params.userId
              || (params.user && (params.user.id || params.user.userId)));
            const userId = Number(rawUid);
            if (!userId || Number.isNaN(userId)) {
              console.log('[fetchCommonChats] no userId param');
              result = { chatIds: [], count: 0, chats: [] };
              break;
            }
            const offsetChatId = Number((params && params.maxId) || 0) || 0;
            const limit = Number((params && params.limit) || 100) || 100;
            let resp = null;
            try {
              resp = await client.invoke({
                _: 'getGroupsInCommon',
                user_id: userId,
                offset_chat_id: offsetChatId,
                limit,
              });
            } catch (e) {
              console.error('[fetchCommonChats] getGroupsInCommon failed user_id', userId, e.message);
              result = { chatIds: [], count: 0, chats: [] };
              break;
            }
            const rawChatIds = (resp && resp.chat_ids) || [];
            const count = (resp && resp.total_count) || rawChatIds.length;
            const chatIds = rawChatIds.map((id) => String(id));
            const chats = [];
            for (const cid of rawChatIds) {
              try {
                const c = await client.invoke({ _: 'getChat', chat_id: cid });
                if (!c) continue;
                let chatType = 'chatTypePrivate';
                let isSuperGroup = false;
                let isChannelLocal = false;
                if (c.type && c.type._ === 'chatTypeBasicGroup') chatType = 'chatTypeBasicGroup';
                else if (c.type && c.type._ === 'chatTypeSupergroup') {
                  isSuperGroup = true;
                  chatType = c.type.is_channel ? 'chatTypeChannel' : 'chatTypeSuperGroup';
                  isChannelLocal = !!c.type.is_channel;
                } else if (c.type && c.type._ === 'chatTypeSecret') chatType = 'chatTypeSecret';
                let avatarPhotoId;
                const small = c.photo && c.photo.small;
                const smallRemoteId = small && small.remote && small.remote.id;
                const smallFileId = small && small.id;
                if (smallRemoteId && smallFileId) {
                  avatarPhotoId = String(smallRemoteId);
                  global._avatarFileIdCache.set(avatarPhotoId, { fileId: smallFileId, accountId: activeAccountId });
                }
                // v0.55: 공통그룹 chat 도 my status 채워 selectCanManage 일관성 유지.
                let statusFields = {};
                try {
                  if (c.type?._ === 'chatTypeBasicGroup' && c.type.basic_group_id) {
                    const bg = await client.invoke({ _: 'getBasicGroup', basic_group_id: c.type.basic_group_id });
                    statusFields = buildChatStatusFields(bg?.status);
                  } else if (c.type?._ === 'chatTypeSupergroup' && c.type.supergroup_id) {
                    const sg = await client.invoke({ _: 'getSupergroup', supergroup_id: c.type.supergroup_id });
                    statusFields = buildChatStatusFields(sg?.status);
                  }
                } catch (e) {
                  console.error('[fetchCommonChats] status fetch failed chat_id', c.id, e.message);
                }
                chats.push({
                  id: String(c.id),
                  title: c.title || '',
                  type: chatType,
                  unreadCount: c.unread_count || 0,
                  unreadMentionsCount: c.unread_mention_count || 0,
                  lastReadInboxMessageId: c.last_read_inbox_message_id || 0,
                  lastReadOutboxMessageId: c.last_read_outbox_message_id || 0,
                  creationDate: 0,
                  isMuted: !!(c.notification_settings && c.notification_settings.mute_for > 0),
                  isListed: true,
                  avatarPhotoId,
                  hasVideoAvatar: !!(c.photo && c.photo.has_animation),
                  ...statusFields,
                });
              } catch (e) {
                console.error('[fetchCommonChats] getChat failed chat_id', cid, e.message);
              }
            }
            console.log('[fetchCommonChats] user=' + userId + ' count=' + count + ' got=' + chatIds.length + ' maxId=' + offsetChatId);
            result = { chatIds, count, chats };
          } catch (e) {
            console.error('[fetchCommonChats] unexpected error:', e && e.message);
            result = { chatIds: [], count: 0, chats: [] };
          }
          break;
        }
        case 'getBotCommands': {
          // v0.24: 봇/채팅을 먼저 materialize 한 뒤 getUserFullInfo.
          // 배경: v0.23 의 getUser 선호출은 미로드 봇에서 "User not found" → isBot
          // false → commands 0. getChat 단독도 "Chat not found" 가 가능(클라이언트가
          // 해당 채팅을 아직 openChat 하지 않은 콜드 경로). 표준 TDLib 패턴:
          //   1) createPrivateChat({user_id, force:true}) — 멱등. 기존 private chat
          //      반환 + 유저를 user 캐시에 적재. 봇 user_id 가 들어왔을 때 정답.
          //   2) 실패(예: 음수 그룹/채널 chat_id) 시 getChat({chat_id}) 폴백.
          //   3) chatTypePrivate.user_id 를 권위 있게 뽑아 getUserFullInfo 호출,
          //      bot_info.commands 추출. (getUser 선호출은 금지 — 미로드 봇 회귀)
          // 비봇/그룹/명령 미등록/모든 invoke 실패 시 빈 배열 graceful (throw 금지).
          //
          // v0.25: 응답에 봇 user 객체도 함께 실어 반환. v2 fetchFullUser 가
          // loadFullUser 의 result.user 진리값 체크를 통과시키려면 user 가 필수.
          // user 확보는 materialize 이후이므로 캐시 hit 비용 무시 가능.
          let commands = [];
          let user = null;
          let chatType = null;
          const rawId = params && (params.userId || params.user_id || params.chatId);
          const id = Number(rawId);
          if (!id || Number.isNaN(id)) {
            console.log('[v0.24 botCommands] no id param');
            result = { commands, user };
            break;
          }
          let chat = null;
          try {
            chat = await client.invoke({ _: 'createPrivateChat', user_id: id, force: true });
          } catch (e) {
            console.error('[v0.24 botCommands] createPrivateChat failed user_id', id, e.message);
          }
          if (!chat) {
            try {
              chat = await client.invoke({ _: 'getChat', chat_id: id });
            } catch (e) {
              console.error('[v0.24 botCommands] getChat fallback failed id', id, e.message);
            }
          }
          chatType = chat && chat.type && chat.type._;
          // v0.55: 그룹/슈퍼그룹 분기 — 그룹 chatFullInfo.botCommands 에 봇별 명령 적재.
          // 1:1 응답 shape({commands, user, commonChatsCount}) 와 분리된 그룹 응답 shape
          //   {commands:[{command, description, botId}], group:true, source}
          // 로 반환. 클라 fetchFullChat 그룹 분기가 group 플래그로 판별.
          if (chatType === 'chatTypeSupergroup' || chatType === 'chatTypeBasicGroup') {
            let groupCmds = [];
            let source = 'none';
            try {
              if (chatType === 'chatTypeSupergroup' && chat.type.supergroup_id) {
                const full = await client.invoke({
                  _: 'getSupergroupFullInfo',
                  supergroup_id: chat.type.supergroup_id,
                });
                const bcs = (full && full.bot_commands) || [];
                if (bcs.length) source = 'getSupergroupFullInfo.bot_commands';
                for (const b of bcs) {
                  const bId = String(b.bot_user_id || '');
                  for (const c of (b.commands || [])) {
                    if (c && typeof c.command === 'string') {
                      groupCmds.push({ command: c.command, description: c.description || '', botId: bId });
                    }
                  }
                }
              } else if (chatType === 'chatTypeBasicGroup' && chat.type.basic_group_id) {
                const full = await client.invoke({
                  _: 'getBasicGroupFullInfo',
                  basic_group_id: chat.type.basic_group_id,
                });
                const bcs = (full && full.bot_commands) || [];
                if (bcs.length) source = 'getBasicGroupFullInfo.bot_commands';
                for (const b of bcs) {
                  const bId = String(b.bot_user_id || '');
                  for (const c of (b.commands || [])) {
                    if (c && typeof c.command === 'string') {
                      groupCmds.push({ command: c.command, description: c.description || '', botId: bId });
                    }
                  }
                }
              }
            } catch (e) {
              console.error('[v0.55 botCommands group] full info failed id', id, 'chatType', chatType, e.message);
            }
            // 폴백: bot_commands 가 비면 그룹 멤버 봇별 getUserFullInfo.bot_info.commands 조회
            if (!groupCmds.length) {
              try {
                let memberUserIds = [];
                if (chatType === 'chatTypeSupergroup' && chat.type.supergroup_id) {
                  const res = await client.invoke({
                    _: 'getSupergroupMembers',
                    supergroup_id: chat.type.supergroup_id,
                    filter: { _: 'supergroupMembersFilterBots' },
                    offset: 0,
                    limit: 200,
                  });
                  memberUserIds = (res && res.members || [])
                    .map(m => Number((m.member_id && m.member_id.user_id) || m.user_id || 0))
                    .filter(Boolean);
                } else if (chatType === 'chatTypeBasicGroup' && chat.type.basic_group_id) {
                  const res = await client.invoke({
                    _: 'getBasicGroupFullInfo',
                    basic_group_id: chat.type.basic_group_id,
                  });
                  memberUserIds = (res && res.members || [])
                    .map(m => Number((m.member_id && m.member_id.user_id) || m.user_id || 0))
                    .filter(Boolean);
                }
                for (const uid of memberUserIds) {
                  try {
                    const u = await client.invoke({ _: 'getUser', user_id: uid });
                    if (!(u && u.type && u.type._ === 'userTypeBot')) continue;
                    const fi = await client.invoke({ _: 'getUserFullInfo', user_id: uid });
                    const cmds = fi && fi.bot_info && fi.bot_info.commands;
                    if (Array.isArray(cmds) && cmds.length) {
                      for (const c of cmds) {
                        if (c && typeof c.command === 'string') {
                          groupCmds.push({ command: c.command, description: c.description || '', botId: String(uid) });
                        }
                      }
                    }
                  } catch (e2) {
                    // 개별 봇 실패는 silent
                  }
                }
                if (groupCmds.length) source = 'member-bots/getUserFullInfo';
              } catch (e) {
                console.error('[v0.55 botCommands group] member-bots fallback failed id', id, e.message);
              }
            }
            console.log('[v0.55 botCommands group] id', id, 'chatType', chatType, 'commands', groupCmds.length, 'source', source);
            result = { commands: groupCmds, group: true, source };
            break;
          }
          let botUserId = id;
          if (chatType === 'chatTypePrivate' && chat.type.user_id) {
            botUserId = Number(chat.type.user_id);
          }
          let rawCmds;
          try {
            const fullInfo = await client.invoke({ _: 'getUserFullInfo', user_id: botUserId });
            rawCmds = fullInfo && fullInfo.bot_info && fullInfo.bot_info.commands;
          } catch (e) {
            console.error('[v0.24 botCommands] getUserFullInfo failed user_id', botUserId, e.message);
          }
          if (Array.isArray(rawCmds)) {
            commands = rawCmds
              .filter(c => c && typeof c.command === 'string')
              .map(c => ({ command: c.command, description: c.description || '' }));
          }
          try {
            user = await client.invoke({ _: 'getUser', user_id: botUserId });
          } catch (e) {
            console.error('[v0.25 botCommands] getUser failed user_id', botUserId, e.message);
          }
          // v0.48: 1:1 유저 프로필 그룹 탭 노출 조건(hasCommonChatsTab) 은
          // userFullInfo.commonChatsCount > 0 으로 판정. getGroupsInCommon limit=1 로
          // total_count 만 가볍게 받아 fetchFullUser 응답에 함께 실어 보낸다.
          // 비봇/자기자신 등 무의미 경로는 0 (서버는 silent), 클라가 false 처리.
          let commonChatsCount = 0;
          try {
            const inc = await client.invoke({
              _: 'getGroupsInCommon',
              user_id: botUserId,
              offset_chat_id: 0,
              limit: 1,
            });
            commonChatsCount = (inc && inc.total_count) || 0;
          } catch (e) {
            // self/bot/제한 등에서 실패 가능 — 0 처리
            commonChatsCount = 0;
          }
          console.log('[v0.24 botCommands] id', id, 'botUserId', botUserId, 'chatType', chatType, 'commands', commands.length, 'commonChatsCount', commonChatsCount);
          console.log('[v0.25 botCommands] user', user ? `id=${user.id} type=${user.type && user.type._}` : 'null');
          result = { commands, user, commonChatsCount };
          break;
        }
        case 'answerCallbackButton': {
          // v0.29 Phase2: 인라인 키보드 콜백 버튼 처리.
          // 클라(global/actions/api/bots.ts:answerCallbackButton 헬퍼) 가 callApi(
          // 'answerCallbackButton', { chatId, accessHash, messageId, data, isGame }) 로 보냄.
          // data 는 base64 string — v2 converters(Phase1) 가 reply_markup → inlineButtons 변환 시
          // raw bytes 를 base64 로 보존한 값. TDLib getCallbackQueryAnswer payload 는
          //   callbackQueryPayloadData{ data:bytes } (일반 버튼) 또는
          //   callbackQueryPayloadGame{ game_short_name } (게임 버튼).
          // 응답 callbackQueryAnswer{ text, show_alert, url } → 클라가 기대하는
          // { message, alert, url } (omitVirtualClassFields 결과 형태) 로 매핑.
          try {
            const rChatId = Number(params && params.chatId);
            const rMsgId = Number(params && params.messageId);
            const isGame = !!(params && params.isGame);
            if (!rChatId || !rMsgId) {
              console.log('[v0.29 callback] noop chatId=' + rChatId + ' msgId=' + rMsgId);
              result = null;
              break;
            }
            let payload;
            if (isGame) {
              payload = {
                _: 'callbackQueryPayloadGame',
                game_short_name: (params && params.gameShortName) || '',
              };
            } else {
              const dataB64 = (params && params.data) || '';
              // v0.30 RCA-014/015: TDLib JSON 인터페이스는 bytes 필드를 base64 string 으로
              // 기대한다. 이전 v0.29 는 Buffer.from(b64,'base64') 로 Node Buffer 를 넘겼고
              // 직렬화 시 {type:'Buffer',data:[...]} 로 깨져 getCallbackQueryAnswer 가
              // 응답/에러 없이 hang → [v0.29 callback] 로그 미출현 → 클라 무한 대기 발생.
              // base64 string 그대로 전달하여 TDLib 가 bytes 로 디코딩하게 한다.
              payload = {
                _: 'callbackQueryPayloadData',
                data: dataB64 || '',
              };
            }
            // v0.30: getCallbackQueryAnswer hang 재발 차단용 10s timeout race.
            // hang 시 catch 가 [v0.29 callback] error 로그 + result=null 처리로
            // 클라 무한 대기를 끊는다.
            const answer = await Promise.race([
              client.invoke({
                _: 'getCallbackQueryAnswer',
                chat_id: rChatId,
                message_id: rMsgId,
                payload,
              }),
              new Promise((_, rej) => setTimeout(
                () => rej(new Error('getCallbackQueryAnswer timeout 10s')),
                10000,
              )),
            ]);
            console.log('[v0.29 callback] OK chatId=' + rChatId + ' msgId=' + rMsgId
              + ' text="' + (((answer && answer.text) || '').slice(0, 80)) + '"'
              + ' show_alert=' + (!!(answer && answer.show_alert))
              + ' url=' + ((answer && answer.url) || ''));
            result = {
              message: (answer && answer.text) || undefined,
              alert: !!(answer && answer.show_alert),
              url: (answer && answer.url) || undefined,
            };
          } catch (e) {
            console.error('[v0.29 callback] error:', e.message);
            result = null;
          }
          break;
        }
        case 'fetchLanguages': {
          // v0.32: Settings > Language 화면용 TDLib 언어팩 목록.
          // getLocalizationTargetInfo.language_packs → ApiLanguage[] (snake→camel).
          // 사전조건: TDLib 의 `localization_target` 옵션이 설정되어 있어야 함.
          // (미설정 시 "Option \"localization_target\" needs to be set first" 에러)
          try {
            try {
              await client.invoke({
                _: 'setOption',
                name: 'localization_target',
                value: { _: 'optionValueString', value: 'android' },
              });
            } catch (optErr) {
              console.warn('[v0.32 fetchLanguages] setOption soft-fail:', optErr.message);
            }
            const r = await client.invoke({ _: 'getLocalizationTargetInfo', only_local: false });
            const packs = (r && r.language_packs) || [];
            result = packs.map((p) => ({
              langCode: p.id,
              baseLangCode: p.base_language_pack_id || undefined,
              name: p.name,
              nativeName: p.native_name,
              pluralCode: p.plural_code,
              isOfficial: !!p.is_official,
              isRtl: !!p.is_rtl,
              isBeta: !!p.is_beta,
              stringsCount: p.total_string_count,
              translatedCount: p.translated_string_count,
              translationsUrl: p.translation_url || undefined,
            }));
            console.log('[v0.32 fetchLanguages] count', result.length);
          } catch (e) {
            console.error('[v0.32 fetchLanguages] error:', e.message);
            result = null;
          }
          break;
        }
        case 'oldFetchLangPack': {
          // v0.40: 4팩(android/ios/tdesktop/macos) 머지 — 원본 telegram-tt-ref oldLangProvider 와 동일 정책.
          // 머지 순서: LANG_PACKS 의 reverse() 로 Object.assign → android 가 최우선(마지막 덮어쓰기).
          // Weekday.Short* 같은 점(.)형 키는 ios/macos 팩에만 존재 → 4팩 머지 시에만 노출되어
          // 클라 채팅목록의 요일 raw-key(`Weekday.ShortThursday` 등) P0 가 해소된다.
          try {
            const langCode = params && params.langCode;
            if (!langCode) {
              result = null;
              break;
            }
            const LANG_PACKS = (params && Array.isArray(params.sourceLangPacks) && params.sourceLangPacks.length)
              ? params.sourceLangPacks
              : ['android', 'ios', 'tdesktop', 'macos'];
            const collections = [];
            for (const lp of LANG_PACKS) {
              try {
                await client.invoke({
                  _: 'setOption',
                  name: 'localization_target',
                  value: { _: 'optionValueString', value: lp },
                });
              } catch (optErr) {
                console.warn('[v0.40 oldFetchLangPack] setOption soft-fail:', lp, optErr.message);
              }
              let s;
              try {
                s = await client.invoke({
                  _: 'getLanguagePackStrings',
                  language_pack_id: langCode,
                  keys: [],
                });
              } catch (gErr) {
                console.warn('[v0.40 oldFetchLangPack] getLanguagePackStrings soft-fail:', lp, gErr.message);
                collections.push({});
                continue;
              }
              const collection = {};
              const strings = (s && s.strings) || [];
              for (const item of strings) {
                if (!item || !item.key || !item.value) continue;
                const v = item.value;
                if (v._ === 'languagePackStringValueOrdinary') {
                  collection[item.key] = v.value;
                } else if (v._ === 'languagePackStringValuePluralized') {
                  collection[item.key] = {
                    zeroValue: v.zero_value,
                    oneValue: v.one_value,
                    twoValue: v.two_value,
                    fewValue: v.few_value,
                    manyValue: v.many_value,
                    otherValue: v.other_value,
                  };
                }
                // languagePackStringValueDeleted → 키 제외 (skip)
              }
              collections.push(collection);
            }
            // 원본 oldLangProvider 와 동일: LANG_PACKS reverse → Object.assign → android 가 최우선
            const reversed = collections.slice().reverse();
            const merged = Object.assign({}, ...reversed);
            // 복원: 다른 TDLib 호출이 마지막 target('macos' 등)에 영향받지 않도록 android 로 복원
            try {
              await client.invoke({
                _: 'setOption',
                name: 'localization_target',
                value: { _: 'optionValueString', value: 'android' },
              });
            } catch (restoreErr) {
              console.warn('[v0.40 oldFetchLangPack] restore setOption soft-fail:', restoreErr.message);
            }
            console.log('[LANGDIAG-SRV] oldFetchLangPack langCode=', langCode, 'mergedKeys=', merged ? Object.keys(merged).length : 0);
            result = { langPack: merged };
            console.log(
              '[v0.40 oldFetchLangPack] langCode', langCode,
              'packs', LANG_PACKS.join(','),
              'mergedKeys', Object.keys(merged).length,
              'hasWeekdayShort', merged['Weekday.ShortThursday'] !== undefined,
            );
          } catch (e) {
            console.error('[v0.40 oldFetchLangPack] error:', e.message);
            result = null;
          }
          break;
        }
        case 'setLanguage': {
          // v0.32: language_pack_id 옵션 갱신 + 동기화 트리거(실패 무시).
          try {
            const langCode = params && params.langCode;
            if (!langCode) {
              result = null;
              break;
            }
            await client.invoke({
              _: 'setOption',
              name: 'language_pack_id',
              value: { _: 'optionValueString', value: langCode },
            });
            try {
              await client.invoke({ _: 'synchronizeLanguagePack', language_pack_id: langCode });
            } catch (syncErr) {
              console.warn('[v0.32 setLanguage] synchronizeLanguagePack soft-fail:', syncErr.message);
            }
            console.log('[v0.32 setLanguage] langCode', langCode);
            result = { ok: true };
          } catch (e) {
            console.error('[v0.32 setLanguage] error:', e.message);
            result = null;
          }
          break;
        }
        case 'fetchLanguage': {
          // v0.38: v2 신 localization 핸들러 — callApi('fetchLanguage', { langPack, langCode })
          // → ApiLanguage 메타 객체 반환 (telegram-tt-ref buildApiLanguage 와 동일 형태).
          // TDLib getLanguagePackInfo(language_pack_id=langCode) 사용. localization_target 은
          // 요청 langPack(='weba') 으로 설정. 실패 시 fetchLanguages 로 fallback (목록에서 검색).
          try {
            const reqLangPack = (params && params.langPack) || 'weba';
            const langCode = params && params.langCode;
            if (!langCode) {
              result = null;
              break;
            }
            const cached = _v38LangCache.lang.get(reqLangPack + ':' + langCode);
            if (cached) {
              result = cached;
              console.log('[v0.38 fetchLanguage] cache hit', reqLangPack, langCode);
              break;
            }
            try {
              await client.invoke({
                _: 'setOption',
                name: 'localization_target',
                value: { _: 'optionValueString', value: reqLangPack },
              });
            } catch (optErr) {
              console.warn('[v0.38 fetchLanguage] setOption soft-fail:', optErr.message);
            }
            let info;
            try {
              info = await client.invoke({
                _: 'getLanguagePackInfo',
                language_pack_id: langCode,
              });
            } catch (e1) {
              console.warn('[v0.38 fetchLanguage] getLanguagePackInfo failed, fallback to getLocalizationTargetInfo:', e1.message);
              try {
                const t = await client.invoke({ _: 'getLocalizationTargetInfo', only_local: false });
                const packs = (t && t.language_packs) || [];
                info = packs.find((p) => p.id === langCode);
              } catch (e2) {
                console.error('[v0.38 fetchLanguage] fallback failed:', e2.message);
              }
            }
            if (!info) {
              console.warn('[v0.38 fetchLanguage] not found', reqLangPack, langCode);
              result = null;
              break;
            }
            const apiLang = _v38BuildApiLanguage(info);
            _v38LangCache.lang.set(reqLangPack + ':' + langCode, apiLang);
            console.log('[v0.38 fetchLanguage] OK', reqLangPack, langCode, 'name=', apiLang.name, 'pluralCode=', apiLang.pluralCode);
            result = apiLang;
          } catch (e) {
            console.error('[v0.38 fetchLanguage] error:', e.message);
            result = null;
          }
          break;
        }
        case 'fetchLangPack': {
          // v0.38: callApi('fetchLangPack', { langPack, langCode }) → { version, strings, keysToRemove }
          // 신 LangPackStringValue 형태 — Plural 은 { zero?, one?, two?, few?, many?, other } (Value 접미 없음).
          // 빈 strings 위험 방지: TDLib synchronizeLanguagePack 으로 로컬 캐시 갱신 후 호출.
          try {
            const reqLangPack = (params && params.langPack) || 'weba';
            const langCode = params && params.langCode;
            if (!langCode) {
              result = null;
              break;
            }
            const built = await _v38BuildWebaLangPack(client, reqLangPack, langCode);
            if (!built) {
              result = null;
              break;
            }
            result = built;
            console.log('[v0.39 langpack] fetchLangPack', reqLangPack, langCode,
              'fromVersion=', (params && params.fromVersion),
              'newVersion=', built.version, 'keys=', Object.keys(built.strings).length,
              'remove=', built.keysToRemove.length);
          } catch (e) {
            console.error('[v0.38 fetchLangPack] error:', e.message);
            result = null;
          }
          break;
        }
        case 'fetchLangDifference': {
          // v0.38: callApi('fetchLangDifference', { langPack, langCode, fromVersion })
          //   → { version, strings, keysToRemove }
          // 초기 구현은 증분 최적화 없이 전체 팩을 strings 로 반환 (fromVersion 무시).
          // 클라 applyLangPackDifference 는 version === langPack.version 인 경우 noop 이라
          // 같은 version 을 돌려주면 무한 갱신을 막을 수 있다.
          try {
            const reqLangPack = (params && params.langPack) || 'weba';
            const langCode = params && params.langCode;
            if (!langCode) {
              result = null;
              break;
            }
            const built = await _v38BuildWebaLangPack(client, reqLangPack, langCode);
            if (!built) {
              result = null;
              break;
            }
            result = {
              version: built.version,
              strings: built.strings,
              keysToRemove: built.keysToRemove || [],
            };
            console.log('[v0.39 langpack] fetchLangDifference', reqLangPack, langCode,
              'fromVersion=', (params && params.fromVersion),
              'newVersion=', result.version,
              'keys=', Object.keys(result.strings).length);
          } catch (e) {
            console.error('[v0.38 fetchLangDifference] error:', e.message);
            result = null;
          }
          break;
        }
        case 'searchChats': {
          // v0.65 [065]: left global search. telegram-tt GramJS uses contacts.Search and
          // returns { accountResultIds, globalResultIds }; TDLib maps that to local
          // searchChatsOnServer plus public searchPublicChats. Messages are out of scope.
          const query = String((params && params.query) || '').trim();
          const limit = Number((params && params.limit) || 50) || 50;
          if (!query) {
            result = {
              accountResultIds: [],
              globalResultIds: [],
              chats: [],
              users: [],
              userStatusesById: {},
            };
            break;
          }

          let localChatIds = [];
          try {
            const localFound = await client.invoke({
              _: 'searchChatsOnServer',
              query,
              limit,
            });
            localChatIds = (localFound && localFound.chat_ids) || [];
          } catch (e) {
            console.error('[searchChats] searchChatsOnServer failed query=' + query + ' ' + (e && e.message));
          }

          let publicChatIds = [];
          try {
            const publicFound = await client.invoke({
              _: 'searchPublicChats',
              query,
            });
            publicChatIds = (publicFound && publicFound.chat_ids) || [];
          } catch (e) {
            console.log('[searchChats] searchPublicChats soft-fail query=' + query + ' ' + (e && e.message));
          }

          const localIdSet = new Set(localChatIds.map((chatId) => String(chatId)));
          const globalChatIds = publicChatIds.filter((chatId) => !localIdSet.has(String(chatId)));
          const localEntities = await buildSearchChatEntities(client, localChatIds, activeAccountId);
          const globalEntities = await buildSearchChatEntities(client, globalChatIds, activeAccountId);
          const chats = [...localEntities.chats, ...globalEntities.chats];
          const usersById = new Map();
          [...localEntities.users, ...globalEntities.users].forEach((u) => usersById.set(String(u.id), u));

          result = {
            accountResultIds: localEntities.chats.map((c) => c.id),
            globalResultIds: globalEntities.chats.map((c) => c.id),
            chats,
            users: Array.from(usersById.values()),
            userStatusesById: {},
          };
          console.log('[searchChats] query=' + query + ' local=' + result.accountResultIds.length + ' global=' + result.globalResultIds.length + ' chats=' + chats.length + ' users=' + result.users.length);
          break;
        }
        case 'searchMessagesInChat': {
          // v0.47: 프로필 공유미디어 패널(6탭) 무한로딩 해소.
          // 클라(weba) searchSharedMedia → callApi('searchMessagesInChat', {peer,type,limit,threadId,offsetId,...}).
          // 이전: switch 미등록 → default(null) → 클라 if(!result)return → 스피너 영구.
          // 1차(미디어) 우선. 나머지 5탭 동일 경로라 무한로딩 자체는 6탭 모두 해소.
          // (사진 외 타입 콘텐츠 풀빌드(document/animation/audio/voice/url)는 후속 #026.)
          const numChatId = Number((params && params.peer && params.peer.id) || (params && params.chatId));
          if (!numChatId) { result = null; break; }
          const FILTER_MAP = {
            media: 'searchMessagesFilterPhotoAndVideo',
            documents: 'searchMessagesFilterDocument',
            links: 'searchMessagesFilterUrl',
            audio: 'searchMessagesFilterAudio',
            voice: 'searchMessagesFilterVoiceNote',
            gif: 'searchMessagesFilterAnimation',
          };
          const filterType = FILTER_MAP[params && params.type] || 'searchMessagesFilterPhotoAndVideo';
          try {
            // 기존 /api/photos · /api/search 핸들러(L2867)와 동일 시그니처(_: 'searchChatMessages').
            const found = await client.invoke({
              _: 'searchChatMessages',
              chat_id: numChatId,
              query: '',
              from_message_id: Number((params && params.offsetId)) || 0,
              offset: Number((params && params.addOffset)) || 0,
              limit: Number((params && params.limit)) || 40,
              filter: { _: filterType },
              message_thread_id: Number((params && params.threadId)) || 0,
            });
            const list = (found && found.messages) || [];
            for (const m of list) {
              try { await maybeFlattenRich(m, client); }
              catch (e) { console.error('[searchMessagesInChat] richMessage flatten error:', e.message); }
            }
            const apiMessages = list.map((m) => buildSharedApiMessage(m, numChatId));
            const nextOffsetId = (found && found.next_from_message_id)
              || (list.length ? list[list.length - 1].id : 0);
            result = {
              messages: apiMessages,
              totalCount: (found && found.total_count) || apiMessages.length,
              nextOffsetId,
              userStatusesById: {},
            };
            console.log('[searchMessagesInChat] chat=' + numChatId + ' type=' + (params && params.type) + ' filter=' + filterType + ' got=' + apiMessages.length + ' total=' + result.totalCount + ' next=' + nextOffsetId);
          } catch (e) {
            console.error('[searchMessagesInChat] error:', e.message);
            result = null;
          }
          break;
        }
        case 'searchMessagesGlobal': {
          // [075] LeftColumn global text search. TDLib returns FoundMessages with
          // messages from chatListMain; media/global tabs remain out of scope here.
          const query = String((params && params.query) || '').trim();
          const limit = Number((params && params.limit) || 20) || 20;
          if (!query && !(params && params.minDate && params.maxDate)) {
            result = undefined;
            break;
          }

          const FILTER_MAP = {
            text: 'searchMessagesFilterEmpty',
            media: 'searchMessagesFilterPhotoAndVideo',
            documents: 'searchMessagesFilterDocument',
            links: 'searchMessagesFilterUrl',
            audio: 'searchMessagesFilterAudio',
            voice: 'searchMessagesFilterVoiceNote',
            gif: 'searchMessagesFilterAnimation',
          };
          const filterType = FILTER_MAP[params && params.type] || 'searchMessagesFilterEmpty';

          try {
            const found = await client.invoke({
              _: 'searchMessages',
              chat_list: { _: 'chatListMain' },
              query,
              offset: String((params && params.nextOffset) || (params && params.offset) || ''),
              limit,
              filter: { _: filterType },
              min_date: Number((params && params.minDate) || 0),
              max_date: Number((params && params.maxDate) || 0),
            });

            const list = (found && found.messages) || [];
            for (const m of list) {
              try { await maybeFlattenRich(m, client); }
              catch (e) { console.error('[searchMessagesGlobal] richMessage flatten error:', e.message); }
            }

            const chatIds = Array.from(new Set(list.map((m) => m && m.chat_id).filter(Boolean).map(String)));
            const chats = [];
            await Promise.all(chatIds.map(async (chatId) => {
              try {
                const chat = await client.invoke({ _: 'getChat', chat_id: Number(chatId) });
                if (chat) chats.push(await buildApiChatWithStatus(client, chat, { activeAccountId }));
              } catch (e) {
                console.error('[searchMessagesGlobal] getChat failed chat_id', chatId, e.message);
              }
            }));

            const userIds = new Set();
            list.forEach((m) => {
              if (m && m.sender_id && m.sender_id._ === 'messageSenderUser' && m.sender_id.user_id) {
                userIds.add(m.sender_id.user_id);
              }
            });
            for (const chatId of chatIds) {
              const chat = chats.find((c) => String(c.id) === String(chatId));
              if (chat && chat.type === 'chatTypePrivate') userIds.add(Number(chat.id));
            }

            const users = [];
            await Promise.all(Array.from(userIds).map(async (uid) => {
              try {
                const user = await client.invoke({ _: 'getUser', user_id: uid });
                if (user) users.push(buildApiUserFromTdlibUser(user, activeAccountId));
              } catch (e) {
                console.error('[searchMessagesGlobal] getUser failed user_id', uid, e.message);
              }
            }));

            const messages = list.map((m) => buildSharedApiMessage(m, m.chat_id));
            const totalCount = (found && found.total_count) || messages.length;
            result = {
              messages,
              chats,
              users,
              totalCount,
              nextOffset: (found && found.next_offset) || '',
              userStatusesById: {},
            };
            console.log('[searchMessagesGlobal] query=' + query + ' type=' + (params && params.type || 'text') + ' filter=' + filterType + ' got=' + messages.length + ' total=' + totalCount + ' next=' + (result.nextOffset ? 'yes' : 'no'));
          } catch (e) {
            console.error('[searchMessagesGlobal] error:', e.message);
            result = null;
          }
          break;
        }
        case 'markMessageListRead':
        case 'markMessagesRead': {
          // v0.21: v2 callApi('markMessageListRead' | 'markMessagesRead') 활성 경로.
          // 이전까지 api:request switch 에 case 미등록 → default(null) 로 떨어져 TDLib
          // viewMessages 미발화 → PC 안읽음 전파 실패. tdlib/methods/init.ts:callApi 는
          // emitApiRequest 만 쓰므로 socketClient.markAsRead 경유 없이 직접 서버에서
          // viewMessages(force_read:true) 발화한다 (v1 markRead 핸들러와 동일 동작).
          try {
            const rChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
            let messageIds = (params && params.messageIds) || [];
            if (params && params.maxId) messageIds = [Number(params.maxId)];
            if (!rChatId || !messageIds.length) {
              console.log(`[v0.21 ${method}] noop chatId=${rChatId} ids=${messageIds.length}`);
              result = null;
              break;
            }
            const maxId = messageIds.reduce((a, b) => (a > b ? a : b), 0);
            await client.invoke({
              _: 'viewMessages',
              chat_id: rChatId,
              message_ids: messageIds,
              force_read: true,
            });
            console.log(`[v0.21 ${method}] chatId=${rChatId} count=${messageIds.length} max=${maxId}`);
            result = null;
          } catch (e) {
            console.error(`[v0.21 ${method}] error:`, e.message);
            result = null;
          }
          break;
        }
        case 'toggleDialogUnread': {
          // [040] v2 markChatRead → callApi('toggleDialogUnread', { chat, hasUnreadMark })
          // hasUnreadMark 가 "원하는 새 상태". 모두읽음 경로에서는 false 로 들어온다.
          try {
            const rChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
            if (rChatId) {
              await client.invoke({
                _: 'toggleChatIsMarkedAsUnread',
                chat_id: rChatId,
                is_marked_as_unread: Boolean(params && params.hasUnreadMark),
              });
              console.log(`[relay toggleDialogUnread] chatId=${rChatId} marked=${Boolean(params && params.hasUnreadMark)}`);
            }
            result = null;
          } catch (e) {
            console.error('[relay toggleDialogUnread] error:', e.message);
            result = null;
          }
          break;
        }
        case 'readAllMentions': {
          // [040] v2 readAllMentions → TDLib readAllChatMentions
          try {
            const rChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
            if (rChatId) {
              await client.invoke({ _: 'readAllChatMentions', chat_id: rChatId });
              console.log(`[relay readAllMentions] chatId=${rChatId}`);
            }
            result = null;
          } catch (e) {
            console.error('[relay readAllMentions] error:', e.message);
            result = null;
          }
          break;
        }
        case 'readAllReactions': {
          // [040] v2 readAllReactions → TDLib readAllChatReactions
          try {
            const rChatId = Number((params && params.chat && params.chat.id) || (params && params.chatId));
            if (rChatId) {
              await client.invoke({ _: 'readAllChatReactions', chat_id: rChatId });
              console.log(`[relay readAllReactions] chatId=${rChatId}`);
            }
            result = null;
          } catch (e) {
            console.error('[relay readAllReactions] error:', e.message);
            result = null;
          }
          break;
        }
        case 'getGroupMembers': {
          // [027] v2 그룹 정보 패널 참가자 탭 — fetchMembers → getGroupMembers 경유
          // 파라미터: { chatId, offset=0, limit=200 }
          // 반환: { total_count, members:[{userId,isAdmin?,isOwner?}], users:[<raw TDLib user>] }
          try {
            const gmChatId = Number(params && params.chatId);
            if (!gmChatId) { result = { total_count: 0, members: [], users: [] }; break; }

            const gmOffset = Number((params && params.offset) || 0);
            const gmLimit = Number((params && params.limit) || 200);

            const gmChat = await client.invoke({ _: 'getChat', chat_id: gmChatId });
            const gmType = gmChat && gmChat.type && gmChat.type._;

            const gmMembers = [];
            const gmUsers = [];
            let gmTotal = 0;

            if (gmType === 'chatTypeSupergroup') {
              const sgResult = await client.invoke({
                _: 'getSupergroupMembers',
                supergroup_id: gmChat.type.supergroup_id,
                filter: { _: 'supergroupMembersFilterRecent' },
                offset: gmOffset,
                limit: gmLimit,
              });
              gmTotal = (sgResult && sgResult.total_count) || 0;
              for (const m of (sgResult && sgResult.members || [])) {
                // TDLib 1.8.65: member_id.user_id; 구버전 폴백: m.user_id
                const uid = (m.member_id && m.member_id.user_id) || m.user_id;
                if (!uid) continue;
                try {
                  const u = await client.invoke({ _: 'getUser', user_id: uid });
                  gmMembers.push({
                    userId: String(u.id),
                    isAdmin: m.status && m.status._ === 'chatMemberStatusAdministrator' ? true : undefined,
                    isOwner: m.status && m.status._ === 'chatMemberStatusCreator' ? true : undefined,
                  });
                  gmUsers.push(u);
                } catch (_e) { /* 개별 user fetch 실패 스킵 */ }
              }
            } else if (gmType === 'chatTypeBasicGroup') {
              const bgResult = await client.invoke({
                _: 'getBasicGroupFullInfo',
                basic_group_id: gmChat.type.basic_group_id,
              });
              const allMembers = (bgResult && bgResult.members) || [];
              gmTotal = allMembers.length;
              const slice = allMembers.slice(gmOffset, gmOffset + gmLimit);
              for (const m of slice) {
                const uid = (m.member_id && m.member_id.user_id) || m.user_id;
                if (!uid) continue;
                try {
                  const u = await client.invoke({ _: 'getUser', user_id: uid });
                  gmMembers.push({
                    userId: String(u.id),
                    isAdmin: m.status && m.status._ === 'chatMemberStatusAdministrator' ? true : undefined,
                    isOwner: m.status && m.status._ === 'chatMemberStatusCreator' ? true : undefined,
                  });
                  gmUsers.push(u);
                } catch (_e) { /* 개별 user fetch 실패 스킵 */ }
              }
            }

            console.log(`[getGroupMembers] chatId=${gmChatId} type=${gmType} total=${gmTotal} fetched=${gmMembers.length}`);
            result = { total_count: gmTotal, members: gmMembers, users: gmUsers };
          } catch (e) {
            console.error('[getGroupMembers] error:', e.message);
            result = { total_count: 0, members: [], users: [] };
          }
          break;
        }
        default:
          console.log('[api:request] Unhandled method:', method);
          result = null;
      }
      socket.emit('api:response:' + id, { data: result });
    } catch (error) {
      console.error('[api:request] Error:', method, error.message);
      socket.emit('api:response:' + id, { error: { message: error.message || 'Unknown error' } });
    }
  });

  socket.on('disconnect', () => {
    console.log('클라이언트 연결 해제:', socket.id);
  });
});

// 헬스체크
app.get('/health', (req, res) => {
  const sockets = io.sockets.sockets;
  res.json({ 
    status: 'ok', 
    authorized: isAuthorized,
    authState: authState?._,
    connectedClients: sockets ? sockets.size : 0
  });
});

// v0.11: 다계정 진단 엔드포인트
app.get('/api/accounts', (req, res) => {
  const list = Object.values(ACCOUNTS).map(a => ({
    id: a.id, label: a.label, initialized: a.initialized,
    isAuthorized: a.isAuthorized, authState: a.authState?._ || null,
    active: a.id === activeAccountId,
  }));
  res.json({ activeAccountId, accounts: list });
});

// v0.9: 디버그 - 특정 채팅의 최근 메시지 raw 데이터
app.get('/api/debug/messages', async (req, res) => {
  try {
    if (!client || !isAuthorized) return res.status(401).json({ error: 'Not authorized' });
    const chatId = parseInt(req.query.chat_id);
    const limit = parseInt(req.query.limit) || 10;
    if (!chatId) return res.status(400).json({ error: 'chat_id required' });
    const fromId = parseInt(req.query.from_id) || 0;
    const messages = await client.invoke({
      _: 'getChatHistory', chat_id: chatId, from_message_id: fromId, offset: 0, limit
    });
    const msgs = messages.messages || [];
    // v0.56-tmp: ?raw=1 — messageRichMessage 원본 1건 전체 JSON 덤프(구조 박제용, 후속 제거 예정)
    if (req.query.raw === '1') {
      const rich = msgs.find(m => m.content?._ === 'messageRichMessage');
      if (!rich) return res.json({ note: 'no messageRichMessage in this batch', count: msgs.length });
      // Stage B-1: 평탄화/마크다운 재구성을 거쳐 content.text + content.rich_markdown 노출
      try { await maybeFlattenRich(rich, client); } catch (e) {}
      // 컨텐츠 트리만 반환(개인정보 최소화). is_full + blocks/richText _ 목록 추출 동봉.
      const collectKinds = (node, out) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(n => collectKinds(n, out)); return; }
        if (node._) out.add(node._);
        for (const k of Object.keys(node)) collectKinds(node[k], out);
      };
      const kinds = new Set();
      collectKinds(rich.content?.message, kinds);
      return res.json({
        id: rich.id,
        is_full: rich.content?.message?.is_full,
        kinds: Array.from(kinds).sort(),
        content: rich.content,
      });
    }
    // richMessage 항목에 대해 평탄화 시행 후 text 추출 (debug 가시화)
    for (const m of msgs) {
      try { await maybeFlattenRich(m, client); } catch (e) {}
    }
    const result = msgs.map(m => ({
      id: m.id,
      content_type: m.content?._,
      text: m.content?.text?.text?.substring(0, 100) || m.content?.caption?.text?.substring(0, 100) || '',
      forward_info: m.forward_info ? { origin: m.forward_info.origin?._ } : null,
      is_outgoing: m.is_outgoing,
      date: m.date
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// v0.8: 메시지 검색 API
app.get('/api/search', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }
    
    const { q, chat_id, limit = 30 } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }
    
    let result;
    if (chat_id) {
      // 특정 채팅 내 검색
      result = await client.invoke({
        _: 'searchChatMessages',
        chat_id: parseInt(chat_id),
        query: q,
        from_message_id: 0,
        offset: 0,
        limit: parseInt(limit),
        filter: null,
        message_thread_id: 0
      });
    } else {
      // 전체 채팅 검색
      result = await client.invoke({
        _: 'searchMessages',
        chat_list: { _: 'chatListMain' },
        query: q,
        offset: '',
        limit: parseInt(limit),
        filter: null,
        min_date: 0,
        max_date: 0
      });
    }
    
    // 메시지 포맷팅
    const messages = (result.messages || []).map(msg => ({
      id: msg.id,
      chat_id: msg.chat_id,
      date: new Date(msg.date * 1000).toISOString(),
      text: msg.content?.text?.text || msg.content?.caption?.text || '[미디어]',
      sender: msg.sender_id?.user_id || msg.sender_id?.chat_id
    }));
    
    res.json({ 
      total: result.total_count || messages.length,
      messages 
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// v1.4: TDLib 파일 다운로드 → 서빙 API (v2 사진 표시용)
app.get('/api/file/:fileId', async (req, res) => {
  try {
    // v0.17.3: 진단 — 사용자 클릭 시 호출 도착 여부 박제
    console.log('[api/file] req fileId=' + req.params.fileId + ' authorized=' + isAuthorized + ' client=' + (!!client));
    if (!client || !isAuthorized) return res.status(401).json({ error: 'Not authorized' });
    const fileId = parseInt(req.params.fileId);
    if (!fileId) return res.status(400).json({ error: 'Invalid fileId' });
    const file = await client.invoke({ _: 'downloadFile', file_id: fileId, priority: 1, synchronous: true });
    if (file.local?.path) {
      const fs = require('fs');
      if (fs.existsSync(file.local.path)) {
        console.log('[api/file] OK fileId=' + fileId + ' path=' + file.local.path);
        res.set('Cache-Control', 'public, max-age=86400');
        return res.sendFile(file.local.path);
      }
    }
    console.log('[api/file] not-found fileId=' + fileId + ' file.local.path=' + (file.local?.path || 'undefined'));
    res.status(404).json({ error: 'File not found' });
  } catch (err) {
    console.error('[api/file] error fileId=' + req.params.fileId + ' msg:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// v0.9: 채널 최근 사진 메시지 가져오기 API
app.get('/api/photos', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }
    
    const { chat_id, limit = 10, from_message_id = 0 } = req.query;
    if (!chat_id) {
      return res.status(400).json({ error: 'chat_id required' });
    }
    
    // 채널의 최근 사진 메시지 검색
    const result = await client.invoke({
      _: 'searchChatMessages',
      chat_id: parseInt(chat_id),
      query: '',
      from_message_id: parseInt(from_message_id),
      offset: 0,
      limit: parseInt(limit),
      filter: { _: 'searchMessagesFilterPhoto' },
      message_thread_id: 0
    });
    
    const photos = [];
    for (const msg of (result.messages || [])) {
      const sizes = msg.content?.photo?.sizes || [];
      // 가장 큰 사이즈 선택
      const bestSize = sizes[sizes.length - 1] || sizes[0];
      
      let imageBase64 = null;
      if (bestSize?.photo?.id) {
        try {
          const file = await client.invoke({
            _: 'downloadFile',
            file_id: bestSize.photo.id,
            priority: 1,
            synchronous: true
          });
          if (file.local?.path) {
            const fs = require('fs');
            const data = fs.readFileSync(file.local.path);
            imageBase64 = data.toString('base64');
          }
        } catch (e) { console.error('Photo download error:', e.message); }
      }
      
      photos.push({
        id: msg.id,
        date: new Date(msg.date * 1000).toISOString(),
        caption: msg.content?.caption?.text || '',
        image_base64: imageBase64
      });
    }
    
    res.json({ total: photos.length, photos });
  } catch (err) {
    console.error('Photos API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// v0.9.2: 채팅 이름 검색 API
app.get('/api/search-chats', async (req, res) => {
  try {
    if (!client || !isAuthorized) return res.status(401).json({ error: 'Not authorized' });
    const { q, limit = 10 } = req.query;
    const result = await client.invoke({ _: 'searchChats', query: q || '', limit: parseInt(limit) });
    const chats = [];
    for (const id of (result.chat_ids || [])) {
      try {
        const chat = await client.invoke({ _: 'getChat', chat_id: id });
        chats.push({ id: chat.id, title: chat.title, type: chat.type?._ });
      } catch(e) {}
    }
    res.json({ chats });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// v0.9.1: 공개 채널 resolve API
app.get('/api/resolve', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    
    const chat = await client.invoke({
      _: 'searchPublicChat',
      username: username
    });
    res.json({ chat_id: chat.id, title: chat.title, type: chat.type?._ });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// v0.8: 메시지 주변 컨텍스트 조회 API
app.get('/api/context', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }
    
    const { chat_id, message_id, before = 5, after = 5 } = req.query;
    if (!chat_id || !message_id) {
      return res.status(400).json({ error: 'chat_id and message_id required' });
    }
    
    // 메시지 ID 기준 앞뒤 메시지 조회
    const result = await client.invoke({
      _: 'getChatHistory',
      chat_id: parseInt(chat_id),
      from_message_id: parseInt(message_id),
      offset: -parseInt(after),  // 뒤로 (최신 방향)
      limit: parseInt(before) + parseInt(after) + 1
    });
    
    const messages = (result.messages || []).map(msg => ({
      id: msg.id,
      date: new Date(msg.date * 1000).toISOString(),
      text: msg.content?.text?.text || msg.content?.caption?.text || '[미디어]',
      sender: msg.sender_id?.user_id || msg.sender_id?.chat_id,
      is_target: msg.id === parseInt(message_id)
    }));
    
    res.json({ messages });
  } catch (err) {
    console.error('Context error:', err);
    res.status(500).json({ error: err.message });
  }
});

// v0.9: REST 메시지 발송 API (봇 멘션 응답용)
app.post('/api/send', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }
    
    const { chat_id, text, reply_to_message_id } = req.body;
    if (!chat_id || !text) {
      return res.status(400).json({ error: 'chat_id and text required' });
    }
    
    const sendOptions = {
      _: 'sendMessage',
      chat_id: parseInt(chat_id),
      input_message_content: {
        _: 'inputMessageText',
        text: { _: 'formattedText', text }
      }
    };
    
    if (reply_to_message_id) {
      sendOptions.reply_to = {
        _: 'inputMessageReplyToMessage',
        message_id: parseInt(reply_to_message_id)
      };
    }
    
    const result = await client.invoke(sendOptions);
    res.json({ ok: true, message_id: result.id });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// v0.9: REST 최근 메시지 조회 API
app.get('/api/history', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }
    
    const { chat_id, limit = 10 } = req.query;
    if (!chat_id) {
      return res.status(400).json({ error: 'chat_id required' });
    }
    
    const result = await client.invoke({
      _: 'getChatHistory',
      chat_id: parseInt(chat_id),
      from_message_id: 0,
      offset: 0,
      limit: parseInt(limit)
    });
    
    const messages = (result.messages || []).map(msg => ({
      id: msg.id,
      date: new Date(msg.date * 1000).toISOString(),
      text: msg.content?.text?.text || msg.content?.caption?.text || '[미디어]',
      sender: msg.sender_id?.user_id || msg.sender_id?.chat_id
    }));
    
    res.json({ messages });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 채팅 읽음 상태 확인 API
app.get('/api/chat-status', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }
    const { chat_id } = req.query;
    if (!chat_id) {
      return res.status(400).json({ error: 'chat_id required' });
    }
    const chat = await client.invoke({ _: 'getChat', chat_id: parseInt(chat_id) });
    res.json({
      chat_id: chat.id,
      title: chat.title,
      last_read_outbox_message_id: chat.last_read_outbox_message_id,
      last_read_inbox_message_id: chat.last_read_inbox_message_id,
      last_message_id: chat.last_message?.id,
      last_message_date: chat.last_message ? new Date(chat.last_message.date * 1000).toISOString() : null,
      unread_count: chat.unread_count
    });
  } catch (err) {
    console.error('Chat status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ User Status API ============
app.get('/api/user-status', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id required' });
    }
    const user = await client.invoke({ _: 'getUser', user_id: parseInt(user_id) });
    const status = user.status || {};
    let result = {
      user_id: user.id,
      first_name: user.first_name,
      last_name: user.last_name || '',
      username: user.usernames?.active_usernames?.[0] || '',
      status_type: status._,
    };
    if (status._ === 'userStatusOnline') {
      result.online = true;
      result.expires = new Date(status.expires * 1000).toISOString();
    } else if (status._ === 'userStatusOffline') {
      result.online = false;
      result.was_online = new Date(status.was_online * 1000).toISOString();
    } else if (status._ === 'userStatusRecently') {
      result.online = false;
      result.was_online = 'recently';
    } else if (status._ === 'userStatusLastWeek') {
      result.online = false;
      result.was_online = 'last_week';
    } else if (status._ === 'userStatusLastMonth') {
      result.online = false;
      result.was_online = 'last_month';
    } else {
      result.online = false;
      result.was_online = 'unknown';
    }
    res.json(result);
  } catch (err) {
    console.error('User status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============ Archive API (Phase 1 + 2) ============

// Archive target chat IDs. Empty by default; set TARGET_CHATS as comma-separated chat IDs to enable collection.
const TARGET_CHATS = (process.env.TARGET_CHATS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);

// Phase 1: 신규 메시지 수집 (크론용)
app.get('/api/archive/collect', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }

    const results = [];
    for (const chatId of TARGET_CHATS) {
      try {
        const lastId = archive.getLatestArchivedId(chatId);
        console.log(`[Collect] chat_id=${chatId} — DB 마지막 ID: ${lastId}`);

        // 최신 메시지부터 가져와서 lastId 이후 것만 필터링
        const response = await client.invoke({
          _: 'getChatHistory',
          chat_id: chatId,
          from_message_id: 0,
          offset: 0,
          limit: 100
        });

        const allMessages = response.messages || [];
        const messages = lastId ? allMessages.filter(m => m.id > lastId) : allMessages;
        console.log(`[Collect] chat_id=${chatId} — fetched=${allMessages.length}, new=${messages.length}`);
        if (messages.length === 0) {
          results.push({ chat_id: chatId, collected: allMessages.length, inserted: 0, latest_id: lastId });
          continue;
        }

        // 메시지 변환 (sender_name 조회)
        const archiveData = [];
        for (const msg of messages) {
          let senderName = null;
          if (msg.sender_id?.user_id) {
            try {
              const user = await client.invoke({ _: 'getUser', user_id: msg.sender_id.user_id });
              senderName = user.first_name + (user.last_name ? ' ' + user.last_name : '');
            } catch (e) {}
          }

          archiveData.push({
            message_id: msg.id,
            chat_id: chatId,
            sender_id: msg.sender_id?.user_id || null,
            sender_name: senderName,
            date: msg.date,
            text: msg.content?.text?.text || msg.content?.caption?.text || null,
            reply_to_id: msg.reply_to?.message_id || null,
            media_type: msg.content?._ === 'messagePhoto' ? 'photo' :
                        msg.content?._ === 'messageVideo' ? 'video' :
                        msg.content?._ === 'messageDocument' ? 'document' : null,
            raw_json: msg
          });
        }

        const inserted = archive.archiveMessages(chatId, archiveData);
        const latestId = Math.max(...messages.map(m => m.id));
        results.push({ chat_id: chatId, collected: messages.length, inserted, latest_id: latestId });

      } catch (e) {
        console.error(`[Collect] chat_id=${chatId} 실패:`, e.message);
        results.push({ chat_id: chatId, error: e.message });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error('[Collect] 전체 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// Phase 1: 전체 과거 대화 백필
app.get('/api/archive/backfill', async (req, res) => {
  try {
    if (!client || !isAuthorized) {
      return res.status(401).json({ error: 'Not authorized' });
    }

    const chatId = parseInt(req.query.chat_id);
    if (!chatId || !TARGET_CHATS.includes(chatId)) {
      return res.status(400).json({ error: 'Invalid chat_id' });
    }

    // 비동기 백필 시작 (응답은 즉시 반환)
    res.json({ ok: true, message: '백필 시작됨 (비동기)', chat_id: chatId });

    (async () => {
      let fromMessageId = 0;
      let totalCollected = 0;
      let iteration = 0;

      console.log(`[Backfill] chat_id=${chatId} 시작`);

      while (true) {
        iteration++;
        try {
          const response = await client.invoke({
            _: 'getChatHistory',
            chat_id: chatId,
            from_message_id: fromMessageId,
            offset: 0,
            limit: 100
          });

          const messages = response.messages || [];
          if (messages.length === 0) {
            console.log(`[Backfill] chat_id=${chatId} 완료 — 총 ${totalCollected}개`);
            break;
          }

          // 메시지 변환
          const archiveData = [];
          for (const msg of messages) {
            let senderName = null;
            if (msg.sender_id?.user_id) {
              try {
                const user = await client.invoke({ _: 'getUser', user_id: msg.sender_id.user_id });
                senderName = user.first_name + (user.last_name ? ' ' + user.last_name : '');
              } catch (e) {}
            }

            archiveData.push({
              message_id: msg.id,
              chat_id: chatId,
              sender_id: msg.sender_id?.user_id || null,
              sender_name: senderName,
              date: msg.date,
              text: msg.content?.text?.text || msg.content?.caption?.text || null,
              reply_to_id: msg.reply_to?.message_id || null,
              media_type: msg.content?._ === 'messagePhoto' ? 'photo' :
                          msg.content?._ === 'messageVideo' ? 'video' :
                          msg.content?._ === 'messageDocument' ? 'document' : null,
              raw_json: msg
            });
          }

          const inserted = archive.archiveMessages(chatId, archiveData);
          totalCollected += inserted;
          fromMessageId = messages[messages.length - 1].id;

          console.log(`[Backfill] chat_id=${chatId} iter=${iteration} — ${inserted}개 저장, 누적=${totalCollected}, next_from=${fromMessageId}`);

          // 너무 빠른 요청 방지
          await new Promise(r => setTimeout(r, 100));

        } catch (e) {
          console.error(`[Backfill] chat_id=${chatId} iter=${iteration} 에러:`, e.message);
          break;
        }
      }
    })();

  } catch (err) {
    console.error('[Backfill] 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// Phase 2: 전문검색
app.get('/api/archive/search', (req, res) => {
  try {
    const { q, chat_id, limit = 20, from_date, to_date } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Query "q" required' });
    }

    const results = archive.searchMessages(
      q,
      chat_id ? parseInt(chat_id) : null,
      parseInt(limit),
      from_date || null,
      to_date || null
    );

    res.json({ total: results.length, messages: results });
  } catch (err) {
    console.error('[Archive Search] 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// Phase 2: 시간순 조회
app.get('/api/archive/history', (req, res) => {
  try {
    const { chat_id, from_date, to_date, sender_id, limit = 50, offset = 0 } = req.query;
    if (!chat_id) {
      return res.status(400).json({ error: 'chat_id required' });
    }

    const results = archive.getHistory(
      parseInt(chat_id),
      from_date || null,
      to_date || null,
      sender_id ? parseInt(sender_id) : null,
      parseInt(limit),
      parseInt(offset)
    );

    res.json({ total: results.length, messages: results });
  } catch (err) {
    console.error('[Archive History] 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// Phase 2: 메시지 전후 문맥
app.get('/api/archive/context/:id', (req, res) => {
  try {
    const { chat_id, range = 10 } = req.query;
    const messageId = parseInt(req.params.id);

    if (!chat_id) {
      return res.status(400).json({ error: 'chat_id required' });
    }

    const results = archive.getContext(
      parseInt(chat_id),
      messageId,
      parseInt(range)
    );

    res.json({ total: results.length, messages: results });
  } catch (err) {
    console.error('[Archive Context] 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// Phase 2: 통계
app.get('/api/archive/stats', (req, res) => {
  try {
    const { chat_id } = req.query;
    const stats = archive.getStats(chat_id ? parseInt(chat_id) : null);
    res.json({ stats });
  } catch (err) {
    console.error('[Archive Stats] 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// 서버 시작

// 초대링크로 채널 정보 확인 + 참여
app.get('/api/check-invite', async (req, res) => {
  try {
    if (!client || !isAuthorized) return res.status(401).json({ error: 'Not authorized' });
    const { link } = req.query;
    if (!link) return res.status(400).json({ error: 'link required' });
    
    try {
      const info = await client.invoke({ _: 'checkChatInviteLink', invite_link: link });
      res.json({ action: 'check', info });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/join-invite', async (req, res) => {
  try {
    if (!client || !isAuthorized) return res.status(401).json({ error: 'Not authorized' });
    const { link } = req.body;
    if (!link) return res.status(400).json({ error: 'link required' });
    
    try {
      const chat = await client.invoke({ _: 'joinChatByInviteLink', invite_link: link });
      res.json({ chat_id: chat.id, title: chat.title, type: chat.type?._ });
    } catch (e) {
      // 이미 가입된 경우
      if (e.message && e.message.includes('USER_ALREADY_PARTICIPANT')) {
        // checkChatInviteLink로 정보 확인
        const info = await client.invoke({ _: 'checkChatInviteLink', invite_link: link });
        res.json({ chat_id: info.chat_id, already_member: true, info });
      } else {
        res.status(400).json({ error: e.message });
      }
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});


if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, { flattenRichMessage });
}

server.listen(PORT, () => {
  console.log(`Telegram Web Proxy running on port ${PORT}`);
  initTdlib();
});
