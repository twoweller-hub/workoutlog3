'use strict';

const SUPABASE_URL     = 'https://bygocxazrbkydrqtbsrf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_xYuWtGjhulxA4_vP00OqfA__3NedqRC';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =====================================================================
//  STATE
// =====================================================================
const S = {
  exercises: [], menus: [], injurySites: [], menuLastDates: {}, recentSingle: [], stats: null,
  activeTab: 'record',
  recordScreen: 's1',
  settingsScreen: 's-top',
  session: null,       // {menu, menuDisplay, startTime, exercises: [{name, done, sets:[]}]}
  currentExIdx: null,
  timerInterval: null,
  timerStart: null,
  currentExStartTime: null,
  s3ExData: null,      // result of getExerciseData
  s3ExCache: {},       // {exerciseName: getExerciseData result} — cache within a session
  s3Sections: [],      // [{side, warmup:[{weight,reps,recorded,recordedAt}], main:[...]}]
  s3Interval: 90,
  s3HistOffset: 0,
  s3HistHasMore: false,
  s3HistLoaded: false,
  histDateOffset: 0,
  histDateItems: [],
  histDateHasMore: false,
  histExWithLastDate: null,
  histCurrentEx: null,
  histFromSession: null,
  histExOffset: 0,
  histExItems: [],
  histExHasMore: false,
  analysisExList: null,
  analysisExercise: null,
  analysisChartW: null,
  analysisChartV: null,
  analysisChartR: null,
  analysisChartTR: null,
  currentMenu: null,
  sortable: null,
  editingExName: null,
  editingInjuryOld: null,
  editingSession: null,
  editingRecord: null,
  confirmCb: null,
  injuryRecords: null,
  injuryView: 'date',
};

// =====================================================================
//  API
// =====================================================================
function toExercise(r) {
  return {
    name:            r.name,
    unit:            r.unit,
    defaultInterval: r.default_interval,
    bodyPart:        r.body_part,
    mainEquipment:   r.main_equipment,
    subEquipment:    r.sub_equipment,
    hasSides:        r.has_sides,
  };
}

function toRecord(r) {
  return {
    setType:        r.set_type,
    setNum:         r.set_num,
    side:           r.side || '',
    weight:         r.weight,
    reps:           r.reps,
    targetInterval: r.target_interval,
    injurySite:     r.injury_site  || '',
    injuryLevel:    r.injury_level || '',
    injuryMemo:     r.injury_memo  || '',
    memo:           r.memo || '',
    duration:       r.duration,
    time:           r.time || '',
    date:           r.date,
    exercise:       r.exercise,
    exInstanceId:   r.ex_instance_id || '',
    sessionId:      r.session_id || '',
  };
}

function toSession(r) {
  return {
    id:           r.id,
    sessionId:    r.session_id,
    date:         r.date,
    menu:         r.menu || '',
    startTime:    r.start_time || '',
    endTime:      r.end_time   || '',
    condition:    r.condition    || '',
    satisfaction: r.satisfaction || '',
    comment:      r.comment      || '',
  };
}

const PER_PAGE = 20;

async function sbGetInitialData() {
  const uid = _userId;
  const today = todayStr();
  const todayMs = new Date(today).getTime();

  const [exRes, menuRes, menuExRes, injRes, sessRes, recRes] = await Promise.all([
    sb.from('exercises').select('*').eq('user_id', uid),
    sb.from('menus').select('id, name').eq('user_id', uid),
    sb.from('menu_exercises').select('menu_id, exercise_name, order_num').eq('user_id', uid).order('order_num'),
    sb.from('injury_sites').select('name').eq('user_id', uid),
    sb.from('sessions').select('menu, date, session_id').eq('user_id', uid),
    sb.from('records').select('exercise, date, menu').eq('user_id', uid).order('date', {ascending: false}).limit(500),
  ]);

  const exercises = (exRes.data || []).map(toExercise);

  const menuExMap = {};
  (menuExRes.data || []).forEach(me => {
    if (!menuExMap[me.menu_id]) menuExMap[me.menu_id] = [];
    menuExMap[me.menu_id].push(me.exercise_name);
  });
  const menus = (menuRes.data || []).map(m => ({
    name: m.name,
    exercises: menuExMap[m.id] || [],
  }));

  const injurySites = (injRes.data || []).map(r => r.name);

  const menuLastDates = {};
  (sessRes.data || []).forEach(s => {
    if (!s.menu) return;
    if (!menuLastDates[s.menu] || s.date > menuLastDates[s.menu]) {
      menuLastDates[s.menu] = s.date;
    }
  });
  Object.keys(menuLastDates).forEach(menu => {
    const d = menuLastDates[menu];
    menuLastDates[menu] = { date: d, daysAgo: Math.round((todayMs - new Date(d).getTime()) / 86400000) };
  });

  const seen = new Set();
  const recentSingle = [];
  for (const r of (recRes.data || [])) {
    if (r.menu !== '' || !r.exercise || seen.has(r.exercise)) continue;
    seen.add(r.exercise);
    const daysAgo = Math.round((todayMs - new Date(r.date).getTime()) / 86400000);
    recentSingle.push({ name: r.exercise, lastDate: r.date, daysAgo });
    if (recentSingle.length >= 5) break;
  }

  const stats = _calcStats(sessRes.data || [], today);

  return { exercises, menus, injurySites, menuLastDates, recentSingle, stats };
}

function _calcStats(sessions, today) {
  const todayMs = new Date(today).getTime();
  const singleDates = new Set();
  const menuDates   = new Set();
  let singleToday = 0, menuToday = 0, singleTotal = 0, menuTotal = 0;

  sessions.forEach(s => {
    const isSingle = !!s.session_id && !s.menu;
    if (isSingle) {
      singleDates.add(s.date);
      singleTotal++;
      if (s.date === today) singleToday++;
    } else {
      menuDates.add(s.date);
      menuTotal++;
      if (s.date === today) menuToday++;
    }
  });

  function calcStreak(dates) {
    let streak = 0;
    const cur = new Date(today);
    if (!dates.has(today)) cur.setDate(cur.getDate() - 1);
    for (let i = 0; i < 3650; i++) {
      const ds = cur.toISOString().slice(0, 10);
      if (!dates.has(ds)) break;
      streak++;
      cur.setDate(cur.getDate() - 1);
    }
    return streak;
  }

  return {
    singleToday, singleStreak: calcStreak(singleDates), singleTotal,
    menuToday,   menuStreak:   calcStreak(menuDates),   menuTotal,
  };
}

async function sbGetExerciseData(exerciseName) {
  const uid = _userId;
  const today = todayStr();

  const { data } = await sb.from('records')
    .select('date, set_type, set_num, side, weight, reps, memo, session_id')
    .eq('user_id', uid)
    .eq('exercise', exerciseName);

  if (!data || data.length === 0) {
    return { lastDate: null, lastSets: [], lastMemo: '', totalMainSets: 0, daysSinceLast: null };
  }

  let lastDate = null, lastSessionId = null, totalMainSets = 0;
  data.forEach(r => {
    if (r.set_type === 'メイン') totalMainSets++;
    if (!lastDate || r.date > lastDate ||
        (r.date === lastDate && r.session_id && (!lastSessionId || r.session_id > lastSessionId))) {
      lastDate = r.date;
      lastSessionId = r.session_id;
    }
  });

  const lastRecs = lastSessionId
    ? data.filter(r => r.session_id === lastSessionId)
    : data.filter(r => r.date === lastDate);

  const lastSets = lastRecs.map(r => ({
    type: r.set_type, setNum: r.set_num, side: r.side || '',
    weight: r.weight, reps: r.reps,
  }));
  const lastMemo = (lastRecs.find(r => r.memo) || {}).memo || '';
  const daysSinceLast = Math.round((new Date(today).getTime() - new Date(lastDate).getTime()) / 86400000);

  return { lastDate, lastSets, lastMemo, totalMainSets, daysSinceLast };
}

async function sbGetHistory(offset) {
  const uid = _userId;

  const { data: sessData } = await sb.from('sessions')
    .select('*')
    .eq('user_id', uid)
    .order('date', { ascending: false })
    .order('start_time', { ascending: false });

  const allSess = (sessData || []).map(toSession);
  const paged   = allSess.slice(offset, offset + PER_PAGE);
  const hasMore = allSess.length > offset + PER_PAGE;
  if (paged.length === 0) return { sessions: [], hasMore: false };

  const dateSet = new Set(paged.map(s => s.date));
  const { data: recData } = await sb.from('records')
    .select('*')
    .eq('user_id', uid)
    .in('date', [...dateSet]);

  const recMap = {};
  (recData || []).forEach(r => {
    const sid    = r.session_id || (r.date + '|' + (r.menu || ''));
    const exInst = r.ex_instance_id || (sid + '|' + r.exercise);
    if (!recMap[sid]) recMap[sid] = {};
    if (!recMap[sid][exInst]) recMap[sid][exInst] = { name: r.exercise, exInstanceId: r.ex_instance_id || '', sets: [] };
    recMap[sid][exInst].sets.push({
      setType:     r.set_type     || '',
      setNum:      r.set_num      || 0,
      side:        r.side         || '',
      weight:      r.weight,
      reps:        r.reps,
      injurySite:  r.injury_site  || '',
      injuryLevel: r.injury_level || '',
      injuryMemo:  r.injury_memo  || '',
      memo:        r.memo         || '',
      duration:    r.duration,
    });
  });

  paged.forEach(sess => {
    const key = sess.sessionId || (sess.date + '|' + (sess.menu || ''));
    sess.exercises = Object.values(recMap[key] || {});
  });

  return { sessions: paged, hasMore };
}

async function sbGetExercisesWithLastDate() {
  const uid   = _userId;
  const today = todayStr();
  const todayMs = new Date(today).getTime();

  const { data } = await sb.from('records')
    .select('exercise, date')
    .eq('user_id', uid);

  const map = {};
  (data || []).forEach(r => {
    if (!map[r.exercise] || r.date > map[r.exercise]) map[r.exercise] = r.date;
  });

  const exercises = Object.keys(map).map(name => ({
    name,
    lastDate: map[name],
    daysAgo: Math.round((todayMs - new Date(map[name]).getTime()) / 86400000),
  }));
  exercises.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return { exercises };
}

async function sbGetExerciseHistory(exerciseName, offset) {
  const uid   = _userId;
  const today = todayStr();
  const todayMs = new Date(today).getTime();

  const { data } = await sb.from('records')
    .select('*')
    .eq('user_id', uid)
    .eq('exercise', exerciseName);

  const entryMap = {};
  (data || []).forEach(r => {
    const key = r.ex_instance_id || r.date;
    const dur = r.duration;
    if (!entryMap[key]) {
      entryMap[key] = { date: r.date, time: r.time || '', sets: [], firstDuration: dur };
    }
    entryMap[key].sets.push({
      setType:        r.set_type      || '',
      setNum:         r.set_num       || 0,
      side:           r.side          || '',
      weight:         r.weight,
      reps:           r.reps,
      targetInterval: r.target_interval,
      injurySite:     r.injury_site   || '',
      injuryLevel:    r.injury_level  || '',
      injuryMemo:     r.injury_memo   || '',
      memo:           r.memo          || '',
      duration:       dur,
    });
    entryMap[key].lastTime = r.time || '';
  });

  const sorted = Object.keys(entryMap).sort((a, b) => {
    const da = entryMap[a].date + entryMap[a].time;
    const db = entryMap[b].date + entryMap[b].time;
    return db.localeCompare(da);
  });

  const paged   = sorted.slice(offset, offset + PER_PAGE);
  const hasMore = sorted.length > offset + PER_PAGE;

  const dates = paged.map((key, idx) => {
    const entry = entryMap[key];
    const prevKey = sorted[offset + idx + 1];
    let daysSincePrev = null;
    if (prevKey) {
      const thisMs = new Date(entry.date).getTime();
      const prevMs = new Date(entryMap[prevKey].date).getTime();
      daysSincePrev = Math.round((thisMs - prevMs) / 86400000);
    }
    let exerciseElapsed = null;
    if (entry.time && entry.lastTime) {
      const sp = entry.time.split(':').map(Number);
      const ep = entry.lastTime.split(':').map(Number);
      const lastSec       = ep[0] * 3600 + ep[1] * 60;
      const firstRecSec   = sp[0] * 3600 + sp[1] * 60;
      const firstStartSec = entry.firstDuration != null ? firstRecSec - entry.firstDuration : firstRecSec;
      const diffSec = lastSec - firstStartSec;
      if (diffSec > 0) exerciseElapsed = Math.round(diffSec / 60);
    }
    return {
      date: entry.date, time: entry.time,
      daysAgo: Math.round((todayMs - new Date(entry.date).getTime()) / 86400000),
      daysSincePrev, exerciseElapsed,
      sets: entry.sets,
    };
  });

  return { dates, hasMore };
}

async function sbGetInjuryHistory() {
  const { data } = await sb.from('records')
    .select('date, session_id, exercise, set_type, set_num, side, injury_site, injury_level, injury_memo')
    .eq('user_id', _userId)
    .neq('injury_site', '')
    .order('date', { ascending: false });

  const records = (data || []).map(r => ({
    date:        r.date,
    sessionId:   r.session_id   || '',
    exercise:    r.exercise,
    setType:     r.set_type     || '',
    setNum:      r.set_num      || 0,
    side:        r.side         || '',
    injurySite:  r.injury_site  || '',
    injuryLevel: r.injury_level || '',
    injuryMemo:  r.injury_memo  || '',
  }));
  return { records };
}

async function sbGetAnalysisData(exerciseName) {
  const { data } = await sb.from('records')
    .select('date, weight, reps')
    .eq('user_id', _userId)
    .eq('exercise', exerciseName)
    .eq('set_type', 'メイン');

  const dateMap = {};
  (data || []).forEach(r => {
    const w   = r.weight != null ? Number(r.weight) : 0;
    const rep = r.reps   != null ? Number(r.reps)   : 0;
    if (!dateMap[r.date]) dateMap[r.date] = { maxWeight: 0, maxReps: 0, totalReps: 0, totalVolume: 0, totalSets: 0 };
    dateMap[r.date].maxWeight    = Math.max(dateMap[r.date].maxWeight, w);
    dateMap[r.date].maxReps      = Math.max(dateMap[r.date].maxReps, rep);
    dateMap[r.date].totalReps   += rep;
    dateMap[r.date].totalVolume += w * rep;
    dateMap[r.date].totalSets++;
  });

  return {
    data: Object.keys(dateMap).sort().map(date => ({
      date,
      maxWeight:   dateMap[date].maxWeight,
      maxReps:     dateMap[date].maxReps,
      totalReps:   dateMap[date].totalReps,
      totalVolume: Math.round(dateMap[date].totalVolume * 10) / 10,
      totalSets:   dateMap[date].totalSets,
    })),
  };
}

async function sbUpdateExerciseRecords(d) {
  const uid = _userId;

  const { data: origData } = await sb.from('records')
    .select('set_type, set_num, side, time, target_interval, duration')
    .eq('user_id', uid)
    .eq('ex_instance_id', d.exInstanceId || '')
    .eq('exercise', d.exercise);

  const origMap = {};
  (origData || []).forEach(r => {
    const key = r.set_type + '|' + r.set_num + '|' + (r.side || '');
    if (!origMap[key]) origMap[key] = { time: r.time, targetInterval: r.target_interval, duration: r.duration };
  });

  if (d.exInstanceId) {
    await sb.from('records').delete().eq('user_id', uid).eq('ex_instance_id', d.exInstanceId);
  } else {
    await sb.from('records').delete().eq('user_id', uid)
      .eq('session_id', d.sessionId).eq('exercise', d.exercise);
  }

  if (!d.sets || d.sets.length === 0) return;

  const rows = d.sets.map(s => {
    const key  = s.type + '|' + s.setNum + '|' + (s.side || '');
    const orig = origMap[key] || {};
    return {
      user_id:         uid,
      session_id:      d.sessionId || '',
      ex_instance_id:  d.exInstanceId || '',
      date:            d.date,
      time:            orig.time || '',
      menu:            d.menu || '',
      exercise:        d.exercise,
      set_type:        s.type,
      set_num:         s.setNum,
      side:            s.side || '',
      weight:          s.weight  != null ? s.weight  : null,
      reps:            s.reps    != null ? s.reps    : null,
      target_interval: orig.targetInterval != null ? orig.targetInterval : null,
      injury_site:     s.injurySite  || '',
      injury_level:    s.injuryLevel || '',
      injury_memo:     s.injuryMemo  || '',
      memo:            s.memo        || '',
      duration:        orig.duration != null ? orig.duration : null,
    };
  });

  const { error } = await sb.from('records').insert(rows);
  if (error) { showToast('保存に失敗しました'); console.error(error); }
}

// =====================================================================
//  DATE / DISPLAY UTILS
// =====================================================================
const DAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayDisplay() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${DAY_JA[d.getDay()]}）`;
}

function timeNow() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${DAY_JA[d.getDay()]}）`;
}

function menuDisplay(name) {
  // 'メニュー' suffix for UI display
  if (!name) return '';
  if (name.endsWith('メニュー')) return name;
  return name + 'メニュー';
}

function menuStorage(displayName) {
  // Strip 'メニュー' for records/sessions sheet
  if (displayName.endsWith('メニュー')) return displayName.slice(0, -4);
  return displayName;
}

function menuLastDate(displayName) {
  const key = menuStorage(displayName);
  return S.menuLastDates[key] || S.menuLastDates[displayName] || null;
}

function setNumLabel(i, isWarm) {
  if (isWarm) return '準' + ['①', '②', '③', '④', '⑤'][i] || `準${i + 1}`;
  return ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'][i] || `${i + 1}`;
}

function formatSets(sets, unit) {
  return sets.filter(s => s.weight != null || s.reps != null).map(s => {
    if (unit === '秒') return s.weight != null ? `${s.weight}kg×${s.reps}秒` : `${s.reps}秒`;
    return s.weight != null ? `${s.weight}kg×${s.reps}` : `${s.reps}回`;
  }).join(' / ');
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseMemo(str) {
  if (!str) return '';
  return esc(str)
    .replace(/==(.+?)==/g, '<mark class="memo-hl">$1</mark>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>');
}

function showToast(msg, dur = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}

function showConfirm(title, msg, cb, opts = {}) {
  document.getElementById('modal-confirm-title').textContent = title;
  document.getElementById('modal-confirm-msg').textContent = msg;
  S.confirmCb = cb;
  const okBtn = document.getElementById('modal-confirm-ok');
  okBtn.textContent = opts.okLabel || '削除する';
  okBtn.style.background = opts.accent ? '#d4f53c' : '#ff4d3a';
  okBtn.style.color = opts.accent ? '#111318' : '#fff';
  openModal('modal-confirm');
}

// =====================================================================
//  INIT
// =====================================================================
// =====================================================================
//  AUTH
// =====================================================================

let _authMode = 'login';
let _appSetupDone = false;
let _userId = null;

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'flex';
}

function hideLoginScreen() {
  document.getElementById('login-screen').style.display = 'none';
}

function _setLoginError(msg) {
  document.getElementById('login-error').textContent = msg;
}

function _toggleAuthMode() {
  _authMode = _authMode === 'login' ? 'signup' : 'login';
  const isSignup = _authMode === 'signup';
  document.getElementById('login-title').textContent = isSignup ? '新規登録' : 'ログイン';
  document.getElementById('login-submit-btn').textContent = isSignup ? 'アカウントを作成' : 'ログイン';
  document.getElementById('login-switch-btn').textContent = isSignup ? 'ログインに戻る' : 'アカウントを作成する';
  _setLoginError('');
}

async function _handleAuthSubmit() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  _setLoginError('');
  if (!email || !password) { _setLoginError('メールアドレスとパスワードを入力してください'); return; }

  const btn = document.getElementById('login-submit-btn');
  btn.disabled = true;
  btn.textContent = '処理中...';

  let error;
  if (_authMode === 'login') {
    ({ error } = await sb.auth.signInWithPassword({ email, password }));
  } else {
    ({ error } = await sb.auth.signUp({ email, password }));
  }

  btn.disabled = false;
  btn.textContent = _authMode === 'login' ? 'ログイン' : 'アカウントを作成';

  if (error) { _setLoginError(_authErrMsg(error)); return; }

  if (_authMode === 'signup') {
    document.getElementById('login-title').textContent = '確認メールを送信しました';
    document.getElementById('login-submit-btn').style.display = 'none';
    document.getElementById('login-switch-btn').style.display = 'none';
    const errEl = document.getElementById('login-error');
    errEl.style.color = '#d4f53c';
    errEl.textContent = 'メールのリンクをクリックして登録を完了してください';
  }
}

function _authErrMsg(error) {
  const m = error.message || '';
  if (m.includes('Invalid login credentials')) return 'メールアドレスまたはパスワードが違います';
  if (m.includes('Email not confirmed')) return 'メールアドレスの確認が完了していません';
  if (m.includes('User already registered')) return 'このメールアドレスはすでに登録されています';
  return m;
}

async function handleLogout() {
  await sb.auth.signOut();
}

async function init() {
  if (!_appSetupDone) {
    document.getElementById('s1-date').textContent = todayDisplay();
    document.getElementById('s2-date').textContent = todayDisplay();
    setupNav();
    setupEventListeners();
    showTab('record');
    _appSetupDone = true;
  }

  try {
    const data = await sbGetInitialData();
    S.exercises = data.exercises || [];
    S.menus = data.menus || [];
    S.injurySites = data.injurySites || [];
    S.menuLastDates = data.menuLastDates || {};
    S.recentSingle = data.recentSingle || [];
    S.stats = data.stats || null;
    renderS1();
    renderStats();
    updateSettingsTopCounts();
  } catch (e) {
    showToast('データの読み込みに失敗しました');
  }
}

// =====================================================================
//  NAVIGATION
// =====================================================================
function setupNav() {
  document.querySelectorAll('#bottom-nav .wa-nav-item, #sidebar-nav .wa-nav-item').forEach(item => {
    item.addEventListener('click', () => showTab(item.dataset.tab));
  });
}

function showTab(tab) {
  S.activeTab = tab;
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelectorAll('#bottom-nav .wa-nav-item, #sidebar-nav .wa-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.tab === tab);
  });

  if (tab === 'history' && S.histDateItems.length === 0) loadHistoryDate();
  if (tab === 'injury' && !S.injuryRecords) loadInjuryHistory();
  if (tab === 'analysis' && !S.analysisExList) loadAnalysisExList();
  if (tab === 'settings') { renderSettingsEx(); renderSettingsMenu(); renderSettingsInjury(); updateSettingsTopCounts(); }
}

function showRecordScreen(id) {
  S.recordScreen = id;
  document.querySelectorAll('#tab-record .screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showSettingsScreen(id) {
  S.settingsScreen = id;
  document.querySelectorAll('#tab-settings .screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// =====================================================================
//  統計表示（記録タブ・履歴タブ共通）
// =====================================================================
function renderStats() {
  if (!S.stats) return;
  const { singleToday, singleStreak, singleTotal, menuToday, menuStreak, menuTotal } = S.stats;
  [
    ['stat-single-today',  'hist-stat-single-today',  singleToday],
    ['stat-single-streak', 'hist-stat-single-streak', singleStreak],
    ['stat-single-total',  'hist-stat-single-total',  singleTotal],
    ['stat-menu-today',    'hist-stat-menu-today',    menuToday],
    ['stat-menu-streak',   'hist-stat-menu-streak',   menuStreak],
    ['stat-menu-total',    'hist-stat-menu-total',    menuTotal],
  ].forEach(([a, b, val]) => {
    [a, b].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = val; });
  });
}

// =====================================================================
//  記録タブ: 画面1 記録トップ（クイックグリッド）
// =====================================================================
const BODY_EMOJI = {
  '脚': '🦵', '下半身': '🦵', '太もも': '🦵', 'ふくらはぎ': '🦶', 'カーフ': '🦶', '臀部': '🦵',
  '胸': '💪', '腕': '💪', '上腕': '💪', '上半身': '💪',
  '肩': '🦾', '三角筋': '🦾',
  '背中': '🏋️', '広背筋': '🏋️',
  '体幹': '🔥', '腹': '🔥', 'コア': '🔥',
  '有酸素': '🏃', '全身': '⚡',
};

function renderS1() {
  const cells = S.recentSingle.slice(0, 5).map(item => {
    const name = typeof item === 'string' ? item : item.name;
    const ex   = S.exercises.find(e => e.name === name);
    const emoji = BODY_EMOJI[ex?.bodyPart] || '🏋️';
    let meta = '';
    if (item.lastDate) {
      meta = `<div class="s1-quick-meta">前回 ${dateLabel(item.lastDate)}（${item.daysAgo}日前）</div>`;
    }
    return `<div class="s1-quick-cell" data-name="${esc(name)}">
      <div class="s1-quick-emoji">${emoji}</div>
      <div class="s1-quick-name">${esc(name)}</div>
      ${meta}
    </div>`;
  });
  cells.push(`<div class="s1-quick-cell s1-quick-single" id="btn-single-record">
    <div class="s1-quick-emoji">＋</div>
    <div class="s1-quick-name">単発記録</div>
  </div>`);
  document.getElementById('s1-quick-grid').innerHTML = cells.join('');
  document.querySelectorAll('#s1-quick-grid .s1-quick-cell:not(.s1-quick-single)').forEach(el => {
    el.addEventListener('click', () => startSingleFromGrid(el.dataset.name));
  });
  document.getElementById('btn-single-record').addEventListener('click', openSingleRecord);
}

function startSingleFromGrid(name) {
  if (S.session && S.session.menu !== '') {
    showConfirm('確認', '進行中のセッションがあります。破棄して単発記録に切り替えますか？', () => {
      stopTimer(); S.session = null; S.s3ExCache = {};
      startSingle(name); enterEx(0);
    });
    return;
  }
  if (S.session && S.session.menu === '' && S.session.exercises[0]?.name === name) {
    goS2(); return;
  }
  startSingle(name); enterEx(0);
}

// =====================================================================
//  記録タブ: 画面1-m セットメニュー選択
// =====================================================================
function renderS1Menu() {
  const icons = ['💪', '🦾', '🏋️', '🔝', '⚡', '🦵', '🔥', '🧠', '🏃', '✨'];
  let html = '';
  S.menus.forEach((m, i) => {
    const ld = menuLastDate(m.name);
    let meta = 'まだ実施なし';
    if (ld) meta = `前回 ${dateLabel(ld.date)}（${ld.daysAgo}日前）`;
    html += `<div class="wa-menu-item" data-menu="${esc(m.name)}">
      <div class="wa-menu-icon">${icons[i % icons.length]}</div>
      <div class="wa-menu-info">
        <div class="wa-menu-name">${esc(menuDisplay(m.name))}</div>
        <div class="wa-menu-meta">${esc(meta)}</div>
      </div>
      <div class="wa-menu-chevron">▶</div>
    </div>`;
  });
  document.getElementById('s1-menus').innerHTML = html;
  document.querySelectorAll('#s1-menus .wa-menu-item').forEach(el => {
    el.addEventListener('click', () => {
      if (S.session && S.session.menu === el.dataset.menu) { goS2(); return; }
      if (S.session) {
        showConfirm('確認', '進行中のセッションがあります。破棄して新しいセッションを開始しますか？', () => {
          stopTimer(); startSession(el.dataset.menu);
        });
        return;
      }
      startSession(el.dataset.menu);
    });
  });
}

function startSession(menuName) {
  S.session = {
    sessionId: 'sid_' + Date.now(),
    menu: menuName,
    menuDisplay: menuDisplay(menuName),
    startTime: timeNow(),
    exercises: (S.menus.find(m => m.name === menuName)?.exercises || []).map((name, i) => ({
      name, done: false, sets: [], exInstanceId: 'exinst_' + Date.now() + '_' + i,
    })),
  };
  goS2();
}

// =====================================================================
//  記録タブ: 画面1-s 単発記録 種目選択
// =====================================================================
function openSingleRecord() {
  if (S.session && S.session.menu !== '') {
    showConfirm('確認', '進行中のセッションがあります。破棄して単発記録に切り替えますか？', () => {
      stopTimer(); S.session = null; S.s3ExCache = {}; renderS1Single(); showRecordScreen('s1-single');
    });
    return;
  }
  renderS1Single();
  showRecordScreen('s1-single');
}

function renderS1Single(filter = '') {
  const wrap = document.getElementById('s1s-recent-wrap');
  const recentList = document.getElementById('s1s-recent-list');
  const allList = document.getElementById('s1s-ex-list');
  const lc = filter.toLowerCase();

  if (S.recentSingle.length > 0 && !filter) {
    wrap.style.display = '';
    recentList.innerHTML = S.recentSingle.map(item => {
      const name = typeof item === 'string' ? item : item.name;
      return `<div class="wa-ex-list-item" data-name="${esc(name)}">
        <span class="wa-ex-list-name">${esc(name)}</span>
        <span class="wa-ex-list-chev">▶</span>
      </div>`;
    }).join('');
    recentList.querySelectorAll('.wa-ex-list-item').forEach(el => {
      el.addEventListener('click', () => startSingle(el.dataset.name));
    });
  } else {
    wrap.style.display = 'none';
  }

  const filtered = S.exercises.filter(e => !filter || e.name.toLowerCase().includes(lc));
  allList.innerHTML = filtered.map(e =>
    `<div class="wa-ex-list-item" data-name="${esc(e.name)}">
      <span class="wa-ex-list-name">${esc(e.name)}</span>
      <span class="wa-ex-list-meta">${esc(e.bodyPart)}</span>
      <span class="wa-ex-list-chev">▶</span>
    </div>`
  ).join('');
  allList.querySelectorAll('.wa-ex-list-item').forEach(el => {
    el.addEventListener('click', () => startSingle(el.dataset.name));
  });
}

function startSingle(name) {
  S.session = {
    sessionId: 'sid_' + Date.now(),
    menu: '',
    menuDisplay: '単発記録',
    startTime: timeNow(),
    exercises: [{ name, done: false, sets: [], exInstanceId: 'exinst_' + Date.now() + '_0' }],
  };
  goS2();
}

// =====================================================================
//  記録タブ: 画面2 種目リスト
// =====================================================================
function goS2() {
  document.getElementById('s2-title').textContent = S.session.menuDisplay;
  document.getElementById('s2-start-label').textContent = `（${S.session.startTime}開始）`;
  if (!S.timerInterval) {
    S.timerStart = Date.now();
    S.timerInterval = setInterval(updateTimer, 1000);
  }
  renderS2();
  showRecordScreen('s2');
}

function updateTimer() {
  const sec = Math.floor((Date.now() - S.timerStart) / 1000);
  const val = `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
  const el = document.getElementById('session-timer');
  if (el) el.textContent = val;
  const el3 = document.getElementById('s3-timer');
  if (el3) el3.textContent = val;
  const elEx = document.getElementById('s3-ex-timer');
  if (elEx && S.currentExStartTime) {
    const exSec = Math.floor((Date.now() - S.currentExStartTime) / 1000);
    elEx.textContent = `${pad2(Math.floor(exSec / 60))}:${pad2(exSec % 60)}`;
  }
  const now = Date.now();
  document.querySelectorAll('.wa-record-btn.started').forEach(btn => {
    const si = parseInt(btn.dataset.si);
    const type = btn.dataset.type;
    const idx = parseInt(btn.dataset.i);
    const set = S.s3Sections[si]?.[type]?.[idx];
    if (!set?.startedAt) return;
    const sec = Math.floor((now - set.startedAt) / 1000);
    btn.textContent = `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
  });
}

function renderS2() {
  const exes = S.session.exercises;
  let html = '';
  exes.forEach((ex, i) => {
    let statusClass = 'pending', statusChar = '○', itemClass = '';
    if (ex.done) { statusClass = 'check'; statusChar = '✓'; itemClass = ' done'; }
    else if (i === S.currentExIdx) { statusClass = 'play'; statusChar = '▶'; itemClass = ' active'; }

    let prevText = '';
    if (ex.sets && ex.sets.length > 0) {
      const mainSets = ex.sets.filter(s => s.type === 'メイン');
      const unit = S.exercises.find(e => e.name === ex.name)?.unit || '回';
      prevText = formatSets(mainSets, unit);
    }

    html += `<div class="wa-ex-item${itemClass}" data-idx="${i}">
      <div class="wa-ex-status ${statusClass}">${statusChar}</div>
      <div class="wa-ex-info">
        <div class="wa-ex-name">${esc(ex.name)}</div>
        ${prevText ? `<div class="wa-ex-prev">${esc(prevText)}</div>` : ''}
      </div>
      <div class="wa-ex-chevron">▶</div>
    </div>`;
  });
  html += '<div class="wa-divider-line"></div><button class="wa-add-ex-btn" id="btn-s2-add-ex">＋　種目を追加</button>';

  const container = document.getElementById('s2-ex-list');
  container.innerHTML = html;
  container.querySelectorAll('.wa-ex-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    if (!S.session.exercises[idx].done) {
      el.addEventListener('click', () => enterEx(idx));
    }
  });
  container.querySelector('#btn-s2-add-ex')?.addEventListener('click', openSessionExAdd);

  const hasAnyRecord = S.session.exercises.some(e => e.done);
  const endBtn = document.getElementById('btn-end-training');
  endBtn.disabled = !hasAnyRecord;
  endBtn.style.opacity = hasAnyRecord ? '' : '0.3';
}

// =====================================================================
//  記録タブ: 画面3 種目入力
// =====================================================================
async function enterEx(idx) {
  S.currentExIdx = idx;
  const ex = S.session.exercises[idx];
  const exMaster = S.exercises.find(e => e.name === ex.name);
  const interval = exMaster?.defaultInterval ?? 90;

  document.getElementById('s3-title').textContent = ex.name;
  document.getElementById('s3-date').textContent = todayDisplay();
  S.currentExStartTime = Date.now();
  S.s3Interval = interval;

  showRecordScreen('s3');

  if (S.s3ExCache[ex.name]) {
    S.s3ExData = S.s3ExCache[ex.name];
  } else {
    const body = document.getElementById('s3-body');
    body.innerHTML = '<div class="loading-msg">前回データを読み込み中…</div>';
    try {
      S.s3ExData = await sbGetExerciseData(ex.name);
      S.s3ExCache[ex.name] = S.s3ExData;
    } catch (e) {
      S.s3ExData = null;
    }
  }

  document.getElementById('s3-body').innerHTML = '';
  initS3Sections(exMaster);
  renderS3Body(exMaster);
  updateS3HistStats();
  resetS3HistPanel();
  if (window.innerWidth >= 640) { loadS3Hist(); loadS3Injury(); }
}

function initS3Sections(exMaster) {
  const hasSides = exMaster?.hasSides || false;
  const data = S.s3ExData;

  const emptySet = () => ({ weight: null, reps: null, recorded: false, recordedAt: null, startedAt: null, duration: null, injurySite: '', injuryLevel: '', injuryMemo: '', injuryOpen: false, memo: '' });
  const buildSets = (type, sideFilter) => {
    const prev = data?.lastSets?.filter(s => s.type === type && (sideFilter === '' ? true : s.side === sideFilter)) || [];
    if (prev.length > 0) {
      return prev.map(s => ({ weight: s.weight, reps: s.reps, recorded: false, recordedAt: null, startedAt: null, duration: null, injurySite: '', injuryLevel: '', injuryMemo: '', injuryOpen: false, memo: '' }));
    }
    if (type === 'ウォームアップ') return [];
    return [emptySet(), emptySet(), emptySet()];
  };

  if (hasSides) {
    S.s3Sections = [
      { side: '右', warmup: buildSets('ウォームアップ', '右'), main: buildSets('メイン', '右') },
      { side: '左', warmup: buildSets('ウォームアップ', '左'), main: buildSets('メイン', '左') },
    ];
  } else {
    S.s3Sections = [
      { side: '', warmup: buildSets('ウォームアップ', ''), main: buildSets('メイン', '') },
    ];
  }
}

function renderS3Body(exMaster) {
  const hasSides = exMaster?.hasSides || false;
  const unit = exMaster?.unit || '回';
  const data = S.s3ExData;
  const body = document.getElementById('s3-body');
  const curInterval = document.getElementById('s3-interval');
  if (curInterval) S.s3Interval = parseInt(curInterval.value) || S.s3Interval;
  syncS3InjuryState();

  let html = `<div class="wa-interval-in-body">
    <span class="wa-interval-label">インターバル（秒）</span>
    <input class="wa-interval-input" type="number" id="s3-interval" min="0" max="999" value="${S.s3Interval}">
    <span class="wa-interval-label">秒</span>
  </div>`;

  S.s3Sections.forEach((sec, si) => {
    if (hasSides) {
      html += `<div class="wa-side-section-label">${esc(sec.side)}セクション</div>`;
    }
    if (sec.warmup.length > 0 || hasSides) {
      html += `<div class="wa-section-label">ウォームアップ</div>`;
      sec.warmup.forEach((set, i) => {
        html += buildSetRowHtml(si, 'warmup', i, set, unit);
      });
      html += `<div class="wa-add-row">
        <button class="wa-add-btn" data-si="${si}" data-type="warmup">＋ ウォームアップ追加</button>
      </div>`;
    }
    html += `<div class="wa-section-label">メイン</div>`;
    sec.main.forEach((set, i) => {
      html += buildSetRowHtml(si, 'main', i, set, unit);
      if (i > 0 && sec.main[i - 1].recordedAt && set.recordedAt) {
        const diff = Math.round((set.recordedAt - sec.main[i - 1].recordedAt) / 1000);
        html += `<div class="wa-interval-auto">${setNumLabel(i - 1, false)}→${setNumLabel(i, false)} ${diff}秒</div>`;
      }
    });
    html += `<div class="wa-add-row">
      <button class="wa-add-btn" data-si="${si}" data-type="main">＋ セット追加</button>
      ${!hasSides && sec.warmup.length === 0 ? `<button class="wa-add-btn" data-si="${si}" data-type="warmup">＋ ウォームアップ追加</button>` : ''}
    </div>`;
    if (si < S.s3Sections.length - 1) html += '<div class="wa-divider"></div>';
  });

  body.innerHTML = html;

  // Attach events
  body.querySelectorAll('.wa-record-btn').forEach(btn => {
    attachRecordBtnEvents(btn);
  });
  body.querySelectorAll('.wa-add-btn').forEach(btn => {
    btn.addEventListener('click', e => onAddSet(e.currentTarget));
  });
  body.querySelectorAll('.wa-set-injury-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const injBody = btn.nextElementSibling;
      const open = injBody.classList.toggle('open');
      btn.querySelector('.wa-set-injury-chev').style.transform = open ? 'rotate(180deg)' : '';
    });
  });

  updateCompleteBtn();
  updatePulseBtn();
}

function updatePulseBtn() {
  const body = document.getElementById('s3-body');
  if (!body) return;
  body.querySelectorAll('.wa-record-btn.pulse').forEach(b => b.classList.remove('pulse'));
  const all = [...body.querySelectorAll('.wa-record-btn')];
  let lastRecordedIdx = -1;
  all.forEach((btn, idx) => { if (btn.classList.contains('recorded')) lastRecordedIdx = idx; });
  const next = all.slice(lastRecordedIdx + 1).find(btn => !btn.classList.contains('started') && !btn.classList.contains('recorded'));
  if (next) next.classList.add('pulse');
}

function updateCompleteBtn() {
  const hasRecord = S.s3Sections.some(sec =>
    sec.warmup.some(s => s.recorded) || sec.main.some(s => s.recorded)
  );
  const btn = document.getElementById('btn-complete-ex');
  btn.disabled = !hasRecord;
  btn.style.opacity = hasRecord ? '' : '0.3';
}

function buildPrevBoxHtml(data, unit, hasSides) {
  if (!data || !data.lastDate) return '';
  const mainSets = (data.lastSets || []).filter(s => s.type === 'メイン');
  if (mainSets.length === 0 && !data.lastMemo) return '';

  let setsLine = '';
  if (hasSides) {
    const r = mainSets.filter(s => s.side === '右');
    const l = mainSets.filter(s => s.side === '左');
    if (r.length) setsLine += `右: ${formatSets(r, unit)}　`;
    if (l.length) setsLine += `左: ${formatSets(l, unit)}`;
  } else {
    setsLine = formatSets(mainSets, unit);
  }

  const isToday = data.daysSinceLast === 0;
  const prevLabel = isToday ? '本日' : '前回';
  return `<div class="wa-prev-box">
    ${data.lastMemo ? `<div class="wa-prev-label">${prevLabel}のメモ</div><div class="wa-prev-memo">${parseMemo(data.lastMemo)}</div>` : ''}
    <div class="wa-prev-sets">${prevLabel} ${esc(dateLabel(data.lastDate))}: ${esc(setsLine)}</div>
    <div class="wa-prev-stats">累計 ${data.totalMainSets}セット　前回から${data.daysSinceLast}日</div>
  </div>`;
}

function buildSetRowHtml(si, type, i, set, unit) {
  const isWarm = type === 'warmup';
  const label = `<span class="wa-set-prefix">${isWarm ? '準' : ''}</span>${setNumLabel(i, false)}`;
  const wVal = set.weight != null ? set.weight : '';
  const rVal = set.reps != null ? set.reps : '';
  const hasInjury = set.injurySite ? ' has-injury' : '';
  const injuryOpen = set.injuryOpen ? ' open' : '';
  const chevStyle = set.injuryOpen ? ' style="transform:rotate(180deg)"' : '';
  let recClass, recText;
  if (set.recorded) {
    recClass = ' recorded'; recText = '✓ 記録済';
  } else if (set.startedAt) {
    recClass = ' started'; recText = '00:00';
  } else {
    recClass = ''; recText = '開始';
  }
  return `<div class="wa-set-row" data-si="${si}" data-type="${type}" data-i="${i}">
    <span class="wa-set-num">${label}</span>
    <div class="wa-set-body">
      <div class="wa-set-main-row">
        <input class="wa-set-input weight-input" type="number" value="${wVal}" placeholder="-">
        <span class="wa-set-unit">kg</span>
        <span class="wa-set-cross">×</span>
        <input class="wa-set-input reps-input" type="number" value="${rVal}" placeholder="-">
        <span class="wa-set-unit">${unit === '秒' ? '秒' : '回'}</span>
        <button class="wa-record-btn${recClass}" data-si="${si}" data-type="${type}" data-i="${i}">${recText}</button>
      </div>
      <div class="wa-set-injury">
        <button type="button" class="wa-set-injury-toggle${hasInjury}">🩹 怪我<span class="wa-set-injury-chev"${chevStyle}>▼</span></button>
        <div class="wa-set-injury-body${injuryOpen}">
          <div class="wa-injury-row">
            <select class="wa-injury-select injury-site-input">
              <option value="">部位</option>
              ${S.injurySites.map(s => `<option${s === set.injurySite ? ' selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
            <select class="wa-injury-select injury-level-input">
              <option value="">程度</option>
              <option${set.injuryLevel === '違和感' ? ' selected' : ''}>違和感</option>
              <option${set.injuryLevel === '支障あり' ? ' selected' : ''}>支障あり</option>
              <option${set.injuryLevel === '中断レベル' ? ' selected' : ''}>中断レベル</option>
            </select>
          </div>
          <textarea class="wa-memo-input injury-memo-input" rows="2" placeholder="怪我メモ（任意）">${esc(set.injuryMemo || '')}</textarea>
        </div>
      </div>
      <div class="wa-set-memo">
        <textarea class="wa-memo-input set-memo-input" rows="2" placeholder="メモ（任意）">${esc(set.memo || '')}</textarea>
      </div>
    </div>
  </div>`;
}

function syncS3InjuryState() {
  const body = document.getElementById('s3-body');
  if (!body) return;
  S.s3Sections.forEach((sec, si) => {
    ['warmup', 'main'].forEach(type => {
      sec[type].forEach((set, i) => {
        const row = body.querySelector(`.wa-set-row[data-si="${si}"][data-type="${type}"][data-i="${i}"]`);
        if (!row) return;
        const injBody = row.querySelector('.wa-set-injury-body');
        if (injBody) {
          set.injurySite  = row.querySelector('.injury-site-input')?.value  || '';
          set.injuryLevel = row.querySelector('.injury-level-input')?.value || '';
          set.injuryMemo  = row.querySelector('.injury-memo-input')?.value  || '';
          set.injuryOpen  = injBody.classList.contains('open');
        }
        set.memo = row.querySelector('.set-memo-input')?.value || '';
      });
    });
  });
}

function attachRecordBtnEvents(btn) {
  let longPressTimer = null;
  let longPressFired = false;
  let touchStartX = 0;
  let touchStartY = 0;

  const cancelLongPress = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  };

  const startLongPress = () => {
    const si = parseInt(btn.dataset.si);
    const type = btn.dataset.type;
    const i = parseInt(btn.dataset.i);
    const set = S.s3Sections[si][type][i];
    if (set.recorded || set.startedAt) return;
    longPressFired = false;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressFired = true;
      showConfirm('タイマーなしで記録', 'タイマーを使わずに記録しますか？', () => doRecordSet(btn, null), { okLabel: '記録する', accent: true });
    }, 600);
  };

  btn.addEventListener('mousedown', startLongPress);
  btn.addEventListener('mouseup', cancelLongPress);
  btn.addEventListener('mouseleave', cancelLongPress);
  btn.addEventListener('touchstart', e => {
    e.preventDefault();
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    startLongPress();
  }, { passive: false });
  btn.addEventListener('touchend', e => { e.preventDefault(); cancelLongPress(); if (!longPressFired) onRecordSet(btn); });
  btn.addEventListener('touchmove', e => {
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (dx * dx + dy * dy > 100) cancelLongPress();
  });
  btn.addEventListener('touchcancel', cancelLongPress);
  btn.addEventListener('click', () => { if (longPressFired) { longPressFired = false; return; } onRecordSet(btn); });
}

function onRecordSet(btn) {
  const si = parseInt(btn.dataset.si);
  const type = btn.dataset.type;
  const i = parseInt(btn.dataset.i);
  const set = S.s3Sections[si][type][i];

  if (set.recorded) {
    showConfirm('記録を取り消す', 'このセットの記録を削除しますか？', () => {
      set.recorded = false;
      set.recordedAt = null;
      set.startedAt = null;
      set.duration = null;
      btn.textContent = '開始';
      btn.classList.remove('recorded');
      const exMaster = S.exercises.find(e => e.name === S.session.exercises[S.currentExIdx].name);
      refreshIntervals(si, type, exMaster);
      updateCompleteBtn();
      updatePulseBtn();
    });
    return;
  }

  if (!set.startedAt) {
    // カウント中ボタン（緑点滅）をリセット。recordedボタンは.startedを持たないので安全
    document.querySelectorAll('.wa-record-btn.started').forEach(prev => {
      const psi = parseInt(prev.dataset.si), ptype = prev.dataset.type, pi = parseInt(prev.dataset.i);
      if (S.s3Sections[psi]?.[ptype]?.[pi]) S.s3Sections[psi][ptype][pi].startedAt = null;
      prev.classList.remove('started');
      prev.textContent = '開始';
    });
    // オレンジ点滅（pulse）もすべて消す
    document.getElementById('s3-body')?.querySelectorAll('.wa-record-btn.pulse').forEach(b => b.classList.remove('pulse'));
    set.startedAt = Date.now();
    btn.classList.remove('pulse');
    btn.classList.add('started');
    btn.textContent = '00:00';
    return;
  }

  doRecordSet(btn, Math.round((Date.now() - set.startedAt) / 1000));
}

function doRecordSet(btn, duration) {
  const si = parseInt(btn.dataset.si);
  const type = btn.dataset.type;
  const i = parseInt(btn.dataset.i);
  const set = S.s3Sections[si][type][i];

  const row = btn.closest('.wa-set-row');
  set.weight = parseFloat(row.querySelector('.weight-input').value) || null;
  set.reps = parseFloat(row.querySelector('.reps-input').value) || null;
  set.recorded = true;
  set.recordedAt = Date.now();
  set.duration = duration;
  btn.classList.remove('started');
  btn.classList.add('recorded');
  btn.textContent = '✓ 記録済';

  const exMaster = S.exercises.find(e => e.name === S.session.exercises[S.currentExIdx].name);
  refreshIntervals(si, type, exMaster);
  updateCompleteBtn();
  updatePulseBtn();
}

function refreshIntervals(si, type, exMaster) {
  if (type !== 'main') return;
  const body = document.getElementById('s3-body');
  const sec = S.s3Sections[si];
  // Remove old interval lines for this section
  body.querySelectorAll(`.wa-interval-auto[data-si="${si}"]`).forEach(el => el.remove());
  sec.main.forEach((set, i) => {
    if (i === 0 || !set.recordedAt || !sec.main[i - 1].recordedAt) return;
    const diff = Math.round((set.recordedAt - sec.main[i - 1].recordedAt) / 1000);
    const rows = body.querySelectorAll(`.wa-set-row[data-si="${si}"][data-type="main"]`);
    if (rows[i]) {
      const line = document.createElement('div');
      line.className = 'wa-interval-auto';
      line.dataset.si = si;
      line.textContent = `${setNumLabel(i - 1, false)}→${setNumLabel(i, false)} ${diff}秒`;
      rows[i].insertAdjacentElement('beforebegin', line);
    }
  });
}

function onAddSet(btn) {
  const si = parseInt(btn.dataset.si);
  const type = btn.dataset.type;
  const s3Body = document.getElementById('s3-body');
  S.s3Sections.forEach((sec, secIdx) => {
    ['warmup', 'main'].forEach(t => {
      sec[t].forEach((set, i) => {
        const row = s3Body?.querySelector(`.wa-set-row[data-si="${secIdx}"][data-type="${t}"][data-i="${i}"]`);
        if (row) {
          set.weight = parseFloat(row.querySelector('.weight-input').value) || null;
          set.reps = parseFloat(row.querySelector('.reps-input').value) || null;
        }
      });
    });
  });
  S.s3Sections[si][type].push({ weight: null, reps: null, recorded: false, recordedAt: null, startedAt: null, duration: null, injurySite: '', injuryLevel: '', injuryMemo: '', injuryOpen: false, memo: '' });
  const exMaster = S.exercises.find(e => e.name === S.session.exercises[S.currentExIdx].name);
  renderS3Body(exMaster);
  document.getElementById('s3-body').scrollTop = 9999;
}

async function completeEx() {
  const ex = S.session.exercises[S.currentExIdx];
  const exMaster = S.exercises.find(e => e.name === ex.name);
  const unit = exMaster?.unit || '回';
  const targetInterval = parseInt(document.getElementById('s3-interval').value) || 0;
  const today = todayStr();

  syncS3InjuryState();

  const sets = [];
  const s3Body = document.getElementById('s3-body');
  S.s3Sections.forEach((sec, si) => {
    sec.warmup.forEach((set, i) => {
      if (!set.recorded) return;
      const row = s3Body?.querySelector(`.wa-set-row[data-si="${si}"][data-type="warmup"][data-i="${i}"]`);
      const weight = row ? (parseFloat(row.querySelector('.weight-input').value) || null) : set.weight;
      const reps   = row ? (parseFloat(row.querySelector('.reps-input').value)  || null) : set.reps;
      sets.push({
        type: 'ウォームアップ', setNum: i + 1, side: sec.side,
        weight, reps, targetInterval,
        time: set.recordedAt ? timeFromMs(set.recordedAt) : timeNow(),
        duration: set.duration != null ? set.duration : null,
        injurySite: set.injurySite || '', injuryLevel: set.injuryLevel || '', injuryMemo: set.injuryMemo || '',
        memo: set.memo || '',
      });
    });
    sec.main.forEach((set, i) => {
      if (!set.recorded) return;
      const row = s3Body?.querySelector(`.wa-set-row[data-si="${si}"][data-type="main"][data-i="${i}"]`);
      const weight = row ? (parseFloat(row.querySelector('.weight-input').value) || null) : set.weight;
      const reps   = row ? (parseFloat(row.querySelector('.reps-input').value)  || null) : set.reps;
      sets.push({
        type: 'メイン', setNum: i + 1, side: sec.side,
        weight, reps, targetInterval,
        time: set.recordedAt ? timeFromMs(set.recordedAt) : timeNow(),
        duration: set.duration != null ? set.duration : null,
        injurySite: set.injurySite || '', injuryLevel: set.injuryLevel || '', injuryMemo: set.injuryMemo || '',
        memo: set.memo || '',
      });
    });
  });

  ex.done = true;
  ex.sets = sets;

  if (sets.length > 0) {
    const rows = sets.map(s => ({
      user_id:         _userId,
      session_id:      S.session.sessionId,
      ex_instance_id:  ex.exInstanceId || '',
      date:            today,
      time:            s.time || '',
      menu:            menuStorage(S.session.menu),
      exercise:        ex.name,
      set_type:        s.type,
      set_num:         s.setNum,
      side:            s.side || '',
      weight:          s.weight  != null ? s.weight  : null,
      reps:            s.reps    != null ? s.reps    : null,
      target_interval: s.targetInterval != null ? s.targetInterval : null,
      injury_site:     s.injurySite  || '',
      injury_level:    s.injuryLevel || '',
      injury_memo:     s.injuryMemo  || '',
      memo:            s.memo        || '',
      duration:        s.duration    != null ? s.duration : null,
    }));
    const { error } = await sb.from('records').insert(rows);
    if (error) { showToast('記録の保存に失敗しました'); console.error(error); }
    S.injuryRecords = null;
  }

  if (exMaster && targetInterval !== exMaster.defaultInterval) {
    exMaster.defaultInterval = targetInterval;
    const { error } = await sb.from('exercises')
      .update({ default_interval: targetInterval })
      .eq('user_id', _userId)
      .eq('name', exMaster.name);
    if (error) console.error('インターバル更新失敗', error);
  }

  const nextIdx = S.session.exercises.findIndex((e, i) => i > S.currentExIdx && !e.done);
  S.currentExIdx = nextIdx !== -1 ? nextIdx : null;
  renderS2();
  showRecordScreen('s2');
}

function timeFromMs(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// =====================================================================
//  記録タブ: 終了画面
// =====================================================================
function buildObsidianText(doneExes, menuDisplayName, startTime, endTime, totalMin) {
  const lines = [`### 筋トレ：${menuDisplayName}`];
  doneExes.forEach(ex => {
    const unit = S.exercises.find(e => e.name === ex.name)?.unit || '回';
    const mainSets = ex.sets.filter(s => s.type === 'メイン');
    const setsStr = formatHistSets(mainSets, unit);
    lines.push(setsStr ? `  - ${ex.name}　${setsStr}` : `  - ${ex.name}`);
  });
  lines.push(`${startTime}〜${endTime}（${totalMin}分）`);
  return lines.join('\n');
}

function goFinish() {
  const endTime = timeNow();
  S.session.endTime = endTime;
  const totalSec = S.timerStart ? Math.floor((Date.now() - S.timerStart) / 1000) : 0;
  const totalMin = Math.ceil(totalSec / 60);
  const doneExes = S.session.exercises.filter(e => e.done);
  const totalSets = doneExes.reduce((n, e) => n + e.sets.filter(s => s.type === 'メイン').length, 0);

  document.getElementById('finish-time-range').textContent = `${S.session.startTime}〜${endTime}（${totalMin}分）`;
  document.getElementById('finish-ex-count').innerHTML = `${doneExes.length}<em>種目</em>`;
  document.getElementById('finish-set-count').innerHTML = `${totalSets}<em>セット</em>`;
  document.getElementById('finish-obsidian').value = buildObsidianText(doneExes, S.session.menuDisplay, S.session.startTime, endTime, totalMin);
  document.querySelector('.wa-obsidian-wrap').classList.add('pulsing');
  document.querySelectorAll('.wa-choice-btn').forEach(b => b.classList.remove('selected'));

  const btn = document.getElementById('btn-save-session');
  btn.textContent = '保存して終了';
  btn.disabled = false;

  showRecordScreen('sFinish');
}

async function saveSession() {
  const btn = document.getElementById('btn-save-session');
  btn.textContent = '保存中…';
  btn.disabled = true;

  const endTime = S.session.endTime || timeNow();
  const cond = document.querySelector('.wa-choice-btn[data-group="cond"].selected')?.dataset.val || '';
  const satis = document.querySelector('.wa-choice-btn[data-group="satis"].selected')?.dataset.val || '';
  const comment = document.getElementById('finish-comment').value || '';

  const { error } = await sb.from('sessions').insert({
    user_id:      _userId,
    session_id:   S.session.sessionId,
    date:         todayStr(),
    menu:         menuStorage(S.session.menu),
    start_time:   S.session.startTime,
    end_time:     endTime,
    condition:    cond,
    satisfaction: satis,
    comment:      comment,
  });
  if (error) {
    showToast('保存に失敗しました');
    btn.textContent = '保存して終了';
    btn.disabled = false;
    return;
  }

  showToast('保存しました！');
  stopTimer();
  S.session = null;
  S.currentExIdx = null;
  S.s3ExData = null;
  S.s3ExCache = {};
  S.histDateItems = [];
  S.histDateOffset = 0;
  renderS1();
  showRecordScreen('s1');

  // 「前回〇日前」表示を更新するためバックグラウンドで再取得
  sbGetInitialData().then(data => {
    S.menuLastDates = data.menuLastDates || {};
    S.recentSingle = data.recentSingle || [];
    S.stats = data.stats || null;
    renderS1();
    renderStats();
  }).catch(() => {});
}

function stopTimer() {
  clearInterval(S.timerInterval);
  S.timerInterval = null;
  S.timerStart = null;
  const el = document.getElementById('session-timer');
  if (el) el.textContent = '00:00';
  const el3 = document.getElementById('s3-timer');
  if (el3) el3.textContent = '00:00';
}

// セッションに種目を追加（画面2の「種目を追加」）
function openSessionExAdd() {
  const already = new Set(S.session.exercises.map(e => e.name));
  let html = S.exercises.map(e =>
    `<div class="modal-ex-row" data-name="${esc(e.name)}">
      ${esc(e.name)}
      <span>${esc(e.bodyPart)}</span>
    </div>`
  ).join('');
  document.getElementById('modal-session-ex-list').innerHTML = html;
  document.querySelectorAll('#modal-session-ex-list .modal-ex-row').forEach(el => {
    el.addEventListener('click', () => {
      S.session.exercises.push({ name: el.dataset.name, done: false, sets: [], exInstanceId: 'exinst_' + Date.now() + '_' + S.session.exercises.length });
      closeModal('modal-session-ex-add');
      renderS2();
    });
  });
  document.getElementById('modal-session-ex-search').value = '';
  document.getElementById('modal-session-ex-search').oninput = function () {
    const lc = this.value.toLowerCase();
    document.querySelectorAll('#modal-session-ex-list .modal-ex-row').forEach(el => {
      el.style.display = el.dataset.name.toLowerCase().includes(lc) ? '' : 'none';
    });
  };
  openModal('modal-session-ex-add');
}

// =====================================================================
//  履歴タブ
// =====================================================================
async function loadHistoryDate() {
  const list = document.getElementById('hist-date-list');
  const moreBtn = document.getElementById('btn-hist-date-more');
  const isLoadMore = S.histDateOffset > 0;

  if (!isLoadMore) {
    list.innerHTML = '<div class="loading-msg">読み込み中…</div>';
  } else {
    moreBtn.textContent = '読み込み中…';
    moreBtn.disabled = true;
  }

  try {
    const data = await sbGetHistory(S.histDateOffset);
    const sessions = data.sessions || [];
    S.histDateHasMore = data.hasMore || false;
    if (!isLoadMore) { S.histDateItems = sessions; list.innerHTML = ''; }
    else S.histDateItems = S.histDateItems.concat(sessions);
    renderHistoryDate(sessions, !isLoadMore);
    S.histDateOffset += sessions.length;
    document.getElementById('hist-date-more-wrap').style.display = S.histDateHasMore ? '' : 'none';
    if (isLoadMore) { moreBtn.textContent = 'もっと見る'; moreBtn.disabled = false; }
  } catch (e) {
    if (!isLoadMore) {
      list.innerHTML = '<div class="loading-msg">読み込みに失敗しました。再度お試しください。</div>';
    } else {
      moreBtn.textContent = 'もっと見る';
      moreBtn.disabled = false;
      document.getElementById('hist-date-more-wrap').style.display = '';
      showToast('読み込みに失敗しました。再度お試しください。');
    }
  }
}

function renderHistoryDate(sessions, clear) {
  const list = document.getElementById('hist-date-list');
  if (clear) list.innerHTML = '';
  sessions.forEach((sess, rawIdx) => {
    const idx = clear ? rawIdx : S.histDateItems.length - sessions.length + rawIdx;
    const id = 'sess-' + idx;
    const dur = calcDuration(sess.startTime, sess.endTime);
    const exes = sess.exercises || [];
    const menuLabel = sess.menu
      ? menuDisplay(sess.menu)
      : exes.length >= 2
        ? `${exes.length}種目：${exes.map(e => e.name).join('・')}`
        : (exes[0]?.name || '');
    const div = document.createElement('div');
    div.className = 'wa-session-item';
    div.id = id;
    div.innerHTML = `<div class="wa-session-header">
        <div class="wa-session-date">${esc(dateLabel(sess.date))}<span>${esc(sess.startTime)}〜</span></div>
        <div class="wa-session-menu">${esc(menuLabel)}</div>
        <div class="wa-session-dur">${dur}</div>
        <div class="wa-session-chev">▼</div>
      </div>
      <div class="wa-session-body">
        ${sess.condition || sess.satisfaction ? `<div class="wa-session-cond">
          ${sess.condition ? `<div>コンディション：<span>${esc(sess.condition)}</span></div>` : ''}
          ${sess.satisfaction ? `<div>満足度：<span>${esc(sess.satisfaction)}</span></div>` : ''}
        </div>` : ''}
        ${sess.comment ? `<div class="wa-session-feeling">${parseMemo(sess.comment)}</div>` : ''}
        ${buildSessionExRows(sess, id, idx)}
      <button class="wa-session-edit-btn" data-sess-idx="${idx}">セッションを編集</button>
      </div>`;
    div.querySelector('.wa-session-header').addEventListener('click', () => div.classList.toggle('expanded'));
    div.querySelectorAll('.wa-ex-row-name').forEach(el => {
      el.addEventListener('click', e => { e.stopPropagation(); goHistExDetail(el.dataset.name, id); });
    });
    div.querySelector('.wa-session-edit-btn').addEventListener('click', e => {
      e.stopPropagation();
      openSessionEditModal(parseInt(e.currentTarget.dataset.sessIdx));
    });
    div.querySelectorAll('.wa-ex-row-edit').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        openRecordEditModal(parseInt(el.dataset.sessIdx), el.dataset.name, el.dataset.exInstanceId);
      });
    });
    list.appendChild(div);
  });
}

function buildSessionExRows(sess, sessId, sessIdx) {
  const exes = sess.exercises || [];
  return exes.map(({ name, exInstanceId, sets }) => {
    const mainSets = sets.filter(s => s.setType === 'メイン');
    const unit = S.exercises.find(e => e.name === name)?.unit || '回';
    const mainLine = formatHistSets(mainSets, unit);
    const injuries = sets.filter(s => s.injurySite).map(s => {
      const base = esc(`${setNumLabel(s.setNum - 1, s.setType === 'ウォームアップ')}${s.injurySite}・${s.injuryLevel}`);
      return base + (s.injuryMemo ? `：${parseMemo(s.injuryMemo)}` : '');
    }).join('<br>');
    return `<div class="wa-ex-row">
      <div class="wa-ex-row-header">
        <div class="wa-ex-row-name" data-name="${esc(name)}">${esc(name)}</div>
        <button class="wa-ex-row-edit" data-sess-idx="${sessIdx}" data-name="${esc(name)}" data-ex-instance-id="${esc(exInstanceId || '')}">編集</button>
      </div>
      ${mainLine ? `<div class="wa-ex-row-main">${esc(mainLine)}</div>` : ''}
      ${buildIndividualSetLines(sets, unit)}
      ${injuries ? `<div class="wa-ex-row-injury">${injuries}</div>` : ''}
    </div>`;
  }).join('');
}

function toggleExpandAll(btnId, listId, itemClass) {
  const btn = document.getElementById(btnId);
  const list = document.getElementById(listId);
  const items = list.querySelectorAll('.' + itemClass);
  const allExpanded = [...items].every(el => el.classList.contains('expanded'));
  items.forEach(el => el.classList.toggle('expanded', !allExpanded));
  btn.textContent = allExpanded ? 'すべて開く▼' : 'すべて閉じる▲';
}

function formatHistSets(sets, unit) {
  const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  let idx = 0;
  return sets.map(s => {
    let val = '';
    if (s.weight != null) val = `${s.weight}kg×${s.reps}${unit === '秒' ? '秒' : ''}`;
    else if (s.reps != null) val = `${s.reps}${unit === '秒' ? '秒' : '回'}`;
    if (!val) return '';
    return (circled[idx++] || `${idx}`) + val;
  }).filter(Boolean).join(' ');
}

function buildIndividualSetLines(sets, unit) {
  return sets.map(s => {
    const isWarm = s.setType === 'ウォームアップ';
    const label = setNumLabel(s.setNum - 1, isWarm) + (s.side ? s.side : '');
    let mid = '';
    if (s.weight != null) mid = `${s.weight}kg×${s.reps}${unit === '秒' ? '秒' : ''}`;
    else if (s.reps != null) mid = `${s.reps}${unit === '秒' ? '秒' : '回'}`;
    if (!mid && !s.memo) return '';
    if (s.duration != null) mid += `（${pad2(Math.floor(s.duration / 60))}:${pad2(s.duration % 60)}）`;
    const memoHtml = s.memo ? `<span class="wa-set-line-memo">：${parseMemo(s.memo)}</span>` : '';
    return `<div class="wa-hist-set-line">${esc(label + mid)}${memoHtml}</div>`;
  }).filter(Boolean).join('');
}

function calcDuration(start, end) {
  if (!start || !end) return '';
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff <= 0) return '';
  return `${diff}分`;
}

async function loadHistExList() {
  const list = document.getElementById('hist-ex-list');
  if (S.histExWithLastDate) { renderHistExList(S.histExWithLastDate.exercises); return; }
  list.innerHTML = '<div class="loading-msg">読み込み中…</div>';
  try {
    const data = await sbGetExercisesWithLastDate();
    S.histExWithLastDate = data;
    renderHistExList(data.exercises || []);
  } catch (e) {
    list.innerHTML = '<div class="loading-msg">読み込みに失敗しました</div>';
  }
}

function renderHistExList(exercises, filter = '') {
  const lc = filter.toLowerCase();
  const filtered = filter ? exercises.filter(e => e.name.toLowerCase().includes(lc)) : exercises;
  document.getElementById('hist-ex-list').innerHTML = filtered.map(e =>
    `<div class="wa-ex-list-item" data-name="${esc(e.name)}">
      <span class="wa-ex-list-name">${esc(e.name)}</span>
      <span class="wa-ex-list-meta">前回 ${esc(dateLabel(e.lastDate))}（${e.daysAgo}日前）</span>
      <span class="wa-ex-list-chev">▶</span>
    </div>`
  ).join('');
  document.querySelectorAll('#hist-ex-list .wa-ex-list-item').forEach(el => {
    el.addEventListener('click', () => goHistExDetail(el.dataset.name, null));
  });
}

async function goHistExDetail(name, fromSession) {
  S.histCurrentEx = name;
  S.histFromSession = fromSession;
  S.histExOffset = 0;
  S.histExItems = [];
  document.getElementById('hist-ex-detail-title').textContent = name;
  const backLabel = document.getElementById('hist-ex-back-label');
  if (fromSession) {
    const dateEl = document.querySelector('#' + fromSession + ' .wa-session-date');
    backLabel.textContent = (dateEl ? dateEl.textContent.trim() : '') + 'の記録に戻る';
    document.getElementById('hist-tab-ex').click();
  } else {
    backLabel.textContent = '種目一覧に戻る';
  }
  document.getElementById('hist-ex-list-view').style.display = 'none';
  document.getElementById('hist-ex-detail-view').style.display = '';

  const list = document.getElementById('hist-ex-detail-list');
  list.innerHTML = '<div class="loading-msg">読み込み中…</div>';
  await loadHistExDetail();
}

async function loadHistExDetail() {
  const list = document.getElementById('hist-ex-detail-list');
  const moreBtn = document.getElementById('btn-hist-ex-more');
  const isLoadMore = S.histExOffset > 0;

  if (isLoadMore) {
    moreBtn.textContent = '読み込み中…';
    moreBtn.disabled = true;
  }

  try {
    const data = await sbGetExerciseHistory(S.histCurrentEx, S.histExOffset);
    const dates = data.dates || [];
    S.histExHasMore = data.hasMore || false;
    if (!isLoadMore) { S.histExItems = dates; list.innerHTML = ''; }
    else S.histExItems = S.histExItems.concat(dates);
    renderHistExDetail(dates, !isLoadMore);
    S.histExOffset += dates.length;
    document.getElementById('hist-ex-detail-more-wrap').style.display = S.histExHasMore ? '' : 'none';
    if (isLoadMore) { moreBtn.textContent = 'もっと見る'; moreBtn.disabled = false; }
  } catch (e) {
    if (!isLoadMore) {
      list.innerHTML = '<div class="loading-msg">読み込みに失敗しました。再度お試しください。</div>';
    } else {
      moreBtn.textContent = 'もっと見る';
      moreBtn.disabled = false;
      document.getElementById('hist-ex-detail-more-wrap').style.display = '';
      showToast('読み込みに失敗しました。再度お試しください。');
    }
  }
}

function appendExHistItems(dates, unit, container, idPrefix) {
  dates.forEach(d => {
    const mainSets = d.sets.filter(s => s.setType === 'メイン');
    const mainLine = formatHistSets(mainSets, unit);
    const injuries = d.sets.filter(s => s.injurySite).map(s => {
      const base = esc(`${setNumLabel(s.setNum - 1, s.setType === 'ウォームアップ')}${s.injurySite}・${s.injuryLevel}`);
      return base + (s.injuryMemo ? `：${parseMemo(s.injuryMemo)}` : '');
    }).join('<br>');
    const div = document.createElement('div');
    div.className = 'wa-ex-hist-item';
    if (idPrefix) div.id = idPrefix + (d.exInstanceId || d.date);
    const timeStr = d.time ? ` ${d.time}〜` : '';
    const elapsedHtml = d.exerciseElapsed > 0 ? ` <span class="wa-hist-elapsed">（${d.exerciseElapsed}分）</span>` : '';
    const daysSinceHtml = d.daysSincePrev != null ? `<div class="wa-hist-days-since">前回から${d.daysSincePrev}日</div>` : '';
    const firstMainInterval = d.sets.find(s => s.setType === 'メイン')?.targetInterval ?? null;
    const intervalHtml = firstMainInterval != null ? `<div class="wa-hist-interval">インターバル：${firstMainInterval}秒</div>` : '';
    div.innerHTML = `<div class="wa-ex-hist-header">
        <div class="wa-ex-hist-date">${esc(dateLabel(d.date) + timeStr)}</div>
        <div class="wa-ex-hist-sets">${esc(mainLine)}${elapsedHtml}</div>
        <div class="wa-ex-hist-chev">▼</div>
      </div>
      <div class="wa-ex-hist-body">
        ${daysSinceHtml}
        ${intervalHtml}
        ${buildIndividualSetLines(d.sets, unit)}
        ${injuries ? `<div class="wa-ex-hist-injury">${injuries}</div>` : ''}
      </div>`;
    div.querySelector('.wa-ex-hist-header').addEventListener('click', () => div.classList.toggle('expanded'));
    container.appendChild(div);
  });
}

function renderHistExDetail(dates, clear) {
  const list = document.getElementById('hist-ex-detail-list');
  if (clear) list.innerHTML = '';
  const unit = S.exercises.find(e => e.name === S.histCurrentEx)?.unit || '回';
  appendExHistItems(dates, unit, list, 'exh-h-');
}

function updateS3HistStats() {
  const el = document.getElementById('s3-hist-stats');
  if (!el) return;
  const data = S.s3ExData;
  if (!data || data.totalMainSets == null) { el.textContent = ''; return; }
  const dayStr = data.daysSinceLast === 0 ? '本日' : `前回から${data.daysSinceLast}日`;
  el.textContent = `累計 ${data.totalMainSets}セット　${dayStr}`;
}

function resetS3HistPanel() {
  S.s3HistOffset = 0;
  S.s3HistHasMore = false;
  S.s3HistLoaded = false;
  const list = document.getElementById('s3-hist-list');
  if (list) list.innerHTML = '';
  const moreWrap = document.getElementById('s3-hist-more-wrap');
  if (moreWrap) moreWrap.style.display = 'none';
  const panel = document.getElementById('s3-hist-panel');
  if (panel) panel.classList.remove('open');
  const injuryPanel = document.getElementById('s3-injury-panel');
  if (injuryPanel) injuryPanel.classList.remove('open');
}

async function loadS3Hist(append = false) {
  const exName = S.session?.exercises[S.currentExIdx]?.name;
  if (!exName) return;
  const list = document.getElementById('s3-hist-list');
  const moreBtn = document.getElementById('btn-s3-hist-more');
  const moreWrap = document.getElementById('s3-hist-more-wrap');
  if (!append) {
    list.innerHTML = '<div class="loading-msg">読み込み中…</div>';
  } else {
    moreBtn.textContent = '読み込み中…';
    moreBtn.disabled = true;
  }
  try {
    const data = await sbGetExerciseHistory(exName, S.s3HistOffset);
    const dates = data.dates || [];
    S.s3HistHasMore = data.hasMore || false;
    S.s3HistLoaded = true;
    if (!append) list.innerHTML = '';
    const unit = S.exercises.find(e => e.name === exName)?.unit || '回';
    appendExHistItems(dates, unit, list, 's3h-');
    S.s3HistOffset += dates.length;
    moreWrap.style.display = S.s3HistHasMore ? '' : 'none';
    if (append) { moreBtn.textContent = 'もっと見る'; moreBtn.disabled = false; }
  } catch {
    if (!append) list.innerHTML = '<div class="loading-msg">読み込みに失敗しました。</div>';
    else { moreBtn.textContent = 'もっと見る'; moreBtn.disabled = false; }
  }
}

function backFromHistExDetail() {
  if (S.histFromSession) {
    const sessEl = document.getElementById(S.histFromSession);
    if (sessEl && !sessEl.classList.contains('expanded')) sessEl.classList.add('expanded');
    document.getElementById('hist-tab-date').click();
  }
  document.getElementById('hist-ex-list-view').style.display = '';
  document.getElementById('hist-ex-detail-view').style.display = 'none';
  S.histCurrentEx = null;
  S.histFromSession = null;
}

function openRecordEditModal(sessIdx, exName, exInstanceId) {
  const sess = S.histDateItems[sessIdx];
  if (!sess) return;
  const exEntry  = (sess.exercises || []).find(e => exInstanceId ? e.exInstanceId === exInstanceId : e.name === exName);
  const sets     = exEntry?.sets || [];
  const exMaster = S.exercises.find(e => e.name === exName);
  const unit     = exMaster?.unit || '回';
  const hasSides = exMaster?.hasSides || false;

  const buildSide = side => ({
    side,
    warmup: sets.filter(s => s.setType === 'ウォームアップ' && s.side === side)
                .map(s => ({ weight: s.weight, reps: s.reps, injurySite: s.injurySite || '', injuryLevel: s.injuryLevel || '', injuryMemo: s.injuryMemo || '', injuryOpen: !!(s.injurySite), memo: s.memo || '' })),
    main:   sets.filter(s => s.setType === 'メイン' && s.side === side)
                .map(s => ({ weight: s.weight, reps: s.reps, injurySite: s.injurySite || '', injuryLevel: s.injuryLevel || '', injuryMemo: s.injuryMemo || '', injuryOpen: !!(s.injurySite), memo: s.memo || '' })),
  });

  const sections = hasSides ? [buildSide('右'), buildSide('左')] : [buildSide('')];

  S.editingRecord = {
    sessIdx, exName,
    exInstanceId: exEntry?.exInstanceId || '',
    date:      sess.date,
    menu:      sess.menu,
    sessionId: sess.sessionId,
    unit, hasSides, sections,
  };

  document.getElementById('modal-rec-title').textContent = exName + 'を編集';
  document.getElementById('modal-rec-datetime').textContent = dateLabel(sess.date);
  renderRecordEditBody();
  openModal('modal-record-edit');
}

function renderRecordEditBody() {
  const { sections, unit, hasSides } = S.editingRecord;
  const body = document.getElementById('modal-rec-body');
  let html = '';

  sections.forEach((sec, si) => {
    if (hasSides) html += `<div class="wa-side-section-label">${esc(sec.side)}セクション</div>`;
    if (sec.warmup.length > 0) {
      html += `<div class="wa-section-label">ウォームアップ</div>`;
      sec.warmup.forEach((set, i) => { html += buildRecordSetRow(si, 'warmup', i, set, unit); });
    }
    html += `<button class="wa-add-btn" data-si="${si}" data-type="warmup">＋ ウォームアップ追加</button>`;
    html += `<div class="wa-section-label">メイン</div>`;
    sec.main.forEach((set, i) => { html += buildRecordSetRow(si, 'main', i, set, unit); });
    html += `<button class="wa-add-btn" data-si="${si}" data-type="main">＋ セット追加</button>`;
    if (si < sections.length - 1) html += '<div class="wa-divider"></div>';
  });


  body.innerHTML = html;

  body.querySelectorAll('.wa-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      syncRecordEditState();
      S.editingRecord.sections[parseInt(btn.dataset.si)][btn.dataset.type].push({ weight: null, reps: null, injurySite: '', injuryLevel: '', injuryMemo: '', injuryOpen: false, memo: '' });
      renderRecordEditBody();
    });
  });
  body.querySelectorAll('.wa-rec-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      syncRecordEditState();
      S.editingRecord.sections[parseInt(btn.dataset.si)][btn.dataset.type].splice(parseInt(btn.dataset.i), 1);
      renderRecordEditBody();
    });
  });
  body.querySelectorAll('.wa-set-injury-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const injBody = btn.nextElementSibling;
      const open = injBody.classList.toggle('open');
      btn.querySelector('.wa-set-injury-chev').style.transform = open ? 'rotate(180deg)' : '';
    });
  });
}

function buildRecordSetRow(si, type, i, set, unit) {
  const isWarm = type === 'warmup';
  const label  = `<span class="wa-set-prefix">${isWarm ? '準' : ''}</span>${setNumLabel(i, false)}`;
  const wVal   = set.weight != null ? set.weight : '';
  const rVal   = set.reps   != null ? set.reps   : '';
  const hasInjury = set.injurySite ? ' has-injury' : '';
  const injuryOpen = set.injuryOpen ? ' open' : '';
  const chevStyle = set.injuryOpen ? ' style="transform:rotate(180deg)"' : '';
  return `<div class="wa-set-row" data-si="${si}" data-type="${type}" data-i="${i}">
    <span class="wa-set-num">${label}</span>
    <div class="wa-set-body">
      <div class="wa-set-main-row">
        <input class="wa-set-input weight-input" type="number" value="${wVal}" placeholder="-">
        <span class="wa-set-unit">kg</span>
        <span class="wa-set-cross">×</span>
        <input class="wa-set-input reps-input" type="number" value="${rVal}" placeholder="-">
        <span class="wa-set-unit">${unit === '秒' ? '秒' : '回'}</span>
        <button class="wa-rec-del-btn" data-si="${si}" data-type="${type}" data-i="${i}">✕</button>
      </div>
      <div class="wa-set-injury">
        <button type="button" class="wa-set-injury-toggle${hasInjury}">🩹 怪我<span class="wa-set-injury-chev"${chevStyle}>▼</span></button>
        <div class="wa-set-injury-body${injuryOpen}">
          <div class="wa-injury-row">
            <select class="wa-injury-select injury-site-input">
              <option value="">部位</option>
              ${S.injurySites.map(s => `<option${s === set.injurySite ? ' selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
            <select class="wa-injury-select injury-level-input">
              <option value="">程度</option>
              <option${set.injuryLevel === '違和感' ? ' selected' : ''}>違和感</option>
              <option${set.injuryLevel === '支障あり' ? ' selected' : ''}>支障あり</option>
              <option${set.injuryLevel === '中断レベル' ? ' selected' : ''}>中断レベル</option>
            </select>
          </div>
          <textarea class="wa-memo-input injury-memo-input" rows="2" placeholder="怪我メモ（任意）">${esc(set.injuryMemo || '')}</textarea>
        </div>
      </div>
      <div class="wa-set-memo">
        <textarea class="wa-memo-input set-memo-input" rows="2" placeholder="メモ（任意）">${esc(set.memo || '')}</textarea>
      </div>
    </div>
  </div>`;
}

function syncRecordEditState() {
  const body = document.getElementById('modal-rec-body');
  if (!body || !S.editingRecord) return;
  S.editingRecord.sections.forEach((sec, si) => {
    ['warmup', 'main'].forEach(type => {
      sec[type].forEach((set, i) => {
        const row = body.querySelector(`.wa-set-row[data-si="${si}"][data-type="${type}"][data-i="${i}"]`);
        if (!row) return;
        const w = row.querySelector('.weight-input').value;
        const r = row.querySelector('.reps-input').value;
        set.weight = w !== '' ? parseFloat(w) : null;
        set.reps   = r !== '' ? parseFloat(r) : null;
        set.injurySite  = row.querySelector('.injury-site-input')?.value  || '';
        set.injuryLevel = row.querySelector('.injury-level-input')?.value || '';
        set.injuryMemo  = row.querySelector('.injury-memo-input')?.value  || '';
        set.memo        = row.querySelector('.set-memo-input')?.value      || '';
        const injBody = row.querySelector('.wa-set-injury-body');
        set.injuryOpen  = injBody ? injBody.classList.contains('open') : false;
      });
    });
  });
}

async function saveRecordModal() {
  if (!S.editingRecord) return;
  const btn = document.getElementById('modal-rec-save');
  btn.textContent = '保存中…';
  btn.disabled = true;
  syncRecordEditState();
  const { sections, exName, date, menu, sessionId, exInstanceId } = S.editingRecord;

  const sets = [];
  sections.forEach(sec => {
    sec.warmup.forEach((set, i) => {
      sets.push({ type: 'ウォームアップ', setNum: i + 1, side: sec.side,
        weight: set.weight, reps: set.reps,
        injurySite: set.injurySite || '', injuryLevel: set.injuryLevel || '', injuryMemo: set.injuryMemo || '',
        memo: set.memo || '' });
    });
    sec.main.forEach((set, i) => {
      sets.push({ type: 'メイン', setNum: i + 1, side: sec.side,
        weight: set.weight, reps: set.reps,
        injurySite:  set.injurySite  || '',
        injuryLevel: set.injuryLevel || '',
        injuryMemo:  set.injuryMemo  || '',
        memo: set.memo || '' });
    });
  });

  await sbUpdateExerciseRecords({ date, menu: menu || '', exercise: exName, sessionId, exInstanceId, sets });
  btn.textContent = '保存';
  btn.disabled = false;
  closeModal('modal-record-edit');
  S.editingRecord = null;
  showToast('保存しました');
  S.histDateItems = [];
  S.histDateOffset = 0;
  S.injuryRecords = null;
  loadHistoryDate();
}

function deleteExerciseRecordsConfirm() {
  if (!S.editingRecord) return;
  const { exName, date, menu, sessionId, exInstanceId } = S.editingRecord;
  showConfirm('記録を削除',
    `「${exName}」の記録を削除しますか？\nこのセッションのログは残ります。`,
    async () => {
      await sbUpdateExerciseRecords({ date, menu: menu || '', exercise: exName, sessionId, exInstanceId, sets: [] });
      closeModal('modal-record-edit');
      S.editingRecord = null;
      showToast('削除しました');
      S.histDateItems = [];
      S.histDateOffset = 0;
      S.injuryRecords = null;
      loadHistoryDate();
    }
  );
}

function openSessionEditModal(idx) {
  const sess = S.histDateItems[idx];
  if (!sess) return;
  S.editingSession = { ...sess, idx };
  const endPart = sess.endTime ? ' - ' + sess.endTime : '';
  document.getElementById('modal-sess-datetime').textContent =
    dateLabel(sess.date) + '  ' + sess.startTime + endPart;
  setToggle('modal-sess-cond-row', sess.condition || '');
  setToggle('modal-sess-satis-row', sess.satisfaction || '');
  document.getElementById('modal-sess-comment').value = sess.comment || '';
  openModal('modal-session-edit');
}

async function saveSessionModal() {
  if (!S.editingSession) return;
  const condition    = getToggleVal('modal-sess-cond-row');
  const satisfaction = getToggleVal('modal-sess-satis-row');
  const comment      = document.getElementById('modal-sess-comment').value;
  const { error: updErr } = await sb.from('sessions')
    .update({ condition, satisfaction, comment })
    .eq('user_id', _userId)
    .eq('session_id', S.editingSession.sessionId);
  if (updErr) { showToast('保存に失敗しました'); return; }
  const sess = S.histDateItems[S.editingSession.idx];
  if (sess) { sess.condition = condition; sess.satisfaction = satisfaction; sess.comment = comment; }
  closeModal('modal-session-edit');
  S.editingSession = null;
  showToast('保存しました');
  S.histDateItems = [];
  S.histDateOffset = 0;
  loadHistoryDate();
}

function deleteSessionConfirm() {
  if (!S.editingSession) return;
  const sess  = S.editingSession;
  const label = sess.menu ? menuDisplay(sess.menu) : '単発記録';
  showConfirm('セッションを削除',
    `${dateLabel(sess.date)}の${label}を削除しますか？\nこのセッションの記録も全て削除されます。`,
    async () => {
      await sb.from('records').delete().eq('user_id', _userId).eq('session_id', sess.sessionId);
      const { error: delSessErr } = await sb.from('sessions')
        .delete()
        .eq('user_id', _userId)
        .eq('session_id', sess.sessionId);
      if (delSessErr) { showToast('削除に失敗しました'); return; }
      closeModal('modal-session-edit');
      S.editingSession = null;
      showToast('削除しました');
      S.histDateItems = [];
      S.histDateOffset = 0;
      loadHistoryDate();
    }
  );
}

function switchHistTab(view) {
  document.querySelectorAll('.wa-subtab').forEach(t => t.classList.remove('active'));
  document.getElementById('hist-tab-' + (view === 'hist-date-view' ? 'date' : 'ex')).classList.add('active');
  document.querySelectorAll('.hist-view').forEach(v => v.classList.remove('active'));
  document.getElementById(view).classList.add('active');
  if (view === 'hist-ex-view' && !S.histExWithLastDate) loadHistExList();
}

// =====================================================================
//  怪我タブ
// =====================================================================
async function loadInjuryHistory() {
  document.getElementById('injury-date-list').innerHTML = '<div class="loading-msg">読み込み中…</div>';
  document.getElementById('injury-site-list').innerHTML = '<div class="loading-msg">読み込み中…</div>';
  try {
    const data = await sbGetInjuryHistory();
    S.injuryRecords = data.records || [];
    renderInjuryDate();
    renderInjurySite();
  } catch {
    document.getElementById('injury-date-list').innerHTML = '<div class="loading-msg">読み込み失敗</div>';
    document.getElementById('injury-site-list').innerHTML = '<div class="loading-msg">読み込み失敗</div>';
  }
}

function loadS3Injury() {
  const dateList = document.getElementById('s3-injury-date-list');
  if (!dateList) return;
  if (S.injuryRecords !== null) {
    renderInjuryDate(dateList);
    renderInjurySite(document.getElementById('s3-injury-site-list'));
    return;
  }
  dateList.innerHTML = '<div class="loading-msg">読み込み中…</div>';
  sbGetInjuryHistory().then(data => {
    S.injuryRecords = data.records || [];
    renderInjuryDate();
    renderInjurySite();
    renderInjuryDate(dateList);
    renderInjurySite(document.getElementById('s3-injury-site-list'));
  }).catch(() => {
    dateList.innerHTML = '<div class="loading-msg">読み込み失敗</div>';
  });
}

function switchS3RightTab(tab) {
  const isHist = tab === 'hist';
  document.getElementById('s3-tab-hist').classList.toggle('active', isHist);
  document.getElementById('s3-tab-injury').classList.toggle('active', !isHist);
  document.getElementById('s3-hist-panel').classList.toggle('pc-hidden', !isHist);
  document.getElementById('s3-injury-panel').classList.toggle('pc-active', !isHist);
}

function switchS3InjuryTab(view) {
  const isDate = view === 'date';
  document.getElementById('s3-injury-tab-date').classList.toggle('active', isDate);
  document.getElementById('s3-injury-tab-site').classList.toggle('active', !isDate);
  document.getElementById('s3-injury-date-list').style.display = isDate ? '' : 'none';
  document.getElementById('s3-injury-site-list').style.display = isDate ? 'none' : '';
  const expandBtn = document.getElementById('btn-s3-injury-expand-all');
  if (expandBtn) expandBtn.textContent = 'すべて開く▼';
}

function renderInjuryDate(container = null) {
  const list = container || document.getElementById('injury-date-list');
  if (!S.injuryRecords || S.injuryRecords.length === 0) {
    list.innerHTML = '<div class="loading-msg">怪我の記録がありません</div>';
    return;
  }
  const dates = [...new Set(S.injuryRecords.map(r => r.date))];
  list.innerHTML = '';
  dates.forEach(date => {
    const recs = S.injuryRecords.filter(r => r.date === date);
    const bySite = {};
    recs.forEach(r => {
      if (!bySite[r.injurySite]) bySite[r.injurySite] = [];
      bySite[r.injurySite].push(r);
    });
    const sites = Object.keys(bySite).map(s => esc(s)).join('・');
    const div = document.createElement('div');
    div.className = 'wa-session-item';
    div.innerHTML = `<div class="wa-session-header">
        <div class="wa-session-date">${esc(dateLabel(date))}</div>
        <div class="injury-date-sites">${sites}</div>
        <div class="wa-session-chev">▼</div>
      </div>
      <div class="wa-session-body">
        ${Object.keys(bySite).map(site => `
          <div class="injury-site-group">
            <div class="injury-site-label">${esc(site)}</div>
            <div class="injury-rec-rows">
              ${bySite[site].map(r => injuryRecRowHtml(r, false)).join('')}
            </div>
          </div>`).join('')}
      </div>`;
    div.querySelector('.wa-session-header').addEventListener('click', () => div.classList.toggle('expanded'));
    list.appendChild(div);
  });
}

function renderInjurySite(container = null) {
  const list = container || document.getElementById('injury-site-list');
  if (!S.injuryRecords) { list.innerHTML = ''; return; }
  const sitesWithRecs = new Set(S.injuryRecords.map(r => r.injurySite));
  const ordered = [
    ...S.injurySites.filter(s => sitesWithRecs.has(s)),
    ...[...sitesWithRecs].filter(s => !S.injurySites.includes(s))
  ];
  if (ordered.length === 0) {
    list.innerHTML = '<div class="loading-msg">怪我の記録がありません</div>';
    return;
  }
  list.innerHTML = '';
  ordered.forEach(site => {
    const recs = S.injuryRecords.filter(r => r.injurySite === site);
    const dates = [...new Set(recs.map(r => r.date))];
    const bodyHtml = dates.map(date => {
      const rows = recs.filter(r => r.date === date);
      return `<div class="injury-site-group">
        <div class="injury-site-label">${esc(dateLabel(date))}</div>
        <div class="injury-rec-rows">
          ${rows.map(r => injuryRecRowHtml(r, false)).join('')}
        </div>
      </div>`;
    }).join('');
    const card = document.createElement('div');
    card.className = 'injury-site-card';
    card.innerHTML = `
      <div class="injury-site-card-header">
        <div class="injury-site-card-name">${esc(site)}</div>
        <div class="injury-site-card-meta">${recs.length}件</div>
        <div class="injury-site-card-chev">▼</div>
      </div>
      <div class="injury-site-card-body">${bodyHtml}</div>`;
    card.querySelector('.injury-site-card-header').addEventListener('click', () => card.classList.toggle('expanded'));
    list.appendChild(card);
  });
}

function injuryRecRowHtml(r, showDate) {
  const setLabel = setNumLabel(r.setNum - 1, r.setType === 'ウォームアップ');
  return `<div class="injury-rec-row">
    ${showDate ? `<span class="injury-rec-date">${esc(dateLabel(r.date))}</span>` : ''}
    <span class="injury-rec-ex">${esc(r.exercise)}</span>
    <span class="injury-rec-set">${esc(setLabel)}</span>
    <span class="injury-rec-level">${esc(r.injuryLevel)}</span>
    ${r.injuryMemo ? `<div class="injury-rec-memo">${parseMemo(r.injuryMemo)}</div>` : ''}
  </div>`;
}

function switchInjuryTab(view) {
  document.querySelectorAll('#tab-injury .wa-subtab').forEach(t => t.classList.remove('active'));
  document.getElementById('injury-tab-' + (view === 'injury-date-view' ? 'date' : 'site')).classList.add('active');
  document.querySelectorAll('.injury-view').forEach(v => v.classList.remove('active'));
  document.getElementById(view).classList.add('active');
  S.injuryView = view === 'injury-date-view' ? 'date' : 'site';
}

// =====================================================================
//  分析タブ
// =====================================================================
async function loadAnalysisExList() {
  const list = document.getElementById('analysis-ex-list');
  list.innerHTML = '<div class="loading-msg">読み込み中…</div>';
  try {
    const data = await sbGetExercisesWithLastDate();
    S.analysisExList = data.exercises || [];
    renderAnalysisExList('');
  } catch (e) {
    list.innerHTML = '<div class="loading-msg">読み込みに失敗しました</div>';
  }
}

function renderAnalysisExList(filter) {
  const lc = filter.toLowerCase();
  const filtered = filter ? S.analysisExList.filter(e => e.name.toLowerCase().includes(lc)) : S.analysisExList;
  document.getElementById('analysis-ex-list').innerHTML = filtered.map(e =>
    `<div class="wa-ex-list-item" data-name="${esc(e.name)}">
      <span class="wa-ex-list-name">${esc(e.name)}</span>
      <span class="wa-ex-list-meta">前回 ${esc(dateLabel(e.lastDate))}（${e.daysAgo}日前）</span>
      <span class="wa-ex-list-chev">▶</span>
    </div>`
  ).join('');
  document.querySelectorAll('#analysis-ex-list .wa-ex-list-item').forEach(el => {
    el.addEventListener('click', () => loadAnalysis(el.dataset.name));
  });
}

async function loadAnalysis(name) {
  S.analysisExercise = name;
  document.getElementById('analysis-select-view').style.display = 'none';
  document.getElementById('analysis-content').style.display = '';
  document.getElementById('analysis-ex-name').textContent = name;
  document.getElementById('analysis-stats').innerHTML = '<div class="loading-msg">読み込み中…</div>';

  try {
    const data = await sbGetAnalysisData(name);
    const rows = data.data || [];
    renderAnalysis(rows);
  } catch (e) {
    document.getElementById('analysis-stats').innerHTML = '<div class="loading-msg">読み込みに失敗しました</div>';
  }
}

function renderAnalysis(rows) {
  if (rows.length === 0) {
    document.getElementById('analysis-stats').innerHTML = '<div class="loading-msg">データなし</div>';
    return;
  }
  const maxW = Math.max(...rows.map(r => r.maxWeight));
  const maxR = Math.max(...rows.map(r => r.maxReps));
  const totalSets = rows.reduce((n, r) => n + r.totalSets, 0);

  document.getElementById('analysis-stats').innerHTML = `
    <div class="analysis-stat-card"><div class="analysis-stat-num">${maxW}<em>kg</em></div><div class="analysis-stat-label">最高重量</div></div>
    <div class="analysis-stat-card"><div class="analysis-stat-num">${maxR}<em>${maxR > 0 ? '回' : ''}</em></div><div class="analysis-stat-label">最高レップ</div></div>
    <div class="analysis-stat-card"><div class="analysis-stat-num">${totalSets}<em>set</em></div><div class="analysis-stat-label">累計セット数</div></div>
    <div class="analysis-stat-card"><div class="analysis-stat-num">${rows.length}<em>回</em></div><div class="analysis-stat-label">実施回数</div></div>`;

  const labels = rows.map(r => {
    const d = new Date(r.date + 'T00:00:00');
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  });

  const chartOpts = {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#b0b8c8', maxTicksLimit: 8, font: { size: 10 } }, grid: { color: '#2e3244' } },
      y: { ticks: { color: '#b0b8c8', font: { size: 10 } }, grid: { color: '#2e3244' } },
    },
  };

  if (S.analysisChartW) S.analysisChartW.destroy();
  if (S.analysisChartV) S.analysisChartV.destroy();
  if (S.analysisChartR) S.analysisChartR.destroy();
  if (S.analysisChartTR) S.analysisChartTR.destroy();

  S.analysisChartW = new Chart(document.getElementById('chart-weight'), {
    type: 'line',
    data: { labels, datasets: [{ data: rows.map(r => r.maxWeight), borderColor: '#d4f53c', backgroundColor: 'rgba(212,245,60,0.1)', tension: 0.3, pointRadius: 3, pointBackgroundColor: '#d4f53c' }] },
    options: chartOpts,
  });

  S.analysisChartV = new Chart(document.getElementById('chart-volume'), {
    type: 'line',
    data: { labels, datasets: [{ data: rows.map(r => r.totalVolume), borderColor: '#7a8394', backgroundColor: 'rgba(122,131,148,0.1)', tension: 0.3, pointRadius: 3, pointBackgroundColor: '#7a8394' }] },
    options: chartOpts,
  });

  S.analysisChartR = new Chart(document.getElementById('chart-reps'), {
    type: 'line',
    data: { labels, datasets: [{ data: rows.map(r => r.maxReps), borderColor: '#5bc8f5', backgroundColor: 'rgba(91,200,245,0.1)', tension: 0.3, pointRadius: 3, pointBackgroundColor: '#5bc8f5' }] },
    options: chartOpts,
  });

  S.analysisChartTR = new Chart(document.getElementById('chart-total-reps'), {
    type: 'line',
    data: { labels, datasets: [{ data: rows.map(r => r.totalReps), borderColor: '#f59a5b', backgroundColor: 'rgba(245,154,91,0.1)', tension: 0.3, pointRadius: 3, pointBackgroundColor: '#f59a5b' }] },
    options: chartOpts,
  });
}

// =====================================================================
//  設定タブ
// =====================================================================
function updateSettingsTopCounts() {
  document.getElementById('s-top-ex-count').textContent = S.exercises.length + '種目';
  document.getElementById('s-top-menu-count').textContent = S.menus.length + 'メニュー';
  document.getElementById('s-top-injury-count').textContent = S.injurySites.length + '部位';
}

// --- 種目管理 ---
function renderSettingsEx(filter = '') {
  const lc = filter.toLowerCase();
  const list = filter ? S.exercises.filter(e => e.name.toLowerCase().includes(lc)) : S.exercises;
  document.getElementById('s-ex-list').innerHTML = list.map(e =>
    `<div class="wa-setting-row" data-name="${esc(e.name)}">
      <div class="wa-setting-icon">🏋️</div>
      <div class="wa-setting-name">${esc(e.name)}</div>
      <div class="wa-setting-meta">${esc(e.bodyPart)}・${esc(e.unit)}・${e.defaultInterval}秒${e.hasSides ? '・左右あり' : ''}</div>
      <div class="wa-setting-chevron">▶</div>
    </div>`
  ).join('');
  document.querySelectorAll('#s-ex-list .wa-setting-row').forEach(el => {
    el.addEventListener('click', () => openExModal(el.dataset.name));
  });
}

function openExModal(name) {
  const ex = S.exercises.find(e => e.name === name);
  S.editingExName = name || null;
  document.getElementById('modal-ex-title').textContent = name ? '種目を編集' : '種目を追加';
  document.getElementById('modal-ex-name').value = ex?.name || '';
  document.getElementById('modal-ex-bodypart').value = ex?.bodyPart || '';
  document.getElementById('modal-ex-interval').value = ex?.defaultInterval ?? 90;
  setToggle('modal-ex-unit-row', ex?.unit || '回');
  setToggle('modal-ex-sides-row', ex?.hasSides ? 'あり' : 'なし');
  document.getElementById('modal-ex-delete').style.display = name ? '' : 'none';
  openModal('modal-ex');
}

async function saveExModal() {
  const name = document.getElementById('modal-ex-name').value.trim();
  if (!name) { showToast('種目名を入力してください'); return; }
  const unit = getToggleVal('modal-ex-unit-row') || '回';
  const hasSides = getToggleVal('modal-ex-sides-row') === 'あり';
  const bodyPart = document.getElementById('modal-ex-bodypart').value.trim();
  const rawInterval = parseInt(document.getElementById('modal-ex-interval').value);
  const defaultInterval = isNaN(rawInterval) ? 90 : rawInterval;

  if (S.editingExName) {
    const { error } = await sb.from('exercises')
      .update({ name, unit, has_sides: hasSides, body_part: bodyPart, default_interval: defaultInterval })
      .eq('user_id', _userId).eq('name', S.editingExName);
    if (error) { showToast('保存に失敗しました'); return; }
    if (S.editingExName !== name) {
      await sb.from('records').update({ exercise: name }).eq('user_id', _userId).eq('exercise', S.editingExName);
      await sb.from('menu_exercises').update({ exercise_name: name }).eq('user_id', _userId).eq('exercise_name', S.editingExName);
    }
    const idx = S.exercises.findIndex(e => e.name === S.editingExName);
    if (idx !== -1) S.exercises[idx] = { ...S.exercises[idx], name, unit, hasSides, bodyPart, defaultInterval };
  } else {
    const { error } = await sb.from('exercises').insert({
      user_id: _userId, name, unit, has_sides: hasSides,
      body_part: bodyPart, default_interval: defaultInterval,
      main_equipment: '', sub_equipment: '',
    });
    if (error) { showToast('保存に失敗しました'); return; }
    S.exercises.push({ name, unit, hasSides, bodyPart, defaultInterval, mainEquipment: '', subEquipment: '' });
  }
  closeModal('modal-ex');
  renderSettingsEx();
  updateSettingsTopCounts();
  showToast('保存しました');
}

function deleteExModal() {
  showConfirm('種目を削除', `「${S.editingExName}」を削除しますか？`, async () => {
    const { error } = await sb.from('exercises').delete().eq('user_id', _userId).eq('name', S.editingExName);
    if (error) { showToast('削除に失敗しました'); return; }
    S.exercises = S.exercises.filter(e => e.name !== S.editingExName);
    closeModal('modal-ex');
    renderSettingsEx();
    updateSettingsTopCounts();
    showToast('削除しました');
  });
}

// --- メニュー管理 ---
function renderSettingsMenu() {
  document.getElementById('s-menu-list').innerHTML = S.menus.map(m =>
    `<div class="wa-setting-row" data-name="${esc(m.name)}">
      <div class="wa-setting-icon">📋</div>
      <div class="wa-setting-name">${esc(menuDisplay(m.name))}</div>
      <div class="wa-setting-meta">${m.exercises.length}種目</div>
      <div class="wa-setting-chevron">▶</div>
    </div>`
  ).join('');
  document.querySelectorAll('#s-menu-list .wa-setting-row').forEach(el => {
    el.addEventListener('click', () => openMenuDetail(el.dataset.name));
  });
}

function openMenuDetail(name) {
  S.currentMenu = name;
  document.getElementById('s-menu-detail-title').textContent = menuDisplay(name);
  renderMenuDetailList();
  showSettingsScreen('s-menu-detail');
}

function renderMenuDetailList() {
  const menu = S.menus.find(m => m.name === S.currentMenu);
  if (!menu) return;
  document.getElementById('s-menu-detail-list').innerHTML = menu.exercises.map(ex =>
    `<div class="wa-setting-row" data-name="${esc(ex)}">
      <div class="wa-setting-drag">☰</div>
      <div class="wa-setting-name">${esc(ex)}</div>
      <div class="wa-setting-chevron" style="cursor:pointer;color:#ff4d3a;font-size:13px" data-remove="${esc(ex)}">✕</div>
    </div>`
  ).join('');
  document.querySelectorAll('#s-menu-detail-list .wa-setting-chevron[data-remove]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      removeMenuEx(el.dataset.remove);
    });
  });
  if (S.sortable) S.sortable.destroy();
  S.sortable = Sortable.create(document.getElementById('s-menu-detail-list'), {
    handle: '.wa-setting-drag',
    animation: 150,
    onEnd: saveMenuOrder,
  });
}

async function saveMenuOrder() {
  const menu = S.menus.find(m => m.name === S.currentMenu);
  if (!menu) return;
  const rows = document.querySelectorAll('#s-menu-detail-list .wa-setting-row');
  const exercises = Array.from(rows).map(r => r.dataset.name);
  menu.exercises = exercises;
  const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
  await sb.from('menu_exercises').delete().eq('user_id', _userId).eq('menu_id', menuData.id);
  await sb.from('menu_exercises').insert(exercises.map((ex, idx) => ({
    user_id: _userId, menu_id: menuData.id, exercise_name: ex, order_num: idx + 1,
  })));
}

async function removeMenuEx(exName) {
  const menu = S.menus.find(m => m.name === S.currentMenu);
  if (!menu) return;
  menu.exercises = menu.exercises.filter(e => e !== exName);
  const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
  await sb.from('menu_exercises').delete().eq('user_id', _userId).eq('menu_id', menuData.id).eq('exercise_name', exName);
  renderMenuDetailList();
}

function openMenuExAdd() {
  const menu = S.menus.find(m => m.name === S.currentMenu);
  const already = new Set(menu?.exercises || []);
  document.getElementById('modal-menu-ex-list').innerHTML = S.exercises
    .filter(e => !already.has(e.name))
    .map(e => `<div class="modal-ex-row" data-name="${esc(e.name)}">${esc(e.name)}<span>${esc(e.bodyPart)}</span></div>`)
    .join('');
  document.querySelectorAll('#modal-menu-ex-list .modal-ex-row').forEach(el => {
    el.addEventListener('click', async () => {
      const exName = el.dataset.name;
      menu.exercises.push(exName);
      const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
      const { data: existing } = await sb.from('menu_exercises').select('order_num').eq('user_id', _userId).eq('menu_id', menuData.id);
      const maxOrder = existing && existing.length > 0 ? Math.max(...existing.map(e => e.order_num)) : 0;
      await sb.from('menu_exercises').insert({ user_id: _userId, menu_id: menuData.id, exercise_name: exName, order_num: maxOrder + 1 });
      closeModal('modal-menu-ex-add');
      renderMenuDetailList();
    });
  });
  document.getElementById('modal-menu-ex-search').value = '';
  document.getElementById('modal-menu-ex-search').oninput = function () {
    const lc = this.value.toLowerCase();
    document.querySelectorAll('#modal-menu-ex-list .modal-ex-row').forEach(el => {
      el.style.display = el.dataset.name.toLowerCase().includes(lc) ? '' : 'none';
    });
  };
  openModal('modal-menu-ex-add');
}

async function addMenuModal() {
  const name = document.getElementById('modal-menu-name').value.trim();
  if (!name) { showToast('メニュー名を入力してください'); return; }
  const { error } = await sb.from('menus').insert({ user_id: _userId, name });
  if (error) { showToast('保存に失敗しました'); return; }
  S.menus.push({ name, exercises: [] });
  closeModal('modal-menu-add');
  renderSettingsMenu();
  updateSettingsTopCounts();
  showToast('追加しました');
}

function deleteMenuConfirm() {
  showConfirm('メニューを削除', `「${menuDisplay(S.currentMenu)}」を削除しますか？`, async () => {
    const { error } = await sb.from('menus').delete().eq('user_id', _userId).eq('name', S.currentMenu);
    if (error) { showToast('削除に失敗しました'); return; }
    S.menus = S.menus.filter(m => m.name !== S.currentMenu);
    showSettingsScreen('s-menu');
    renderSettingsMenu();
    updateSettingsTopCounts();
    showToast('削除しました');
  });
}

// --- 怪我部位管理 ---
function renderSettingsInjury() {
  document.getElementById('s-injury-list').innerHTML = S.injurySites.map(s =>
    `<div class="wa-setting-row" data-name="${esc(s)}">
      <div class="wa-setting-name">${esc(s)}</div>
      <div class="wa-setting-chevron">▶</div>
    </div>`
  ).join('');
  document.querySelectorAll('#s-injury-list .wa-setting-row').forEach(el => {
    el.addEventListener('click', () => openInjuryModal(el.dataset.name));
  });
}

function openInjuryModal(name) {
  S.editingInjuryOld = name || null;
  document.getElementById('modal-injury-title').textContent = name ? '怪我部位を編集' : '部位を追加';
  document.getElementById('modal-injury-name').value = name || '';
  document.getElementById('modal-injury-delete').style.display = name ? '' : 'none';
  openModal('modal-injury');
}

async function saveInjuryModal() {
  const name = document.getElementById('modal-injury-name').value.trim();
  if (!name) { showToast('部位名を入力してください'); return; }
  if (S.editingInjuryOld) {
    const { error } = await sb.from('injury_sites').update({ name }).eq('user_id', _userId).eq('name', S.editingInjuryOld);
    if (error) { showToast('保存に失敗しました'); return; }
    const idx = S.injurySites.indexOf(S.editingInjuryOld);
    if (idx !== -1) S.injurySites[idx] = name;
  } else {
    const { error } = await sb.from('injury_sites').insert({ user_id: _userId, name });
    if (error) { showToast('保存に失敗しました'); return; }
    S.injurySites.push(name);
  }
  closeModal('modal-injury');
  renderSettingsInjury();
  updateSettingsTopCounts();
  showToast('保存しました');
}

function deleteInjuryModal() {
  showConfirm('部位を削除', `「${S.editingInjuryOld}」を削除しますか？`, async () => {
    const { error } = await sb.from('injury_sites').delete().eq('user_id', _userId).eq('name', S.editingInjuryOld);
    if (error) { showToast('削除に失敗しました'); return; }
    S.injurySites = S.injurySites.filter(s => s !== S.editingInjuryOld);
    closeModal('modal-injury');
    renderSettingsInjury();
    updateSettingsTopCounts();
    showToast('削除しました');
  });
}

// =====================================================================
//  MODAL HELPERS
// =====================================================================
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function setToggle(rowId, val) {
  document.querySelectorAll('#' + rowId + ' .wa-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === val);
  });
}

function getToggleVal(rowId) {
  return document.querySelector('#' + rowId + ' .wa-toggle-btn.active')?.dataset.val || '';
}

// =====================================================================
//  EVENT LISTENERS
// =====================================================================
function setupEventListeners() {

  // --- 記録タブ ---
  document.getElementById('btn-set-menu').addEventListener('click', () => { renderS1Menu(); showRecordScreen('s1-menu'); });
  document.getElementById('btn-s1m-back').addEventListener('click', () => showRecordScreen('s1'));
  document.getElementById('btn-s1s-back').addEventListener('click', () => showRecordScreen('s1'));
  document.getElementById('s1s-search').addEventListener('input', function () { renderS1Single(this.value); });

  document.getElementById('btn-s2-back').addEventListener('click', () => {
    const hasCompleted = S.session?.exercises.some(e => e.done);
    if (hasCompleted) {
      showConfirm('セッションを破棄', 'セッションを破棄してトップに戻りますか？', () => {
        stopTimer();
        S.session = null;
        S.currentExIdx = null;
        S.s3ExData = null;
        S.s3ExCache = {};
        renderS1();
        showRecordScreen('s1');
      });
    } else {
      stopTimer();
      S.session = null;
      S.currentExIdx = null;
      S.s3ExData = null;
      S.s3ExCache = {};
      renderS1();
      showRecordScreen('s1');
    }
  });
  document.getElementById('btn-end-training').addEventListener('click', goFinish);

  document.getElementById('btn-s3-back').addEventListener('click', () => {
    renderS2();
    showRecordScreen('s2');
  });
  document.getElementById('btn-complete-ex').addEventListener('click', completeEx);
  document.getElementById('s3-hist-toggle').addEventListener('click', () => {
    if (window.innerWidth >= 640) return;
    const panel = document.getElementById('s3-hist-panel');
    const wasOpen = panel.classList.contains('open');
    panel.classList.toggle('open');
    if (!wasOpen && !S.s3HistLoaded) loadS3Hist();
  });
  document.getElementById('btn-s3-hist-more').addEventListener('click', () => loadS3Hist(true));
  document.getElementById('btn-s3-expand-all').addEventListener('click', () => toggleExpandAll('btn-s3-expand-all', 's3-hist-list', 'wa-ex-hist-item'));
  document.getElementById('s3-tab-hist').addEventListener('click', () => switchS3RightTab('hist'));
  document.getElementById('s3-tab-injury').addEventListener('click', () => { switchS3RightTab('injury'); loadS3Injury(); });
  document.getElementById('s3-injury-toggle').addEventListener('click', () => {
    if (window.innerWidth >= 640) return;
    document.getElementById('s3-injury-panel').classList.toggle('open');
    loadS3Injury();
  });
  document.getElementById('s3-injury-tab-date').addEventListener('click', () => switchS3InjuryTab('date'));
  document.getElementById('s3-injury-tab-site').addEventListener('click', () => switchS3InjuryTab('site'));
  document.getElementById('btn-s3-injury-expand-all').addEventListener('click', () => {
    const isDate = document.getElementById('s3-injury-tab-date').classList.contains('active');
    if (isDate) toggleExpandAll('btn-s3-injury-expand-all', 's3-injury-date-list', 'wa-session-item');
    else toggleExpandAll('btn-s3-injury-expand-all', 's3-injury-site-list', 'injury-site-card');
  });

  document.getElementById('btn-finish-back').addEventListener('click', () => showRecordScreen('s2'));
  document.getElementById('btn-save-session').addEventListener('click', saveSession);
  document.getElementById('btn-copy-obsidian').addEventListener('click', () => {
    const ta = document.getElementById('finish-obsidian');
    const btn = document.getElementById('btn-copy-obsidian');
    navigator.clipboard.writeText(ta.value).then(() => {
      document.querySelector('.wa-obsidian-wrap').classList.remove('pulsing');
      btn.textContent = 'コピー済み✓';
      setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
    }).catch(() => { ta.select(); document.execCommand('copy'); });
  });

  document.querySelectorAll('.wa-choice-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      this.closest('.wa-choice-row').querySelectorAll('.wa-choice-btn').forEach(b => b.classList.remove('selected'));
      this.classList.add('selected');
    });
  });

  // --- 履歴タブ ---
  document.getElementById('hist-tab-date').addEventListener('click', () => switchHistTab('hist-date-view'));
  document.getElementById('hist-tab-ex').addEventListener('click', () => switchHistTab('hist-ex-view'));
  document.getElementById('btn-hist-date-more').addEventListener('click', loadHistoryDate);
  document.getElementById('btn-hist-date-expand-all').addEventListener('click', () => toggleExpandAll('btn-hist-date-expand-all', 'hist-date-list', 'wa-session-item'));
  document.getElementById('btn-hist-ex-back').addEventListener('click', backFromHistExDetail);
  document.getElementById('btn-hist-ex-more').addEventListener('click', loadHistExDetail);
  document.getElementById('btn-hist-ex-expand-all').addEventListener('click', () => toggleExpandAll('btn-hist-ex-expand-all', 'hist-ex-detail-list', 'wa-ex-hist-item'));
  document.getElementById('hist-ex-search').addEventListener('input', function () {
    if (S.histExWithLastDate) renderHistExList(S.histExWithLastDate.exercises, this.value);
  });

  // --- 怪我タブ ---
  document.getElementById('injury-tab-date').addEventListener('click', () => switchInjuryTab('injury-date-view'));
  document.getElementById('injury-tab-site').addEventListener('click', () => switchInjuryTab('injury-site-view'));
  document.getElementById('btn-injury-date-expand-all').addEventListener('click', () => toggleExpandAll('btn-injury-date-expand-all', 'injury-date-list', 'wa-session-item'));
  document.getElementById('btn-injury-site-expand-all').addEventListener('click', () => toggleExpandAll('btn-injury-site-expand-all', 'injury-site-list', 'injury-site-card'));

  // --- 分析タブ ---
  document.getElementById('analysis-search').addEventListener('input', function () {
    if (S.analysisExList) renderAnalysisExList(this.value);
  });
  document.getElementById('btn-analysis-back').addEventListener('click', () => {
    document.getElementById('analysis-select-view').style.display = '';
    document.getElementById('analysis-content').style.display = 'none';
    S.analysisExercise = null;
  });

  // --- 設定タブ ---
  document.getElementById('btn-go-s-ex').addEventListener('click', () => { document.getElementById('s-ex-search').value = ''; renderSettingsEx(); showSettingsScreen('s-ex'); });
  document.getElementById('s-ex-search').addEventListener('input', function () { renderSettingsEx(this.value); });
  document.getElementById('btn-go-s-menu').addEventListener('click', () => { renderSettingsMenu(); showSettingsScreen('s-menu'); });
  document.getElementById('btn-go-s-injury').addEventListener('click', () => { renderSettingsInjury(); showSettingsScreen('s-injury'); });

  document.getElementById('btn-s-ex-back').addEventListener('click', () => showSettingsScreen('s-top'));
  document.getElementById('btn-s-menu-back').addEventListener('click', () => showSettingsScreen('s-top'));
  document.getElementById('btn-s-menu-detail-back').addEventListener('click', () => showSettingsScreen('s-menu'));
  document.getElementById('btn-s-injury-back').addEventListener('click', () => showSettingsScreen('s-top'));

  document.getElementById('btn-ex-add').addEventListener('click', () => openExModal(null));
  document.getElementById('btn-menu-add').addEventListener('click', () => {
    document.getElementById('modal-menu-name').value = '';
    openModal('modal-menu-add');
  });
  document.getElementById('btn-menu-ex-add').addEventListener('click', openMenuExAdd);
  document.getElementById('btn-delete-menu').addEventListener('click', deleteMenuConfirm);
  document.getElementById('btn-injury-add').addEventListener('click', () => openInjuryModal(null));

  // --- モーダル ---
  document.getElementById('modal-ex-cancel').addEventListener('click', () => closeModal('modal-ex'));
  document.getElementById('modal-ex-save').addEventListener('click', saveExModal);
  document.getElementById('modal-ex-delete').addEventListener('click', deleteExModal);

  document.getElementById('modal-menu-add-cancel').addEventListener('click', () => closeModal('modal-menu-add'));
  document.getElementById('modal-menu-add-save').addEventListener('click', addMenuModal);

  document.getElementById('modal-menu-ex-cancel').addEventListener('click', () => closeModal('modal-menu-ex-add'));

  document.getElementById('modal-session-ex-cancel').addEventListener('click', () => closeModal('modal-session-ex-add'));

  document.getElementById('modal-injury-cancel').addEventListener('click', () => closeModal('modal-injury'));
  document.getElementById('modal-injury-save').addEventListener('click', saveInjuryModal);
  document.getElementById('modal-injury-delete').addEventListener('click', deleteInjuryModal);

  document.getElementById('modal-confirm-cancel').addEventListener('click', () => closeModal('modal-confirm'));
  document.getElementById('modal-confirm-ok').addEventListener('click', () => {
    closeModal('modal-confirm');
    if (S.confirmCb) { S.confirmCb(); S.confirmCb = null; }
  });

  document.getElementById('modal-sess-cancel').addEventListener('click', () => closeModal('modal-session-edit'));
  document.getElementById('modal-sess-save').addEventListener('click', saveSessionModal);
  document.getElementById('modal-sess-delete').addEventListener('click', deleteSessionConfirm);

  document.getElementById('modal-rec-cancel').addEventListener('click', () => closeModal('modal-record-edit'));
  document.getElementById('modal-rec-save').addEventListener('click', saveRecordModal);
  document.getElementById('modal-rec-delete').addEventListener('click', deleteExerciseRecordsConfirm);

  // toggle-btn ロジック（モーダル内）
  document.querySelectorAll('.wa-toggle-row').forEach(row => {
    row.querySelectorAll('.wa-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        row.querySelectorAll('.wa-toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  });

  // モーダルの背景クリックで閉じる
  document.querySelectorAll('.wa-modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });
}

// =====================================================================
//  START
// =====================================================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-submit-btn').addEventListener('click', _handleAuthSubmit);
  document.getElementById('login-switch-btn').addEventListener('click', _toggleAuthMode);
  document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') _handleAuthSubmit();
  });
  document.getElementById('btn-logout').addEventListener('click', () => {
    showConfirm('ログアウト', 'ログアウトしますか？', handleLogout, { okLabel: 'ログアウト' });
  });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') {
      if (session) { _userId = session.user.id; hideLoginScreen(); init(); }
    } else if (event === 'SIGNED_IN') {
      _userId = session.user.id; hideLoginScreen(); init();
    } else if (event === 'SIGNED_OUT') {
      _userId = null; _appSetupDone = false; showLoginScreen();
    }
  });
});
