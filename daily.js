const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { generateAiAnswer, pickCheckedPrompt } = require('./ai');

const DATA_FILE = path.join(__dirname, 'daily-data.json');
const LANGS = ['en', 'de'];

// ─── Persistence ────────────────────────────────────────────────────────────────
//
// Render's filesystem is ephemeral (wiped on every redeploy), so when Supabase
// credentials are configured, the whole data blob lives in one row of a Postgres
// table there instead. Without those env vars (e.g. local dev), it falls back to
// the local JSON file so testing never touches production data.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const SUPABASE_ROW_ID = 1;
const EMPTY_DATA = { days: {}, usedPromptKeys: { en: [], de: [] } };

function normalizeData(raw) {
  return {
    days: raw?.days || {},
    usedPromptKeys: { en: raw?.usedPromptKeys?.en || [], de: raw?.usedPromptKeys?.de || [] }
  };
}

async function loadPersistedData() {
  if (supabase) {
    const { data: row, error } = await supabase
      .from('daily_data').select('data').eq('id', SUPABASE_ROW_ID).maybeSingle();
    if (error) console.error('[daily] failed to load from Supabase, starting fresh:', error.message);
    return normalizeData(row?.data);
  }
  try {
    return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    return { ...EMPTY_DATA };
  }
}

async function persist() {
  if (supabase) {
    const { error } = await supabase.from('daily_data').upsert({ id: SUPABASE_ROW_ID, data });
    if (error) console.error('[daily] failed to persist to Supabase:', error.message);
    return;
  }
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE); // atomic replace, POSIX and Windows
  } catch (err) {
    console.error('[daily] failed to persist daily-data.json:', err.message);
  }
}

let data;
let usedPromptKeySets;

async function initData() {
  data = await loadPersistedData();
  usedPromptKeySets = {
    en: new Set(data.usedPromptKeys.en),
    de: new Set(data.usedPromptKeys.de)
  };
}

// ─── Day key / midnight rollover ────────────────────────────────────────────────

let fakeDateOverride = null; // test-only, set via /_test/advance-day

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function todayKey() {
  const d = fakeDateOverride ? new Date(fakeDateOverride) : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  // Local server time, not UTC — "midnight" follows this process's timezone.
}

// ─── Daily AI players ───────────────────────────────────────────────────────────

const DAILY_AI_PLAYERS = [
  { deviceId: 'ai-claude-haiku', name: 'Claude (Haiku)', model: 'claude-haiku-4-5' },
  { deviceId: 'ai-claude-sonnet', name: 'Claude (Sonnet)', model: 'claude-sonnet-5' }
];

function triggerDailyAiSubmissions(dayKey, lang) {
  DAILY_AI_PLAYERS.forEach(ai => {
    const delay = 2000 + Math.random() * 6000;
    setTimeout(async () => {
      const day = data.days[dayKey]?.[lang];
      if (!day || day.submissions[ai.deviceId]) return;
      const text = await generateAiAnswer(day.prompt.text, lang, ai.model);
      const stillDay = data.days[dayKey]?.[lang];
      if (!stillDay || stillDay.submissions[ai.deviceId]) return;
      stillDay.submissions[ai.deviceId] = { name: ai.name, text, submittedAt: Date.now(), votes: [], isAI: true };
      await persist();
    }, delay);
  });
}

// ─── Day generation ──────────────────────────────────────────────────────────────

// Picking a prompt now involves an awaited grammar check (German only), so two
// requests racing to create the same new day must share one in-flight creation
// rather than each independently generating (and burning a used-prompt slot).
const pendingDayCreation = new Map(); // dayKey -> Promise<entry>

function ensureDay(dayKey) {
  if (data.days[dayKey]) return Promise.resolve(data.days[dayKey]);
  if (pendingDayCreation.has(dayKey)) return pendingDayCreation.get(dayKey);

  const creation = (async () => {
    const entry = {};
    for (const lang of LANGS) {
      entry[lang] = { prompt: await pickCheckedPrompt(usedPromptKeySets[lang], lang), submissions: {} };
      data.usedPromptKeys[lang] = Array.from(usedPromptKeySets[lang]);
    }
    data.days[dayKey] = entry;
    await persist();
    for (const lang of LANGS) triggerDailyAiSubmissions(dayKey, lang);
    pendingDayCreation.delete(dayKey);
    return entry;
  })();

  pendingDayCreation.set(dayKey, creation);
  return creation;
}

// ─── Leaderboard / Hall of Fame (always computed live, never cached) ────────────

function computeLeaderboard(lang) {
  const players = {};
  const sortedDayKeys = Object.keys(data.days).sort(); // ascending: later days' names win
  for (const dayKey of sortedDayKeys) {
    const day = data.days[dayKey][lang];
    if (!day) continue;
    const entries = Object.entries(day.submissions).map(([id, s]) => ({ id, name: s.name, votes: s.votes.length }));
    for (const e of entries) {
      if (!players[e.id]) {
        players[e.id] = { deviceId: e.id, name: e.name, gold: 0, silver: 0, bronze: 0, daysSubmitted: 0 };
      }
      players[e.id].name = e.name;
      players[e.id].daysSubmitted += 1;
    }
    const maxVotes = Math.max(0, ...entries.map(e => e.votes));
    if (maxVotes === 0) continue; // no votes cast yet — no medals awarded for this day
    for (const e of entries) {
      if (e.votes === 0) continue;
      const rank = 1 + entries.filter(o => o.votes > e.votes).length;
      if (rank === 1) players[e.id].gold += 1;
      else if (rank === 2) players[e.id].silver += 1;
      else if (rank === 3) players[e.id].bronze += 1;
    }
  }
  return Object.values(players).sort((a, b) =>
    b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || b.daysSubmitted - a.daysSubmitted
  );
}

function computeHallOfFame(lang) {
  let maxVotes = 0;
  let entries = [];
  for (const dayKey of Object.keys(data.days)) {
    const day = data.days[dayKey][lang];
    if (!day) continue;
    for (const [id, s] of Object.entries(day.submissions)) {
      const v = s.votes.length;
      if (v === 0 || v < maxVotes) continue;
      const entry = { dayKey, prompt: day.prompt, name: s.name, text: s.text, deviceId: id };
      if (v > maxVotes) { maxVotes = v; entries = [entry]; }
      else { entries.push(entry); }
    }
  }
  return { votes: maxVotes, entries };
}

// ─── Validation helpers ──────────────────────────────────────────────────────────

function parseLang(v) { return v === 'de' ? 'de' : 'en'; }
function parseDeviceId(v) { return (typeof v === 'string' && v.length > 0 && v.length <= 64) ? v : null; }

// ─── Routes ───────────────────────────────────────────────────────────────────────

const router = express.Router();

router.get('/today', async (req, res) => {
  const lang = parseLang(req.query.lang);
  const deviceId = parseDeviceId(req.query.deviceId);
  const dayKey = todayKey();
  const day = (await ensureDay(dayKey))[lang];
  const mine = deviceId ? day.submissions[deviceId] : null;
  res.json({
    dayKey,
    prompt: day.prompt,
    hasSubmitted: !!mine,
    mySubmission: mine ? { text: mine.text, submittedAt: mine.submittedAt } : null,
    submissionCount: Object.keys(day.submissions).length
  });
});

router.post('/submit', async (req, res) => {
  const lang = parseLang(req.body.lang);
  const deviceId = parseDeviceId(req.body.deviceId);
  if (!deviceId) return res.status(400).json({ error: 'Invalid device id' });
  const name = (req.body.name || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: 'Enter a name' });
  const text = (req.body.text || '').trim().slice(0, 100);
  if (!text) return res.status(400).json({ error: 'Enter an answer' });

  const dayKey = todayKey(); // always server-computed — clients can never target a specific day
  const day = (await ensureDay(dayKey))[lang];
  if (day.submissions[deviceId]) return res.status(409).json({ error: 'Already submitted today' });

  const submittedAt = Date.now();
  day.submissions[deviceId] = { name, text, submittedAt, votes: [] };
  await persist();
  res.json({ ok: true, dayKey, submittedAt });
});

router.get('/day/:dayKey', (req, res) => {
  const lang = parseLang(req.query.lang);
  const deviceId = parseDeviceId(req.query.deviceId);
  const { dayKey } = req.params;
  if (dayKey >= todayKey()) return res.status(400).json({ error: "Today's submissions aren't visible yet" });
  const day = data.days[dayKey]?.[lang];
  if (!day) return res.status(404).json({ error: 'No such day' });
  const submissions = Object.entries(day.submissions)
    .map(([id, s]) => ({
      id, name: s.name, text: s.text, votes: s.votes.length,
      isOwn: id === deviceId,
      votedByMe: !!deviceId && s.votes.includes(deviceId)
    }))
    .sort((a, b) => b.votes - a.votes);
  res.json({ dayKey, prompt: day.prompt, closed: true, submissions });
});

router.get('/history', (req, res) => {
  const lang = parseLang(req.query.lang);
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const today = todayKey();
  const days = Object.keys(data.days)
    .filter(k => k < today && data.days[k][lang])
    .sort((a, b) => b.localeCompare(a))
    .map(k => ({
      dayKey: k,
      prompt: data.days[k][lang].prompt,
      submissionCount: Object.keys(data.days[k][lang].submissions).length
    }));
  res.json({ days: (limit && limit > 0) ? days.slice(0, limit) : days });
});

router.post('/vote', async (req, res) => {
  const lang = parseLang(req.body.lang);
  const deviceId = parseDeviceId(req.body.deviceId);
  const { dayKey, targetId } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'Invalid device id' });
  if (!dayKey || dayKey >= todayKey() || !data.days[dayKey]?.[lang]) {
    return res.status(400).json({ error: 'Voting not open for this day' });
  }
  const day = data.days[dayKey][lang];
  if (!day.submissions[targetId]) return res.status(404).json({ error: 'No such submission' });
  if (targetId === deviceId) return res.status(400).json({ error: 'Cannot upvote your own submission' });

  const votes = day.submissions[targetId].votes;
  const idx = votes.indexOf(deviceId);
  let votedByMe;
  if (idx === -1) { votes.push(deviceId); votedByMe = true; }
  else { votes.splice(idx, 1); votedByMe = false; }
  await persist();
  res.json({ ok: true, votes: votes.length, votedByMe });
});

router.get('/leaderboard', (req, res) => {
  res.json({ players: computeLeaderboard(parseLang(req.query.lang)) });
});

router.get('/hall-of-fame', (req, res) => {
  res.json(computeHallOfFame(parseLang(req.query.lang)));
});

if (process.env.ALLOW_DAILY_TEST_ROUTES === '1') {
  router.post('/_test/advance-day', (req, res) => {
    fakeDateOverride = req.body.date || null;
    res.json({ ok: true, todayKey: todayKey() });
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────────

async function registerDaily(app) {
  await initData();
  console.log(`[daily] persistence: ${supabase ? 'Supabase' : 'local file (daily-data.json)'}`);

  app.get('/daily', (req, res) => res.sendFile(path.join(__dirname, 'public', 'daily.html')));
  app.use('/api/daily', router);

  await ensureDay(todayKey()).catch(err => console.error('[daily] failed to initialize today:', err));
  setInterval(() => {
    ensureDay(todayKey()).catch(err => console.error('[daily] rollover check failed:', err));
  }, 45_000);
}

module.exports = registerDaily;
