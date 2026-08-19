// 하루 예약 스케줄러 (2026-08 재설계).
//
// 예전 방식: 채널마다 고정된 시간표(channel_slots, 예: "09:45 광고용")를 등록해두고 매일
// 그대로 반복. 문제는 두 가지였다 — (1) 정보성/광고성 배치가 날마다 완전히 똑같은 템플릿으로
// 반복돼서 자동화 티가 났고, (2) 채널별로만 시간을 흩어놨지 여러 채널을 합친 전체로 보면
// API 호출이 거의 쉬지 않고 이어지는 모양이 될 수 있었다.
//
// 새 방식: 채널마다 "하루에 광고성 몇 개·정보성 몇 개"라는 목표 개수만 설정해두고
// (channel_daily_targets), 실제 시각은 매번 이 파일이 그날그날 새로 무작위 배정한다.
// - 정보성은 사람이 몰리는 시간대(08-10/12-14/17-22)를 아예 피해서 배정
// - 광고성은 그 시간대를 최우선으로 채우고, 다 차면 다음 우선순위 시간대로 넘어감
// - 다른 채널과는 최소 GLOBAL_MIN_GAP_MIN분, 같은 채널 자기 글끼리는 그보다 더 넉넉한
//   CHANNEL_MIN_GAP_MIN분 이상 떨어지게 배정 — 채널 수가 늘어나도 전체적으로 API 호출이
//   촘촘하게 몰리지 않게 하고, 한 채널만 보더라도 시간이 뭉치지 않게 하기 위함. 이 간격을
//   지키면서 하루 안에 다 못 넣을 만큼 물량이 많으면(예: 채널당 요청 개수가 과함) 억지로
//   욱여넣지 않고 다음 날로 자연스럽게 넘어간다 — 그게 오히려 원하는 동작이다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_DAYS = 14; // 이 기간 안에 자리를 못 찾으면 포기(물량이 감당 못 할 만큼 많은 경우)
const GLOBAL_MIN_GAP_MIN = 15; // 채널 불문, 어떤 두 예약도 이보다 가깝게는 안 잡음
const CHANNEL_MIN_GAP_MIN = 40; // 같은 채널 자기 글끼리는 이보다 더 넉넉하게
const PLACEMENT_ATTEMPTS = 50; // 한 시간대(윈도우) 안에서 빈자리를 찾기 위한 무작위 재시도 횟수

// 사람이 스레드를 많이 하는 시간대 — 광고성이 최우선으로 차지하고, 정보성은 아예 피한다.
const PEAK_WINDOWS = [
  [8 * 60, 10 * 60],
  [12 * 60, 14 * 60],
  [17 * 60, 22 * 60],
];
// 차선책 시간대 — 광고성이 피크에 다 못 들어갈 때 다음으로 채우는 곳.
const SECONDARY_WINDOWS = [
  [10 * 60, 12 * 60],
  [14 * 60, 17 * 60],
];
// 나머지(심야/새벽) — 광고성의 마지막 순위, 정보성은 여기도 자유롭게 쓸 수 있음.
const OFFPEAK_WINDOWS = [
  [0, 8 * 60],
  [22 * 60, 24 * 60],
];

// 태그별로 "어느 시간대를 어떤 우선순위로 시도할지"의 순서.
// 정보성은 우선순위 구분 없이 피크만 아니면 다 되니 한 묶음(1순위)으로 합쳐서 넣는다.
function windowTiersForTag(tag) {
  if (tag === '정보성') return [[...SECONDARY_WINDOWS, ...OFFPEAK_WINDOWS]];
  return [PEAK_WINDOWS, SECONDARY_WINDOWS, OFFPEAK_WINDOWS];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Date 객체(실제 시각)를 KST 기준 "그날 몇 분째"로 변환. 서버가 어떤 타임존에서 돌든
// 결과가 항상 같도록 UTC 게터만 쓴다(로컬 게터를 쓰면 서버 로컬 타임존이 끼어드는 문제가
// 이 프로젝트에서 실제로 있었다).
function minutesOfDayKst(date) {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

// "YYYY-MM-DD"(KST) 문자열 + 분(0~1439)을 실제 시각(ms epoch)으로.
function kstDateAndMinutesToMs(dateStr, minutesOfDay) {
  return Date.parse(`${dateStr}T00:00:00+09:00`) + minutesOfDay * 60000;
}

// 오늘(또는 검색 시작일)부터 dayOffset일 뒤의 KST 날짜 문자열.
function addDaysKst(startDateStr, dayOffset) {
  const startMs = Date.parse(`${startDateStr}T00:00:00+09:00`);
  const target = new Date(startMs + dayOffset * DAY_MS + KST_OFFSET_MS);
  return `${target.getUTCFullYear()}-${pad2(target.getUTCMonth() + 1)}-${pad2(target.getUTCDate())}`;
}

function todayKstDateStr() {
  const kst = new Date(Date.now() + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(kst.getUTCDate())}`;
}

// 윈도우 묶음(예: [[480,600],[720,840]]) 안에서, occupiedEntries(그날 이미 잡힌 다른
// 예약들의 {minute, minGap} 목록 — minGap은 항목마다 다를 수 있다: 같은 채널 자기 글이면
// CHANNEL_MIN_GAP_MIN, 다른 채널이면 GLOBAL_MIN_GAP_MIN)와 간격을 지키는 무작위 지점을
// 찾는다. minAllowedMinutes를 주면 그보다 이른 시각은 후보에서 제외(오늘 검색 중 이미
// 지난 시각을 거르기 위함).
function pickMinuteInWindows(windows, occupiedEntries, minAllowedMinutes) {
  const totalLen = windows.reduce((sum, [s, e]) => sum + (e - s), 0);
  if (totalLen <= 0) return null;
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    let offset = Math.floor(Math.random() * totalLen);
    let minute = null;
    for (const [s, e] of windows) {
      const len = e - s;
      if (offset < len) {
        minute = s + offset;
        break;
      }
      offset -= len;
    }
    if (minute === null) continue;
    if (minAllowedMinutes != null && minute < minAllowedMinutes) continue;
    const tooClose = occupiedEntries.some((o) => Math.abs(o.minute - minute) < o.minGap);
    if (tooClose) continue;
    return minute;
  }
  return null;
}

// 특정 KST 날짜에 이미 잡혀 있는 모든 예약(채널 불문, 취소 제외)의 {channelId, tag, minutesOfDay} 목록.
// 전역 최소 간격 체크와 채널별 오늘 사용량 집계를 이 한 번의 조회로 같이 해결한다.
async function loadDaySchedule(pool, dateStr) {
  const { rows } = await pool.query(
    `SELECT channel_id, tag, scheduled_at FROM scheduled_posts
     WHERE status != 'canceled' AND (scheduled_at AT TIME ZONE 'Asia/Seoul')::date = $1::date`,
    [dateStr]
  );
  return rows.map((r) => ({
    channelId: r.channel_id,
    tag: r.tag,
    minutesOfDay: minutesOfDayKst(new Date(r.scheduled_at)),
  }));
}

async function loadTargets(pool) {
  const { rows } = await pool.query('SELECT channel_id, ad_count, info_count FROM channel_daily_targets');
  const map = new Map();
  for (const r of rows) map.set(r.channel_id, { 광고용: r.ad_count, 정보성: r.info_count });
  return map;
}

function targetFor(targetsMap, channelId, tag) {
  const t = targetsMap.get(channelId);
  return t ? t[tag] || 0 : 0;
}

// 그날 태그별로 채널마다 이미 몇 개 잡혀 있는지.
function usedCountByChannel(daySchedule, tag) {
  const map = new Map();
  for (const row of daySchedule) {
    if (row.tag !== tag) continue;
    map.set(row.channelId, (map.get(row.channelId) || 0) + 1);
  }
  return map;
}

// 연결된 모든 채널 중, 그날 그 태그로 아직 목표를 못 채운 채널들을 "남은 개수 많은 순"으로.
// 목표를 가장 많이 남긴 채널부터 채워야 하루가 끝날 때쯤 채널 간 배분이 고르게 맞는다.
function eligibleChannelsDesc(connectedChannelIds, targetsMap, usedMap, tag) {
  return connectedChannelIds
    .map((id) => ({ id, remaining: targetFor(targetsMap, id, tag) - (usedMap.get(id) || 0) }))
    .filter((c) => c.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining || a.id - b.id);
}

async function connectedChannelIds(pool) {
  const { rows } = await pool.query('SELECT id FROM channels WHERE disconnected_at IS NULL');
  return rows.map((r) => r.id);
}

// 태그 하나에 대해, fromDateStr부터 최대 SEARCH_DAYS일 안에서 "어느 채널·언제"로 배정할지
// 찾는다. channelId를 주면 그 채널로 한정, 안 주면(null) 남은 목표가 가장 많은 채널을 고른다.
// 반환: { channelId, dateStr, hour, minute } 또는 자리를 못 찾으면 null.
async function findSlot(pool, tag, channelId, fromDateStr) {
  const startDateStr = fromDateStr || todayKstDateStr();
  const allConnected = await connectedChannelIds(pool);
  const targetsMap = await loadTargets(pool);
  const now = Date.now();

  for (let dayOffset = 0; dayOffset < SEARCH_DAYS; dayOffset++) {
    const dateStr = addDaysKst(startDateStr, dayOffset);
    const isToday = dayOffset === 0 && dateStr === todayKstDateStr();
    const minAllowedMinutes = isToday ? minutesOfDayKst(new Date(now + 60000)) : null;

    const daySchedule = await loadDaySchedule(pool, dateStr);
    const usedMap = usedCountByChannel(daySchedule, tag);

    let pickedChannelId;
    if (channelId) {
      const remaining = targetFor(targetsMap, channelId, tag) - (usedMap.get(channelId) || 0);
      if (remaining <= 0) continue;
      pickedChannelId = channelId;
    } else {
      const eligible = eligibleChannelsDesc(allConnected, targetsMap, usedMap, tag);
      if (eligible.length === 0) continue;
      pickedChannelId = eligible[0].id;
    }

    const occupiedEntries = daySchedule.map((r) => ({
      minute: r.minutesOfDay,
      minGap: r.channelId === pickedChannelId ? CHANNEL_MIN_GAP_MIN : GLOBAL_MIN_GAP_MIN,
    }));
    let minute = null;
    for (const tier of windowTiersForTag(tag)) {
      minute = pickMinuteInWindows(tier, occupiedEntries, minAllowedMinutes);
      if (minute !== null) break;
    }
    if (minute === null) continue; // 이 날은 모든 시간대가 꽉 참 — 다음 날로

    return {
      channelId: pickedChannelId,
      dateStr,
      hour: pad2(Math.floor(minute / 60)),
      minute: pad2(minute % 60),
    };
  }
  return null;
}

async function getNextAvailableSlot(pool, channelId, tag, fromDateStr) {
  return findSlot(pool, tag, Number(channelId), fromDateStr);
}

async function getNextAvailableSlotAnyChannel(pool, tag, fromDateStr) {
  return findSlot(pool, tag, null, fromDateStr);
}

// 채널 목록 화면에 "오늘 정보성/광고용 몇 개 중 몇 개 남았는지" 보여주기 위한 집계.
async function getTodaySlotSummary(pool, channelId) {
  const dateStr = todayKstDateStr();
  const [targetsMap, daySchedule] = await Promise.all([loadTargets(pool), loadDaySchedule(pool, dateStr)]);
  const target = targetsMap.get(Number(channelId)) || { 광고용: 0, 정보성: 0 };
  const summary = { 정보성: { total: 0, remaining: 0 }, 광고용: { total: 0, remaining: 0 } };
  for (const tag of ['정보성', '광고용']) {
    const used = daySchedule.filter((r) => r.channelId === Number(channelId) && r.tag === tag).length;
    summary[tag] = { total: target[tag] || 0, remaining: Math.max(0, (target[tag] || 0) - used) };
  }
  return summary;
}

module.exports = { getNextAvailableSlot, getNextAvailableSlotAnyChannel, getTodaySlotSummary };
