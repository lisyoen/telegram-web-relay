/**
 * chat-archive.js — 텔레그램 대화 아카이브 DB 모듈
 * 기획서: memory/telegram-chat-db-proposal.md
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.ARCHIVE_DB_PATH
  ? path.resolve(process.env.ARCHIVE_DB_PATH)
  : path.join(__dirname, 'db', 'chat-archive.sqlite');

let db;

// DB 초기화 (서버 시작 시 자동 호출)
function init() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      sender_id INTEGER,
      sender_name TEXT,
      date INTEGER NOT NULL,
      text TEXT,
      reply_to_id INTEGER,
      media_type TEXT,
      raw_json TEXT,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_date ON messages(chat_id, date);
    CREATE INDEX IF NOT EXISTS idx_sender ON messages(sender_id, date);
  `);

  // FTS5 전문검색 테이블
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        content=messages,
        content_rowid=rowid,
        tokenize='unicode61'
      );
    `);
  } catch (e) {
    console.log('[archive] FTS5 note:', e.message);
  }

  console.log('[archive] DB initialized:', DB_PATH);
  return db;
}

// 자동 초기화
init();

// ============ 수집 API ============

function archiveMessages(chatId, messages) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO messages (message_id, chat_id, sender_id, sender_name, date, text, reply_to_id, media_type, raw_json)
    VALUES (@message_id, @chat_id, @sender_id, @sender_name, @date, @text, @reply_to_id, @media_type, @raw_json)
  `);

  const insertFts = db.prepare(`
    INSERT OR IGNORE INTO messages_fts(rowid, text)
    SELECT rowid, text FROM messages WHERE chat_id = ? AND message_id = ? AND text IS NOT NULL
  `);

  let count = 0;
  const tx = db.transaction((msgs) => {
    for (const msg of msgs) {
      const result = insert.run({
        message_id: msg.message_id,
        chat_id: msg.chat_id,
        sender_id: msg.sender_id,
        sender_name: msg.sender_name,
        date: msg.date,
        text: msg.text,
        reply_to_id: msg.reply_to_id,
        media_type: msg.media_type,
        raw_json: typeof msg.raw_json === 'string' ? msg.raw_json : JSON.stringify(msg.raw_json),
      });
      if (result.changes > 0) {
        count++;
        if (msg.text) {
          try { insertFts.run(msg.chat_id, msg.message_id); } catch(e) {}
        }
      }
    }
  });

  tx(messages);
  return count;
}

function getLatestArchivedId(chatId) {
  const row = db.prepare('SELECT MAX(message_id) as max_id FROM messages WHERE chat_id = ?').get(chatId);
  return row?.max_id || 0;
}

// ============ 검색 API ============

function searchMessages(q, chatId, limit = 20, fromDate = null, toDate = null) {
  let sql = `
    SELECT m.message_id, m.chat_id, m.sender_id, m.sender_name, m.date, m.text, m.reply_to_id, m.media_type
    FROM messages m
    JOIN messages_fts f ON f.rowid = m.rowid
    WHERE messages_fts MATCH ?
  `;
  const params = [q];

  if (chatId) { sql += ' AND m.chat_id = ?'; params.push(chatId); }
  if (fromDate) { sql += ' AND m.date >= ?'; params.push(Math.floor(new Date(fromDate).getTime() / 1000)); }
  if (toDate) { sql += ' AND m.date <= ?'; params.push(Math.floor(new Date(toDate).getTime() / 1000)); }

  sql += ' ORDER BY m.date DESC LIMIT ?';
  params.push(limit);

  try {
    return db.prepare(sql).all(...params).map(formatRow);
  } catch(e) {
    // FTS 매칭 실패 시 LIKE 폴백
    console.log('[archive] FTS failed, falling back to LIKE:', e.message);
    return searchMessagesLike(q, chatId, limit, fromDate, toDate);
  }
}

function searchMessagesLike(q, chatId, limit, fromDate, toDate) {
  let sql = 'SELECT message_id, chat_id, sender_id, sender_name, date, text, reply_to_id, media_type FROM messages WHERE text LIKE ?';
  const params = [`%${q}%`];

  if (chatId) { sql += ' AND chat_id = ?'; params.push(chatId); }
  if (fromDate) { sql += ' AND date >= ?'; params.push(Math.floor(new Date(fromDate).getTime() / 1000)); }
  if (toDate) { sql += ' AND date <= ?'; params.push(Math.floor(new Date(toDate).getTime() / 1000)); }

  sql += ' ORDER BY date DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map(formatRow);
}

function getHistory(chatId, fromDate = null, toDate = null, senderId = null, limit = 50, offset = 0) {
  let sql = 'SELECT message_id, chat_id, sender_id, sender_name, date, text, reply_to_id, media_type FROM messages WHERE chat_id = ?';
  const params = [chatId];

  if (senderId) { sql += ' AND sender_id = ?'; params.push(senderId); }
  if (fromDate) { sql += ' AND date >= ?'; params.push(Math.floor(new Date(fromDate).getTime() / 1000)); }
  if (toDate) { sql += ' AND date <= ?'; params.push(Math.floor(new Date(toDate).getTime() / 1000)); }

  sql += ' ORDER BY date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(formatRow);
}

function getContext(chatId, messageId, range = 10) {
  // 대상 메시지의 date 기준 전후
  const target = db.prepare(
    'SELECT * FROM messages WHERE chat_id = ? AND message_id = ?'
  ).get(chatId, messageId);

  if (!target) return [];

  const messages = db.prepare(`
    SELECT message_id, chat_id, sender_id, sender_name, date, text, reply_to_id, media_type
    FROM messages
    WHERE chat_id = ? AND date BETWEEN ? AND ?
    ORDER BY date ASC, message_id ASC
    LIMIT ?
  `).all(
    chatId,
    target.date - (range * 60), // range분 전
    target.date + (range * 60), // range분 후
    range * 2 + 1
  );

  return messages.map(formatRow);
}

function getStats(chatId = null) {
  if (chatId) {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?').get(chatId);
    const oldest = db.prepare('SELECT MIN(date) as d FROM messages WHERE chat_id = ?').get(chatId);
    const newest = db.prepare('SELECT MAX(date) as d FROM messages WHERE chat_id = ?').get(chatId);
    const senders = db.prepare(
      'SELECT sender_name, COUNT(*) as cnt FROM messages WHERE chat_id = ? AND sender_name IS NOT NULL GROUP BY sender_name ORDER BY cnt DESC LIMIT 20'
    ).all(chatId);

    return {
      chat_id: chatId,
      total_messages: total.cnt,
      oldest: oldest.d ? new Date(oldest.d * 1000).toISOString() : null,
      newest: newest.d ? new Date(newest.d * 1000).toISOString() : null,
      top_senders: senders,
    };
  } else {
    const chats = db.prepare(
      'SELECT chat_id, COUNT(*) as cnt, MIN(date) as oldest, MAX(date) as newest FROM messages GROUP BY chat_id'
    ).all();

    return {
      total_chats: chats.length,
      total_messages: chats.reduce((s, c) => s + c.cnt, 0),
      chats: chats.map(c => ({
        chat_id: c.chat_id,
        total_messages: c.cnt,
        oldest: c.oldest ? new Date(c.oldest * 1000).toISOString() : null,
        newest: c.newest ? new Date(c.newest * 1000).toISOString() : null,
      })),
    };
  }
}

// ============ 유틸 ============

function formatRow(row) {
  return {
    message_id: row.message_id,
    chat_id: row.chat_id,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    date: new Date(row.date * 1000).toISOString(),
    date_unix: row.date,
    text: row.text,
    reply_to_id: row.reply_to_id,
    media_type: row.media_type,
  };
}

module.exports = {
  archiveMessages,
  getLatestArchivedId,
  searchMessages,
  getHistory,
  getContext,
  getStats,
};
