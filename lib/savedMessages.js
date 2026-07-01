// Saved Messages (저장된 메시지) 식별 순수 헬퍼
// 외부 의존성 없음 — 단위 테스트(tests/saved-messages.test.js) 대상.
//
// 본인과의 1:1 채팅(chatTypePrivate 이고 상대 user_id 가 본인 user_id)인 경우
// 텔레그램 공식 "저장된 메시지" 로 표시하도록 chat 객체에 표시용 필드를 부여한다.
// 원본 chat.title 은 변조하지 않고 _displayTitle 신규 필드로 분리한다.
//
// @param {object} chat       TDLib chat 객체 (변형됨, 반환값과 동일 참조)
// @param {number} myUserId   본인 user_id (없으면 null/undefined → 절대 saved 로 마킹하지 않음)
// @returns {object} 동일 chat 객체 (_isSavedMessages, _displayTitle 부여)
function markSavedMessages(chat, myUserId) {
  if (myUserId && chat && chat.type && chat.type._ === 'chatTypePrivate'
      && chat.type.user_id === myUserId) {
    chat._isSavedMessages = true;
    chat._displayTitle = '저장된 메시지';
  } else {
    chat._isSavedMessages = false;
    chat._displayTitle = chat ? chat.title : undefined;
  }
  return chat;
}

module.exports = { markSavedMessages };
