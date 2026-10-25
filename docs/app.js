import { predict, toDay, fromDay } from './predict.js';
import { encryptBackup, decryptBackup } from './backup.js';
import * as db from './db.js';

const BACKUP_REMIND_DAYS = 30;
const MIN_PASS = 8;
const OVULATION_DAY = 12;   // 生理開始日を 1 日目として何日目を排卵日の目安にするか
const MEMO_HEAD_LEN = 24;   // カレンダー下の見出しに出すメモの文字数（超えたら「続き」で体調管理へ）
const FLOW_LABEL = { light: '少なめ', normal: 'ふつう', heavy: '多め' };
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const GAP_LABEL = '記録漏れ？';
const PAGES = ['period', 'health', 'settings', 'records'];

const $ = id => document.getElementById(id);

let periods = [];
let notes = new Map();  // 日付 → メモの文
let viewMonth;          // 生理管理のカレンダーで表示中の月の 1 日（'YYYY-MM-01'）
let notesMonth;         // 体調管理で表示中の月の 1 日
let editingId = null;
let view = 'cal';       // 'cal' カレンダー / 'table' 表
let shownPage = null;

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function md(s) {
  const [, m, d] = s.split('-').map(Number);
  return `${m}/${d}`;
}

// サマリーの大きな日付用（'09/15'）
function mmdd(s) {
  return `${s.slice(5, 7)}/${s.slice(8, 10)}`;
}

function ymd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

function weekday(date) {
  return WEEK[new Date(toDay(date) * 86400000).getUTCDay()];
}

function addMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 10);
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y}年${m}月`;
}

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

// ---- ページの切り替え（アドレスの # で切り替えるので、Android の「戻る」で前のページに戻れる） ----

function currentPage() {
  const h = location.hash.slice(1);
  // 最初の画面は生理管理（以前の #home も生理管理を開く）
  return PAGES.includes(h) ? h : 'period';
}

function showPage(name) {
  for (const p of PAGES) $(`page-${p}`).hidden = p !== name;
  // 「これまでの記録」は設定の中のページなので、メニューは設定を選んだ状態にする
  const menu = name === 'records' ? 'settings' : name;
  for (const a of document.querySelectorAll('.footer-nav a')) {
    a.classList.toggle('active', a.dataset.page === menu);
  }
  if (shownPage !== name) window.scrollTo(0, 0);
  shownPage = name;
}

function go(name) {
  if (currentPage() !== name) location.hash = name;
  showPage(name);
}

window.addEventListener('hashchange', () => showPage(currentPage()));

// 横にスワイプすると隣のメニューへ（左へスワイプで右隣、右へで左隣。EARN VIEWER と同じ作り）
// ページは指についてきて、離すと次のページが横から滑り込む（0.15 秒）。動かしている間は、移る先の側に矢印と行き先の名前を出す
// 画面幅の 20% 未満でゆっくり離したときは元に戻る。両端のメニューでは重く動いて戻る
// 入力欄・ダイアログ・下のメニュー・横にスクロールできる表の上と、「これまでの記録」のページでは動かさない
(() => {
  const SLIDE_MS = 150;
  const MENU = ['period', 'health', 'settings'];
  const hint = el('div', { className: 'swipe-hint' }, [el('span', { className: 'sh-arrow' }), el('span', { className: 'sh-name' })]);
  document.body.append(hint);
  const showHint = (dir, name, p) => { // dir：-1＝次（右端）、1＝前（左端）、p：0〜1
    hint.classList.toggle('left', dir > 0); hint.classList.toggle('right', dir < 0);
    hint.querySelector('.sh-arrow').textContent = dir < 0 ? '›' : '‹';
    hint.querySelector('.sh-name').textContent = name;
    hint.style.opacity = String(Math.min(1, p * 1.6));
    hint.style.setProperty('--p', String(Math.min(1, p)));
    hint.classList.toggle('ready', p >= 1);
  };
  const hideHint = goNext => {
    hint.classList.remove('ready');
    if (goNext) { hint.classList.add('go'); setTimeout(() => { hint.classList.remove('go'); hint.style.opacity = '0'; }, 260); }
    else hint.style.opacity = '0';
  };
  let sx = 0, sy = 0, st = 0, armed = false, mode = '', dx = 0, page = null, busy = false;
  const scrollsX = e => {
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  const curIndex = () => MENU.indexOf(currentPage());
  const menuName = i => document.querySelector(`.footer-nav a[data-page=${MENU[i]}] span`).textContent;
  const move = (e, x, ms) => { e.style.transition = ms ? `transform ${ms}ms ease-out` : 'none'; e.style.transform = x ? `translateX(${x}px)` : ''; };
  const after = ms => new Promise(r => setTimeout(r, ms + 20));
  document.addEventListener('touchstart', ev => {
    armed = false; mode = ''; dx = 0;
    if (busy || ev.touches.length !== 1 || curIndex() < 0) return;
    const t = ev.target;
    if (t.closest('input, select, textarea, dialog, .footer-nav') || scrollsX(t)) return;
    sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; st = Date.now(); armed = true;
    page = $(`page-${currentPage()}`);
  }, { passive: true });
  document.addEventListener('touchmove', ev => {
    if (!armed || !page) return;
    const mx = ev.touches[0].clientX - sx, my = ev.touches[0].clientY - sy;
    if (!mode) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      mode = Math.abs(mx) > Math.abs(my) * 1.5 ? 'x' : 'y'; // 最初の動きで、横（ページ移動）か縦（スクロール）かを決める
    }
    if (mode !== 'x') return;
    ev.preventDefault(); // 横に動かしている間は、縦にスクロールさせない
    const j = curIndex() + (mx < 0 ? 1 : -1);
    const has = j >= 0 && j < MENU.length;
    dx = has ? mx : mx / 4; // 端のメニューでは重く
    move(page, dx, 0);
    if (has) showHint(mx < 0 ? -1 : 1, menuName(j), Math.abs(dx) / (window.innerWidth * 0.2)); else hideHint(false);
  }, { passive: false });
  document.addEventListener('touchend', async () => {
    if (!armed || mode !== 'x' || !page) { armed = false; return; }
    armed = false;
    const cur = page, w = window.innerWidth;
    const j = curIndex() + (dx < 0 ? 1 : -1);
    const fast = Math.abs(dx) > 25 && Date.now() - st < 300; // すばやく払ったときは短くても移る
    if (j < 0 || j >= MENU.length || (Math.abs(dx) < w * 0.2 && !fast)) { hideHint(false); move(cur, 0, SLIDE_MS); await after(SLIDE_MS); move(cur, 0, 0); return; }
    hideHint(true);
    busy = true;
    const dir = dx < 0 ? -1 : 1;
    move(cur, dir * w, SLIDE_MS); // 今のページを外へ
    await after(SLIDE_MS);
    move(cur, 0, 0);
    go(MENU[j]);
    const next = $(`page-${MENU[j]}`);
    move(next, -dir * w, 0); next.getBoundingClientRect(); move(next, 0, SLIDE_MS); await after(SLIDE_MS); move(next, 0, 0); // 次のページを反対側から
    busy = false;
  });
  document.addEventListener('touchcancel', () => { if (armed && page) move(page, 0, SLIDE_MS); hideHint(false); armed = false; });
})();

// ---- 読み込みと描画 ----

async function load() {
  periods = (await db.listPeriods()).sort((a, b) => a.start.localeCompare(b.start));
  notes = new Map((await db.listNotes()).map(n => [n.date, n.text]));
  render();
}

function render() {
  const result = predict(periods, today());
  renderSummary(result);
  renderCalendar(result);
  renderQuickActions();
  renderTable(result);
  renderHistory(result);
  renderNotes();
  renderBackupInfo();
}

function openPeriod() {
  const last = periods[periods.length - 1];
  return last && !last.end ? last : null;
}

// 生理管理の先頭のサマリー
function renderSummary(r) {
  const box = $('summary');
  box.replaceChildren();
  if (!r) {
    box.append(
      el('p', { className: 'big', textContent: '最初の記録を入れると、予測が始まります。' }),
      el('div', { className: 'row' }, [el('button', { type: 'button', className: 'primary', textContent: '記録する', onclick: () => $('periodForm').scrollIntoView({ behavior: 'smooth', block: 'center' }) })]),
    );
    return;
  }

  const n = r.next[0];
  const open = openPeriod();
  let badge;
  if (open) badge = `生理中 ${toDay(today()) - toDay(open.start) + 1}日目`;
  else if (r.overdue > 0) badge = `予定を${r.overdue}日過ぎています`;
  else if (r.daysUntil > 0) badge = `あと${r.daysUntil}日`;
  else badge = '今日ごろ';

  // 排卵予定日は、次の生理の前にある排卵日（今の周期の開始日から数えた日）
  const ovulation = fromDay(toDay(r.lastStart) + OVULATION_DAY - 1);

  box.append(
    el('div', { className: 'summary-top' }, [
      el('div', { className: 'summary-main' }, [
        el('div', { className: 'summary-label', textContent: '生理予定日' }),
        el('div', { className: 'summary-date' }, [
          mmdd(n.center),
          el('span', { className: 'summary-wd', textContent: `（${weekday(n.center)}）` }),
        ]),
        el('div', { className: 'summary-badge', textContent: badge }),
        el('div', { className: 'summary-range', textContent: `早くて${mmdd(n.earliest)}、遅くて${mmdd(n.latest)}` }),
      ]),
      el('div', { className: 'summary-side' }, [
        el('div', { className: 'summary-label', textContent: '排卵予定日' }),
        el('div', { className: 'summary-date small-date', textContent: mmdd(ovulation) }),
        el('div', { className: 'summary-wd', textContent: `（${weekday(ovulation)}）` }),
      ]),
    ]),
    el('div', { className: 'summary-stats' }, [
      el('div', {}, ['平均周期 ', el('strong', { textContent: String(Math.round(r.cycle)) }), ' 日']),
      el('div', {}, ['平均日数 ', el('strong', { textContent: String(r.length) }), ' 日']),
    ]),
  );
}

// ---- 生理管理：カレンダー ----

function dayMarks(r) {
  // 日数 → クラス名の集合
  const marks = new Map();
  const add = (day, cls) => {
    if (!marks.has(day)) marks.set(day, new Set());
    marks.get(day).add(cls);
  };
  const t = toDay(today());
  periods.forEach((p, i) => {
    const s = toDay(p.start);
    const e = p.end ? toDay(p.end) : Math.max(s, t);
    for (let d = s; d <= e; d++) add(d, 'period');
    // 次の生理が先に来ている周期には付けない
    const ovu = s + OVULATION_DAY - 1;
    const nextStart = periods[i + 1] ? toDay(periods[i + 1].start) : Infinity;
    if (ovu < nextStart) add(ovu, 'ovulation');
  });
  if (r) {
    for (const n of r.next) {
      for (let d = toDay(n.earliest); d <= toDay(n.latest); d++) add(d, 'range');
      for (let d = toDay(n.center); d < toDay(n.center) + n.length; d++) add(d, 'predicted');
      add(toDay(n.center) + OVULATION_DAY - 1, 'ovulation');
    }
  }
  for (const date of notes.keys()) add(toDay(date), 'note');
  add(t, 'today');
  return marks;
}

function renderCalendar(r) {
  const [y, m] = viewMonth.split('-').map(Number);
  $('monthLabel').textContent = monthLabel(viewMonth);
  const first = toDay(viewMonth);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const marks = dayMarks(r);

  const cal = $('calendar');
  cal.replaceChildren(...WEEK.map(w => el('div', { className: 'wd', textContent: w })));
  for (let i = 0; i < firstWeekday; i++) cal.append(el('div', { className: 'blank' }));
  for (let i = 0; i < daysInMonth; i++) {
    const day = first + i;
    const cls = marks.get(day);
    const cell = el('button', { type: 'button', className: 'day' }, [el('span', { className: 'num', textContent: String(i + 1) })]);
    if (cls) {
      // 記録がある日は予定の色を出さない
      if (cls.has('period')) cls.delete('predicted');
      cell.classList.add(...cls);
    }
    cell.addEventListener('click', () => openDay(fromDay(day)));
    cal.append(cell);
  }
  renderMonthNotes();
}

const datesInMonth = month => [...notes.keys()].filter(d => d.startsWith(month.slice(0, 8))).sort();

// カレンダーの下に、表示中の月のメモを見出しのように並べる
function renderMonthNotes() {
  const box = $('monthNotes');
  box.replaceChildren();
  const dates = datesInMonth(viewMonth);
  if (!dates.length) return;
  const [, m] = viewMonth.split('-').map(Number);
  box.append(el('h3', { textContent: `${m}月のメモ` }));
  const list = el('ul');
  for (const date of dates) {
    const text = notes.get(date);
    const firstLine = text.split('\n')[0];
    const long = text.includes('\n') || text.length > MEMO_HEAD_LEN;
    const head = long ? `${firstLine.slice(0, MEMO_HEAD_LEN)}…` : text;
    const li = el('li', {}, [
      el('span', { className: 'mn-date', textContent: `${Number(date.slice(8))}日（${weekday(date)}）` }),
      el('span', { className: 'mn-text', textContent: head }),
    ]);
    if (long) {
      li.append(el('a', { href: '#health', className: 'mn-more', textContent: '続き', onclick: e => { e.preventDefault(); jumpToNote(date); } }));
    }
    list.append(li);
  }
  box.append(list);
}

// 体調管理のページに移って、そのメモの所まで動かす
function jumpToNote(date) {
  $('noteSearch').value = '';
  notesMonth = date.slice(0, 8) + '01';
  renderNotes();
  go('health');
  const item = document.getElementById(`note-${date}`);
  if (!item) return;
  item.scrollIntoView({ behavior: 'smooth', block: 'center' });
  item.classList.remove('flash');
  void item.offsetWidth;
  item.classList.add('flash');
}

// ---- 生理管理：表 ----

function renderTable(r) {
  const body = $('cycleTable');
  body.replaceChildren();
  const gaps = new Set(r?.gaps);
  const rows = [];
  periods.forEach((p, i) => {
    const s = toDay(p.start);
    const nextStart = periods[i + 1] ? toDay(periods[i + 1].start) : null;
    const ovu = s + OVULATION_DAY - 1;
    rows.push({
      start: p.start,
      startText: md(p.start),
      days: p.end ? `${toDay(p.end) - s + 1}日` : '継続中',
      cycle: nextStart != null ? `${nextStart - s}日` : `今${toDay(today()) - s + 1}日目`,
      ovulation: nextStart == null || ovu < nextStart ? md(fromDay(ovu)) : '—',
      flow: FLOW_LABEL[p.flow] ?? '',
      gap: gaps.has(p.start),
    });
  });
  if (r) {
    r.next.forEach((n, i) => {
      const following = r.next[i + 1];
      rows.push({
        start: n.center,
        startText: `${md(n.center)}ごろ`,
        sub: `${md(n.earliest)}〜${md(n.latest)}`,
        days: `${n.length}日`,
        cycle: following ? `${toDay(following.center) - toDay(n.center)}日` : '—',
        ovulation: md(fromDay(toDay(n.center) + OVULATION_DAY - 1)),
        flow: '—',
        predicted: true,
      });
    });
  }
  if (!rows.length) {
    body.append(el('tr', {}, [el('td', { colSpan: 5, className: 'small', textContent: 'まだ記録がありません。' })]));
    return;
  }
  // 新しい順。年が変わるところに見出しの行を入れる
  let year = null;
  for (const row of rows.reverse()) {
    const y = row.start.slice(0, 4);
    if (y !== year) {
      year = y;
      body.append(el('tr', { className: 'year' }, [el('th', { colSpan: 5, textContent: `${y}年` })]));
    }
    const startCell = el('td', {}, [el('div', { textContent: row.startText })]);
    if (row.predicted) startCell.prepend(el('span', { className: 'tag', textContent: '予定' }));
    if (row.sub) startCell.append(el('div', { className: 'small', textContent: row.sub }));
    const cycleCell = el('td', {}, [el('div', { textContent: row.cycle })]);
    if (row.gap) cycleCell.append(el('span', { className: 'tag tag-gap', textContent: GAP_LABEL }));
    body.append(el('tr', { className: row.predicted ? 'predicted-row' : '' }, [
      startCell,
      el('td', { textContent: row.days }),
      cycleCell,
      el('td', { textContent: row.ovulation }),
      el('td', { textContent: row.flow }),
    ]));
  }
}

function setView(v) {
  view = v;
  $('calView').hidden = v !== 'cal';
  $('tableView').hidden = v !== 'table';
  $('viewCal').classList.toggle('active', v === 'cal');
  $('viewTable').classList.toggle('active', v === 'table');
  $('viewCal').setAttribute('aria-selected', String(v === 'cal'));
  $('viewTable').setAttribute('aria-selected', String(v === 'table'));
}

function renderQuickActions() {
  const box = $('quickActions');
  box.replaceChildren();
  const open = openPeriod();
  const t = today();
  if (open) {
    box.append(el('button', { type: 'button', textContent: '今日終わった', onclick: () => save({ ...open, end: t }) }));
  } else if (!periods.some(p => p.start === t)) {
    box.append(el('button', { type: 'button', textContent: '今日始まった', onclick: () => save({ start: t, flow: 'normal' }) }));
  }
}

// ---- 設定 → これまでの記録 ----

function renderHistory(r) {
  const list = $('history');
  list.replaceChildren();
  if (!periods.length) {
    list.append(el('li', { className: 'small', textContent: 'まだ記録がありません。' }));
    return;
  }
  const gaps = new Set(r?.gaps);
  const rows = [...periods].reverse();
  rows.forEach((p, i) => {
    const prev = rows[i + 1];
    const days = p.end ? `${toDay(p.end) - toDay(p.start) + 1}日間` : '継続中';
    const cycle = prev ? `・周期${toDay(p.start) - toDay(prev.start)}日` : '';
    const detail = el('div', { className: 'small', textContent: `${days}・${FLOW_LABEL[p.flow] ?? ''}${cycle}` });
    // 一覧の周期は「前回の開始日から」なので、前回の開始日で判定する
    if (prev && gaps.has(prev.start)) detail.append(el('span', { className: 'tag tag-gap', textContent: GAP_LABEL }));
    list.append(el('li', {}, [
      el('div', {}, [
        el('div', { textContent: `${ymd(p.start)}${p.end ? ` 〜 ${md(p.end)}` : ''}` }),
        detail,
      ]),
      el('div', { className: 'row' }, [
        el('button', { type: 'button', textContent: '直す', onclick: () => startEdit(p) }),
        el('button', { type: 'button', textContent: '消す', onclick: () => remove(p) }),
      ]),
    ]));
  });
}

// ---- 体調管理：メモの一覧と検索 ----

// 文の中の検索語に印を付けて並べる
function highlight(text, query) {
  if (!query) return [text];
  const parts = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  for (let j = lower.indexOf(q); j >= 0; j = lower.indexOf(q, i)) {
    parts.push(text.slice(i, j), el('mark', { textContent: text.slice(j, j + q.length) }));
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

function noteItem(date, query, withYear) {
  const label = withYear ? `${ymd(date)}（${weekday(date)}）` : `${Number(date.slice(8))}日（${weekday(date)}）`;
  return el('li', { id: `note-${date}` }, [
    el('div', { className: 'note-row' }, [
      el('div', { textContent: label }),
      el('div', { className: 'small note-full' }, highlight(notes.get(date), query)),
    ]),
    el('div', { className: 'row note-btns' }, [
      el('button', { type: 'button', textContent: '開く', onclick: () => openDay(date) }),
      el('button', { type: 'button', textContent: '消す', onclick: () => removeNote(date) }),
    ]),
  ]);
}

async function removeNote(date) {
  if (!confirm(`${ymd(date)} のメモを消しますか？`)) return;
  await db.deleteNote(date);
  await load();
}

function renderNotes() {
  const query = $('noteSearch').value.trim();
  const list = $('notesList');
  list.replaceChildren();
  $('notesMonthHead').hidden = !!query;
  $('searchInfo').hidden = !query;

  if (query) {
    // 検索中は全期間から探して新しい順に並べる
    const q = query.toLowerCase();
    const hits = [...notes.keys()].filter(d => notes.get(d).toLowerCase().includes(q)).sort().reverse();
    $('searchInfo').textContent = hits.length ? `「${query}」を含むメモ ${hits.length}件` : `「${query}」を含むメモはありません。`;
    for (const date of hits) list.append(noteItem(date, query, true));
    return;
  }

  $('notesTitle').textContent = `${monthLabel(notesMonth)}の体調メモ`;
  const dates = datesInMonth(notesMonth);
  if (!dates.length) {
    list.append(el('li', { className: 'small', textContent: 'この月のメモはありません。生理管理のカレンダーで日付を押すと書けます。' }));
    return;
  }
  for (const date of dates) list.append(noteItem(date, '', false));
}

// ---- その日の画面（体調メモ） ----

function dayInfo(date) {
  const cls = dayMarks(predict(periods, today())).get(toDay(date)) ?? new Set();
  const parts = [];
  const d = toDay(date);
  const last = [...periods].reverse().find(p => toDay(p.start) <= d);
  if (last) parts.push(`周期の${d - toDay(last.start) + 1}日目`);
  if (cls.has('period')) parts.push('生理（記録）');
  else if (cls.has('predicted')) parts.push('生理（予定）');
  else if (cls.has('range')) parts.push('開始予測');
  if (cls.has('ovulation')) parts.push('排卵日の目安');
  return parts.join('・');
}

function openDay(date) {
  $('dayTitle').textContent = ymd(date);
  $('dayInfo').textContent = dayInfo(date);
  $('noteInput').value = notes.get(date) ?? '';
  // 未来の日やすでに開始日の日は、開始日にできない
  $('dayStartBtn').hidden = date > today() || periods.some(p => p.start === date);
  const dialog = $('dayDialog');
  dialog.returnValue = '';
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue === 'save') {
      await saveNote(date, $('noteInput').value);
    } else if (dialog.returnValue === 'start') {
      go('period');
      startNew(date);
    }
  }, { once: true });
  dialog.showModal();
}

async function saveNote(date, text) {
  const value = text.trim();
  if (value) await db.putNote({ date, text: value });
  else await db.deleteNote(date);
  await load();
}

async function renderBackupInfo() {
  const last = await db.getMeta('lastBackup');
  $('lastBackup').textContent = last ? `前回の書き出し：${ymd(last)}` : 'まだ書き出していません。';
  const remind = $('backupReminder');
  const stale = !last || toDay(today()) - toDay(last) >= BACKUP_REMIND_DAYS;
  remind.hidden = !(periods.length && stale);
  remind.replaceChildren(
    el('span', { textContent: last ? `前回のバックアップから${toDay(today()) - toDay(last)}日たちました` : 'まだバックアップがありません' }),
    el('a', { href: '#settings', textContent: '設定へ ›', onclick: e => { e.preventDefault(); openBackupSettings(); } }),
  );
}

// 設定のページに移って、バックアップの欄まで動かす
function openBackupSettings() {
  go('settings');
  $('backupCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- 記録の入力 ----

function startNew(start, scroll = true) {
  editingId = null;
  $('formTitle').textContent = '記録する';
  $('startInput').value = start;
  $('endInput').value = '';
  $('flowInput').value = 'normal';
  $('cancelEdit').hidden = true;
  $('formError').hidden = true;
  if (scroll) $('periodForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// これまでの記録の「直す」から、生理管理の入力欄で直す
function startEdit(p) {
  go('period');
  editingId = p.id;
  $('formTitle').textContent = `${ymd(p.start)} の記録を直す`;
  $('startInput').value = p.start;
  $('endInput').value = p.end ?? '';
  $('flowInput').value = p.flow ?? 'normal';
  $('cancelEdit').hidden = false;
  $('formError').hidden = true;
  $('periodForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function validate(p) {
  const t = today();
  if (p.start > t) return '始まった日が未来になっています。';
  if (p.end && p.end < p.start) return '終わった日が、始まった日より前になっています。';
  if (p.end && p.end > t) return '終わった日が未来になっています。';
  if (p.end && toDay(p.end) - toDay(p.start) + 1 > 14) return '14日を超えています。日付を確かめてください。';
  const s = toDay(p.start);
  const e = p.end ? toDay(p.end) : s;
  for (const o of periods) {
    if (o.id === p.id) continue;
    const os = toDay(o.start);
    const oe = o.end ? toDay(o.end) : os;
    if (s <= oe && os <= e) return `${ymd(o.start)} の記録と日付が重なっています。`;
  }
  return null;
}

async function save(p) {
  const error = validate(p);
  if (error) {
    $('formError').textContent = error;
    $('formError').hidden = false;
    return false;
  }
  await db.putPeriod(p);
  await load();
  return true;
}

async function remove(p) {
  if (!confirm(`${ymd(p.start)} の記録を消しますか？`)) return;
  await db.deletePeriod(p.id);
  if (editingId === p.id) startNew(today(), false);
  await load();
}

$('periodForm').addEventListener('submit', async e => {
  e.preventDefault();
  const p = {
    start: $('startInput').value,
    end: $('endInput').value || null,
    flow: $('flowInput').value,
  };
  if (editingId != null) p.id = editingId;
  if (await save(p)) startNew(today(), false);
});

$('cancelEdit').addEventListener('click', () => startNew(today(), false));

$('viewCal').addEventListener('click', () => { setView('cal'); db.setMeta('view', 'cal'); });
$('viewTable').addEventListener('click', () => { setView('table'); db.setMeta('view', 'table'); });

$('prevMonth').addEventListener('click', () => shiftMonth(-1));
$('nextMonth').addEventListener('click', () => shiftMonth(1));

function shiftMonth(delta) {
  viewMonth = addMonth(viewMonth, delta);
  renderCalendar(predict(periods, today()));
}

$('legendBtn').addEventListener('click', () => $('legendDialog').showModal());

$('notesPrev').addEventListener('click', () => { notesMonth = addMonth(notesMonth, -1); renderNotes(); });
$('notesNext').addEventListener('click', () => { notesMonth = addMonth(notesMonth, 1); renderNotes(); });
$('noteSearch').addEventListener('input', renderNotes);

$('openRecords').addEventListener('click', () => go('records'));
$('backToSettings').addEventListener('click', () => go('settings'));

// ---- バックアップ ----

function askPassphrase({ title, help, confirmTwice }) {
  const dialog = $('passDialog');
  $('passTitle').textContent = title;
  $('passHelp').textContent = help;
  $('pass1').value = '';
  $('pass2').value = '';
  $('pass2Label').hidden = !confirmTwice;
  $('passError').hidden = true;

  return new Promise(resolve => {
    const form = $('passForm');
    const onSubmit = e => {
      if (e.submitter?.value !== 'ok') return;
      const p1 = $('pass1').value;
      let error = null;
      if (confirmTwice && p1.length < MIN_PASS) error = `合言葉は${MIN_PASS}文字以上にしてください。`;
      else if (confirmTwice && p1 !== $('pass2').value) error = '2回の入力が一致しません。';
      else if (!p1) error = '合言葉を入れてください。';
      if (error) {
        e.preventDefault();
        $('passError').textContent = error;
        $('passError').hidden = false;
      }
    };
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', () => {
      form.removeEventListener('submit', onSubmit);
      const value = dialog.returnValue === 'ok' ? $('pass1').value : null;
      $('pass1').value = '';
      $('pass2').value = '';
      resolve(value);
    }, { once: true });
    dialog.returnValue = '';
    dialog.showModal();
    $('pass1').focus();
  });
}

async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

$('exportBtn').addEventListener('click', async () => {
  if (!periods.length && !notes.size) {
    alert('まだ記録がありません。');
    return;
  }
  const pass = await askPassphrase({
    title: 'バックアップを書き出す',
    help: `合言葉を決めてください（${MIN_PASS}文字以上）。読み込むときに必要です。忘れると誰にも元に戻せません。`,
    confirmTwice: true,
  });
  if (!pass) return;
  await busy($('exportBtn'), '暗号化中…', async () => {
    const data = {
      app: 'cycle-app',
      exportedAt: today(),
      periods: periods.map(({ id, ...p }) => p),
      notes: [...notes].map(([date, text]) => ({ date, text })),
    };
    const text = await encryptBackup(data, pass);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = el('a', { href: url, download: `cycle-backup-${today().replaceAll('-', '')}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    await db.setMeta('lastBackup', today());
    await renderBackupInfo();
  });
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  const pass = await askPassphrase({
    title: 'バックアップを読み込む',
    help: '書き出したときの合言葉を入れてください。',
    confirmTwice: false,
  });
  if (!pass) return;
  await busy($('importBtn'), '復号中…', async () => {
    let data;
    try {
      data = await decryptBackup(await file.text(), pass);
    } catch (err) {
      alert(err.message);
      return;
    }
    const incoming = cleanImported(data);
    if (!incoming) {
      alert('このアプリのバックアップではありません。');
      return;
    }
    const count = (p, n) => `生理の記録${p}件・体調メモ${n}件`;
    const msg = periods.length || notes.size
      ? `今の${count(periods.length, notes.size)}を、ファイルの${count(incoming.periods.length, incoming.notes.length)}に置き換えます。よろしいですか？`
      : `ファイルの${count(incoming.periods.length, incoming.notes.length)}を読み込みます。よろしいですか？`;
    if (!confirm(msg)) return;
    await db.replacePeriods(incoming.periods);
    await db.replaceNotes(incoming.notes);
    await load();
  });
});

function cleanImported(data) {
  if (data?.app !== 'cycle-app' || !Array.isArray(data.periods)) return null;
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const rows = [];
  for (const p of data.periods) {
    if (!isDate(p.start) || (p.end != null && !isDate(p.end))) return null;
    rows.push({ start: p.start, end: p.end ?? null, flow: FLOW_LABEL[p.flow] ? p.flow : 'normal' });
  }
  // メモを入れる前に書き出したファイルには notes がない
  const noteRows = [];
  for (const n of data.notes ?? []) {
    if (!isDate(n.date) || typeof n.text !== 'string') return null;
    noteRows.push({ date: n.date, text: n.text });
  }
  return { periods: rows, notes: noteRows };
}

// ---- 起動 ----

async function init() {
  viewMonth = today().slice(0, 8) + '01';
  notesMonth = viewMonth;
  startNew(today(), false);
  setView((await db.getMeta('view')) ?? 'cal');
  showPage(currentPage());
  // ブラウザが空き容量の都合でデータを消さないよう頼む（認められるかはブラウザ次第）
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
  await load();
}

// ---- バージョンと更新（EARN VIEWER と同じ作り） ----

function showStatus() {
  $('status').textContent = `Version：${self.APP_VERSION}`;
}

// 新しい版の Service Worker に入れ替わるまで待ってから再読み込みする（最大 15 秒）
// 先に保管庫を消すと、入れ替わる前に古い版の Service Worker が古いファイルを取り直してしまうことがあるため、消さない
// （古い版の保管庫は、新しい版の Service Worker が入れ替わるときに消す）
// 戻り値：入れ替わったら true（再読み込みする）。入れ替わらなければ false
function waitForNewWorker(reg, ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    navigator.serviceWorker.addEventListener('controllerchange', () => finish(true), { once: true });
    const watch = w => w && w.addEventListener('statechange', () => { if (w.state === 'activated') finish(true); if (w.state === 'redundant') finish(false); });
    watch(reg.installing); watch(reg.waiting);
    reg.addEventListener('updatefound', () => watch(reg.installing));
    if (reg.waiting) reg.waiting.postMessage('skipWaiting');
    setTimeout(() => finish(false), ms);
  });
}

async function applyUpdate() {
  $('status').textContent = '更新中…';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      const waiting = waitForNewWorker(reg, 15000);
      await reg.update();
      const ok = await waiting;
      if (!ok && !(await newerVersion())) {
        showStatus();
        alert('新しいバージョンの準備ができませんでした。公開の直後は、反映まで数分かかることがあります。少し待ってから、もう一度お試しください。');
        return;
      }
    }
  } catch { /* 失敗しても再読み込みで取り直す */ }
  location.reload();
}

// 公開サイトの一時保管（最大 10 分）を通さずに、最新の版の番号を読む。今より新しければその番号、同じなら null
async function newerVersion() {
  const res = await fetch(`version.js?t=${Date.now()}`, { cache: 'no-store' });
  const latest = ((await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  return latest && latest !== self.APP_VERSION ? latest : null;
}

$('appVersion').textContent = self.APP_VERSION;
showStatus();
// 「新しいバージョンがあります［更新する］」は、新しい版に入れ替わったあとに出るので、すぐ再読み込みする
$('reloadBtn').addEventListener('click', () => location.reload());

if ('serviceWorker' in navigator) {
  // 新しい版の Service Worker に切り替わったら、再読み込みを促す（初回のインストール時は除く）
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) $('updateNote').hidden = false; });
}

$('updateBtn').addEventListener('click', async () => {
  const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
  if (!reg) { alert('更新を確認できませんでした'); return; }
  $('updateBtn').disabled = true;
  try {
    const latest = await newerVersion();
    if (latest) {
      if (confirm(`新しいバージョン（${latest}）があります。更新しますか？`)) await applyUpdate();
    } else {
      alert(`最新のバージョンです（${self.APP_VERSION}）`);
    }
  } catch {
    alert('更新を確認できませんでした（通信を確認してください）');
  } finally {
    $('updateBtn').disabled = false;
  }
});

init();
