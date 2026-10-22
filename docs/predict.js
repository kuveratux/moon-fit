// 生理周期の予測（端末内で計算。外部には何も送らない）
// 日付は 'YYYY-MM-DD' 文字列で受け取り、内部では「1970-01-01 からの日数」で扱う

const DAY_MS = 86400000;

// 記録が少ない時期の出発点（一般的な値）
const PRIOR_CYCLE = 28;   // 周期の日数
const PRIOR_SD = 3;       // 周期のばらつき（日）
const PRIOR_LENGTH = 5;   // 生理の日数
const PRIOR_WEIGHT = 2;   // 出発点を「何周期分の記録」として扱うか

const RECENT = 6;         // 直近何周期を使うか
const MIN_CYCLE = 15;     // これより短い・長い周期は記録漏れなどとみなして除外
const MAX_CYCLE = 60;
const GAP_RATIO = 1.6;    // ふだんの周期（中央値）のこの倍を超える間隔は、1回分の記録漏れとみなす
const GAP_MIN_CYCLES = 3; // ふだんの周期を測るのに要る周期の数（これ未満なら倍率では判定しない）
const GAP_BASE = 12;      // ふだんの周期を測るのに使う直近の周期の数

export function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdev(a) {
  if (a.length < 2) return 0;
  const mu = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1));
}

// 記録の重みと出発点の重みで混ぜる（記録が増えるほど自分の値に近づき、RECENT 周期で自分の値だけになる）
function blend(prior, own, n) {
  const w = PRIOR_WEIGHT * Math.max(0, 1 - n / RECENT);
  return (w * prior + n * own) / (w + n);
}

// periods: [{ start: 'YYYY-MM-DD', end?: 'YYYY-MM-DD' }]
// today: 'YYYY-MM-DD'
export function predict(periods, today, count = 3) {
  const starts = [...new Set(periods.map(p => toDay(p.start)))].sort((a, b) => a - b);
  if (!starts.length) return null;

  const cycles = [];
  for (let i = 1; i < starts.length; i++) cycles.push(starts[i] - starts[i - 1]);
  const inRange = cycles.filter(c => c >= MIN_CYCLE && c <= MAX_CYCLE);
  // 1回抜けると間隔が約2倍になり 60 日に収まってしまうので、ふだんの周期と比べても判定する
  const base = inRange.length >= GAP_MIN_CYCLES ? median(inRange.slice(-GAP_BASE)) : null;
  const isGap = c => c > MAX_CYCLE || (base != null && c > base * GAP_RATIO);
  const valid = cycles.filter(c => c >= MIN_CYCLE && !isGap(c));
  // 記録漏れかもしれない間隔の、始まりの開始日
  const gaps = cycles.flatMap((c, i) => (isGap(c) ? [fromDay(starts[i])] : []));
  const recent = valid.slice(-RECENT);
  const n = recent.length;

  const ownMedian = n ? median(recent) : PRIOR_CYCLE;
  const ownSd = n >= 2 ? stdev(recent) : PRIOR_SD;
  const cycle = blend(PRIOR_CYCLE, ownMedian, n);
  const spread = Math.max(1, blend(PRIOR_SD, ownSd, n));

  const lengths = periods
    .filter(p => p.end)
    .map(p => toDay(p.end) - toDay(p.start) + 1)
    .filter(l => l >= 1 && l <= 14)
    .slice(-RECENT);
  const length = Math.round(lengths.length ? blend(PRIOR_LENGTH, median(lengths), lengths.length) : PRIOR_LENGTH);

  const last = starts[starts.length - 1];
  const todayDay = toDay(today);
  const next = [];
  for (let k = 1; k <= count; k++) {
    const center = last + Math.round(cycle * k);
    // 先の周期ほどずれが積み重なるので幅を広げる
    const half = Math.round(spread * Math.sqrt(k));
    next.push({
      center: fromDay(center),
      earliest: fromDay(center - half),
      latest: fromDay(center + half),
      length,
    });
  }

  return {
    lastStart: fromDay(last),
    dayOfCycle: todayDay - last + 1,
    daysUntil: toDay(next[0].center) - todayDay,
    overdue: Math.max(0, todayDay - toDay(next[0].latest)),
    cycle: Math.round(cycle * 10) / 10,
    spread: Math.round(spread * 10) / 10,
    length,
    next,
    gaps,
    basis: {
      used: n,
      excluded: cycles.length - valid.length,
      gaps: gaps.length,
      ownMedian: n ? ownMedian : null,
      ownSd: n >= 2 ? Math.round(ownSd * 10) / 10 : null,
      usingPrior: n < RECENT,
    },
  };
}
