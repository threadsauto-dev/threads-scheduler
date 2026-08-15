// TIME BOX: 채널마다 등록해둔 고정 시간표(channel_slots)를 기준으로, 아직 안 채워진
// 다음 슬롯을 찾아 발행 시각을 추천한다. 매일 같은 시간표가 반복된다는 전제.
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SEARCH_DAYS = 14; // 이 기간 안에 빈 슬롯을 못 찾으면 포기(슬롯 자체가 없거나 너무 꽉 찬 경우)
const OCCUPIED_WINDOW_MIN = 15; // 슬롯 나온 시각 기준 ±15분 안에 이미 예약이 있으면 "그 슬롯은 찼다"고 봄
const JITTER_MIN = 10; // ±10분

function toKstParts(date) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    dateStr: kst.toISOString().slice(0, 10),
    minutesOfDay: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
  };
}

// 특정 채널·태그의 다음 빈 슬롯을 찾아 { dateStr, hour, minute }(KST)로 돌려준다.
// 슬롯이 하나도 등록 안 됐거나(설정 안 함) 검색 기간 안에 빈 슬롯이 없으면 null.
async function getNextAvailableSlot(pool, channelId, tag) {
  const { rows: slots } = await pool.query(
    `SELECT slot_time FROM channel_slots WHERE channel_id = $1 AND slot_type = $2 ORDER BY slot_time`,
    [channelId, tag]
  );
  if (slots.length === 0) return null;

  const { rows: existing } = await pool.query(
    `SELECT scheduled_at FROM scheduled_posts
     WHERE channel_id = $1 AND status != 'canceled'
       AND scheduled_at > now() - interval '1 day' AND scheduled_at < now() + interval '${SEARCH_DAYS + 1} days'`,
    [channelId]
  );
  const occupied = existing.map((r) => toKstParts(new Date(r.scheduled_at)));

  const now = new Date();
  const todayStartKst = new Date(now.getTime() + KST_OFFSET_MS);
  todayStartKst.setUTCHours(0, 0, 0, 0);

  for (let dayOffset = 0; dayOffset < SEARCH_DAYS; dayOffset++) {
    const dateStr = new Date(todayStartKst.getTime() + dayOffset * DAY_MS).toISOString().slice(0, 10);

    for (const slot of slots) {
      const [h, m] = slot.slot_time.slice(0, 5).split(':').map(Number);
      const minutesOfDay = h * 60 + m;
      const candidateMs = Date.parse(`${dateStr}T00:00:00+09:00`) + minutesOfDay * 60000;
      if (candidateMs < now.getTime() - 5000) continue; // 이미 지난 슬롯

      const takenNearby = occupied.some(
        (o) => o.dateStr === dateStr && Math.abs(o.minutesOfDay - minutesOfDay) < OCCUPIED_WINDOW_MIN
      );
      if (takenNearby) continue;

      const jitterMs = Math.round((Math.random() * 2 - 1) * JITTER_MIN) * 60000;
      let finalMs = candidateMs + jitterMs;
      // 지터 때문에 과거로 밀려나는(임박한 슬롯 + 음수 지터) 경우 최소 1분 뒤로 당김
      if (finalMs < now.getTime() + 60000) finalMs = now.getTime() + 60000;

      const finalKst = toKstParts(new Date(finalMs));
      return {
        dateStr: finalKst.dateStr,
        hour: String(Math.floor(finalKst.minutesOfDay / 60)).padStart(2, '0'),
        minute: String(finalKst.minutesOfDay % 60).padStart(2, '0'),
      };
    }
  }
  return null;
}

// 채널 목록 화면에 "오늘 슬롯 몇 개 중 몇 개 남았는지" 보여주기 위한 집계.
// 반환: { 정보성: { total, remaining }, 광고용: { total, remaining } }
async function getTodaySlotSummary(pool, channelId) {
  const { rows: slots } = await pool.query(
    `SELECT slot_time, slot_type FROM channel_slots WHERE channel_id = $1`,
    [channelId]
  );
  const { rows: existing } = await pool.query(
    `SELECT scheduled_at FROM scheduled_posts
     WHERE channel_id = $1 AND status != 'canceled'
       AND (scheduled_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
    [channelId]
  );
  const occupiedMinutes = existing.map((r) => toKstParts(new Date(r.scheduled_at)).minutesOfDay);

  const summary = { 정보성: { total: 0, remaining: 0 }, 광고용: { total: 0, remaining: 0 } };
  for (const slot of slots) {
    const [h, m] = slot.slot_time.slice(0, 5).split(':').map(Number);
    const minutesOfDay = h * 60 + m;
    const bucket = summary[slot.slot_type];
    bucket.total += 1;
    const taken = occupiedMinutes.some((mo) => Math.abs(mo - minutesOfDay) < OCCUPIED_WINDOW_MIN);
    if (!taken) bucket.remaining += 1;
  }
  return summary;
}

module.exports = { getNextAvailableSlot, getTodaySlotSummary };
