/**
 * 農業管理アプリ 判定エンジン（たたき台 v0.1）
 * - ブラウザ: <script src="engine.js"></script> → window.AgriEngine
 * - Node:    const AgriEngine = require('./engine.js')
 *
 * 日付はすべて 'YYYY-MM-DD' 文字列で扱い、比較は slice(0,10) の文字列比較を基本にする。
 * 日数計算のみ Date.UTC を使う（タイムゾーンずれ防止）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AgriEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 日付ユーティリティ ----------
  function toUTC(dateStr) {
    var s = String(dateStr).slice(0, 10);
    var y = Number(s.slice(0, 4));
    var m = Number(s.slice(5, 7));
    var d = Number(s.slice(8, 10));
    return Date.UTC(y, m - 1, d);
  }

  function daysBetween(fromStr, toStr) {
    return Math.round((toUTC(toStr) - toUTC(fromStr)) / 86400000);
  }

  function addDays(dateStr, n) {
    var t = new Date(toUTC(dateStr) + n * 86400000);
    return t.toISOString().slice(0, 10);
  }

  /** 'MM-DD' の期間判定。from > to の場合は年またぎとして扱う */
  function inCalendarRange(dateStr, from, to) {
    var md = String(dateStr).slice(5, 10);
    if (from <= to) return md >= from && md <= to;
    return md >= from || md <= to;
  }

  // ---------- ステージ判定 ----------
  /**
   * 記録済みイベントから現在ステージを決める。
   * startMethod の stages を順に見て、startEvent が記録されている最後のステージを現在とする。
   */
  function currentStage(crop, planting) {
    var method = crop.startMethods[planting.startMethod || crop.defaultStartMethod];
    if (!method) return null;
    var events = planting.events || {};
    var stageMap = {};
    crop.stages.forEach(function (s) { stageMap[s.id] = s; });

    var current = method.stages[0];
    method.stages.forEach(function (stageId) {
      var st = stageMap[stageId];
      if (st && events[st.startEvent]) current = stageId;
    });
    return current;
  }

  // ---------- 気象の集計 ----------
  /** 積算温度：event 日の翌日から today まで、(日平均気温 - base) の正の値を合計 */
  function gddSince(startDate, today, base, dailyMeanTemps) {
    var total = 0;
    var missing = 0;
    var n = daysBetween(startDate, today);
    for (var i = 1; i <= n; i++) {
      var d = addDays(startDate, i);
      var t = dailyMeanTemps ? dailyMeanTemps[d] : undefined;
      if (typeof t !== 'number') { missing++; continue; }
      if (t > base) total += (t - base);
    }
    return { value: total, missingDays: missing };
  }

  /** 昨日から遡って連続で降水量 1mm 未満の日数（今日は観測途中なので含めない） */
  function dryDays(today, observedPrecip) {
    var count = 0;
    for (var i = 1; i <= 60; i++) {
      var d = addDays(today, -i);
      var p = observedPrecip ? observedPrecip[d] : undefined;
      if (typeof p !== 'number') break;
      if (p >= 1) break;
      count++;
    }
    return count;
  }

  function forecastMetric(metric, days, forecast, today) {
    var list = (forecast || []).filter(function (f) {
      var d = String(f.date).slice(0, 10);
      return d >= today && d < addDays(today, days);
    });
    if (list.length === 0) return null;
    if (metric === 'precipSum') {
      return list.reduce(function (sum, f) { return sum + (f.precip || 0); }, 0);
    }
    if (metric === 'tempMin') {
      return Math.min.apply(null, list.map(function (f) { return f.tempMin; }));
    }
    if (metric === 'tempMax') {
      return Math.max.apply(null, list.map(function (f) { return f.tempMax; }));
    }
    return null;
  }

  function compare(value, op, target) {
    if (value === null || value === undefined) return false;
    if (op === 'gte') return value >= target;
    if (op === 'lte') return value <= target;
    return false;
  }

  function inRange(value, cond) {
    if (cond.gte !== undefined && value < cond.gte) return false;
    if (cond.lte !== undefined && value > cond.lte) return false;
    return true;
  }

  // ---------- 条件評価 ----------
  /**
   * 1条件を評価する。
   * 戻り値: { ok: boolean, detail: string }
   */
  function evalCondition(cond, crop, planting, ctx, stage) {
    var events = planting.events || {};
    var today = ctx.today;

    switch (cond.type) {
      case 'daysSince': {
        var start = events[cond.event];
        if (!start) return { ok: false, detail: cond.event + ' 未記録' };
        var days = daysBetween(start, today);
        var overdue = cond.dueBy !== undefined && days > cond.dueBy;
        return {
          ok: inRange(days, cond),
          overdue: overdue,
          detail: cond.event + 'から' + days + '日' + (overdue ? '（目安を' + (days - cond.dueBy) + '日過ぎています）' : '')
        };
      }
      case 'gddSince': {
        var s = events[cond.event];
        if (!s) return { ok: false, detail: cond.event + ' 未記録' };
        var g = gddSince(s, today, cond.base, ctx.dailyMeanTemps);
        if (g.missingDays > 0) {
          return { ok: false, detail: '気温データ欠損 ' + g.missingDays + '日' };
        }
        return { ok: inRange(g.value, cond), detail: '積算温度 ' + Math.round(g.value) + '℃日' };
      }
      case 'calendar':
        return { ok: inCalendarRange(today, cond.from, cond.to), detail: cond.from + '〜' + cond.to };
      case 'stage':
        return { ok: cond.in.indexOf(stage) !== -1, detail: 'ステージ ' + stage };
      case 'eventDone': {
        var done = !!events[cond.event];
        return { ok: done === cond.done, detail: cond.event + (done ? ' 済' : ' 未') };
      }
      case 'forecast': {
        var v = forecastMetric(cond.metric, cond.days, ctx.forecast, today);
        return { ok: compare(v, cond.op, cond.value), detail: '予報 ' + cond.metric + '=' + v };
      }
      case 'observed': {
        if (cond.metric === 'dryDays') {
          var dd = dryDays(today, ctx.observedPrecip);
          return { ok: compare(dd, cond.op, cond.value), detail: '連続無降水 ' + dd + '日' };
        }
        return { ok: false, detail: '未対応の観測指標 ' + cond.metric };
      }
      default:
        return { ok: false, detail: '未対応の条件 ' + cond.type };
    }
  }

  // ---------- メイン ----------
  /**
   * 1つの作付けについて「今日やること」を返す。
   * @param {object} crop      crops.json の crop 要素
   * @param {object} planting  { id, cropId, startMethod, region, events: { sow: 'YYYY-MM-DD', ... } }
   * @param {object} ctx       { today, dailyMeanTemps: {date: ℃}, observedPrecip: {date: mm}, forecast: [{date,tempMin,tempMax,precip}] }
   * @returns {Array} [{ ruleId, action, title, message, priority, confidence, reasons }]
   */
  function evaluatePlanting(crop, planting, ctx) {
    // 未来日付のイベント（予定入力）は判定から除外する
    var events = {};
    var raw = planting.events || {};
    Object.keys(raw).forEach(function (k) {
      if (raw[k] && String(raw[k]).slice(0, 10) <= ctx.today) events[k] = raw[k];
    });
    planting = Object.assign({}, planting, { events: events });
    var stage = currentStage(crop, planting);
    var results = [];

    (crop.rules || []).forEach(function (rule) {
      if (rule.enabled === false) return;
      if (rule.resolvedBy && events[rule.resolvedBy]) return;

      var conds = (rule.trigger && rule.trigger.all) || [];
      var reasons = [];
      var overdue = false;
      var allOk = conds.every(function (c) {
        var r = evalCondition(c, crop, planting, ctx, stage);
        reasons.push(r.detail);
        if (r.overdue) overdue = true;
        return r.ok;
      });

      if (allOk) {
        results.push({
          plantingId: planting.id,
          cropId: crop.id,
          ruleId: rule.id,
          action: rule.action,
          title: rule.title,
          message: rule.message,
          priority: rule.priority,
          confidence: rule.confidence,
          fertilizer: rule.fertilizer || null,
          overdue: overdue,
          reasons: reasons
        });
      }
    });

    // 遅れ気味のものを同じ優先度の中で先に出す
    results.sort(function (a, b) {
      return (a.priority - b.priority) || ((b.overdue ? 1 : 0) - (a.overdue ? 1 : 0));
    });
    return { stage: stage, tasks: results };
  }

  // ---------- 土づくり（準備） ----------
  /**
   * 土づくりの基準日（種まき予定日／定植予定日）を求める。
   * 基準のイベントが記録済みなら準備は終わっているので null。
   * 戻り値: { event, date, estimated } または null
   */
  function prepAnchor(crop, planting) {
    var sp = crop.soilPrep;
    if (!sp) return null;
    var method = planting.startMethod || crop.defaultStartMethod;
    var ev = (sp.anchorEvents && sp.anchorEvents[method]) || 'sow';
    var events = planting.events || {};
    if (events[ev]) return null;
    if (planting.plannedEvent === ev && planting.plannedDate) {
      return { event: ev, date: String(planting.plannedDate).slice(0, 10), estimated: false };
    }
    // たまねぎを種から育てている場合：播種日＋育苗日数で定植予定日を見積もる
    if (ev === 'transplant' && events.sow && sp.estimateFromSow) {
      return { event: ev, date: addDays(events.sow, sp.estimateFromSow), estimated: true };
    }
    return null;
  }

  function stepAmounts(step, fertType) {
    var a = step.amounts || {};
    return (a.common || []).concat(a[fertType] || []);
  }

  /** 準備の全工程と予定日（作付けの詳細画面用） */
  function prepSchedule(crop, planting, fertType) {
    var anchor = prepAnchor(crop, planting);
    if (!anchor) return null;
    var events = planting.events || {};
    var type = fertType === 'organic' ? 'organic' : 'chemical';
    return {
      anchor: anchor,
      steps: crop.soilPrep.steps.map(function (st) {
        var before = (st.daysBefore && st.daysBefore[type]) || 0;
        return {
          id: st.id, event: st.event, title: st.title, message: st.message,
          dueDate: addDays(anchor.date, -before), daysBefore: before,
          doneDate: events[st.event] || null,
          amounts: stepAmounts(st, type)
        };
      })
    };
  }

  /**
   * 今日やるべき準備作業。
   * - 各工程は「基準日 − daysBefore」から表示し、記録されるまで出し続ける
   * - 予定のまま基準日を迎えたら、種まき（定植）の記録を促す
   */
  function evaluatePrep(crop, planting, ctx, fertType) {
    var sched = prepSchedule(crop, planting, fertType);
    var tasks = [];
    if (!sched) return tasks;
    var today = ctx.today;
    var daysLeft = daysBetween(today, sched.anchor.date);

    sched.steps.forEach(function (st, i) {
      if (st.doneDate || today < st.dueDate) return;
      // 後の工程が先に記録されていれば、前の工程は省略されたものとして出さない
      var laterDone = sched.steps.slice(i + 1).some(function (s) { return !!s.doneDate; });
      if (laterDone) return;
      tasks.push({
        kind: 'prep', plantingId: planting.id, cropId: crop.id,
        ruleId: 'prep-' + st.id, event: st.event,
        title: st.title, message: st.message, amounts: st.amounts,
        dueDate: st.dueDate, anchor: sched.anchor, daysLeft: daysLeft,
        overdue: today > addDays(st.dueDate, 3),
        priority: 2, confidence: crop.soilPrep.confidence || 'draft'
      });
    });

    if (planting.status === 'planned' && planting.plannedEvent === sched.anchor.event && daysLeft <= 0) {
      tasks.unshift({
        kind: 'start', plantingId: planting.id, cropId: crop.id,
        ruleId: 'start-' + sched.anchor.event, event: sched.anchor.event,
        anchor: sched.anchor, daysLeft: daysLeft, overdue: daysLeft < 0,
        priority: 1, confidence: 'draft'
      });
    }
    return tasks;
  }

  /** 全作付けをまとめて評価 */
  function evaluateAll(master, plantings, ctx) {
    var cropMap = {};
    master.crops.forEach(function (c) { cropMap[c.id] = c; });
    return plantings.map(function (p) {
      var crop = cropMap[p.cropId];
      if (!crop) return { plantingId: p.id, error: '作物マスタにない cropId: ' + p.cropId };
      var r = evaluatePlanting(crop, p, ctx);
      return { plantingId: p.id, cropId: p.cropId, cropName: crop.name, stage: r.stage, tasks: r.tasks };
    });
  }

  // ---------- 適期の判定 ----------
  function firstEvent(crop, methodKey) {
    var m = crop.startMethods[methodKey];
    if (!m) return null;
    var st = crop.stages.filter(function (s) { return s.id === m.stages[0]; })[0];
    return st ? st.startEvent : null;
  }

  /** 'MM-DD' を年内の通し日（0〜364）に */
  function dayOfYear(md) {
    var t = Date.UTC(2001, Number(md.slice(0, 2)) - 1, Number(md.slice(3, 5)));
    return Math.round((t - Date.UTC(2001, 0, 1)) / 86400000);
  }

  /**
   * 開始日（種まき・定植・植え付け）が地域の適期に入っているか。
   * 戻り値: null（暦データなし） / { ok, event, windows, nearest, position: 'early'|'late', days }
   */
  function seasonCheck(crop, methodKey, region, dateStr) {
    var ev = firstEvent(crop, methodKey);
    var cal = crop.calendar && crop.calendar[region];
    var wins = ev && cal && cal[ev];
    if (!wins || wins.length === 0) return null;
    var md = String(dateStr).slice(5, 10);
    var inWin = wins.some(function (w) { return inCalendarRange(dateStr, w.from, w.to); });
    if (inWin) return { ok: true, event: ev, windows: wins };
    var d = dayOfYear(md);
    var best = null;
    wins.forEach(function (w) {
      var untilStart = (dayOfYear(w.from) - d + 365) % 365;   // 適期まであと何日（早すぎ）
      var sinceEnd = (d - dayOfYear(w.to) + 365) % 365;       // 適期を何日過ぎた（遅すぎ）
      if (!best || untilStart < best.days) best = { position: 'early', days: untilStart, nearest: w };
      if (sinceEnd < best.days) best = { position: 'late', days: sinceEnd, nearest: w };
    });
    return { ok: false, event: ev, windows: wins, nearest: best.nearest, position: best.position, days: best.days };
  }

  /** 今が始めどき（種まき・植え付け）の作物。開始方法ごとに判定する（植え付け提案・挑戦提案の土台） */
  function sowableNow(master, region, today, experiencedCropIds) {
    var exp = experiencedCropIds || [];
    var out = [];
    master.crops.forEach(function (c) {
      var methods = Object.keys(c.startMethods).filter(function (k) {
        var r = seasonCheck(c, k, region, today);
        return r && r.ok;
      });
      if (methods.length === 0) return;
      // 既定の開始方法を優先
      methods.sort(function (a, b) { return (a === c.defaultStartMethod ? -1 : 0) - (b === c.defaultStartMethod ? -1 : 0); });
      out.push({
        cropId: c.id, name: c.name, difficulty: c.difficulty, isNew: exp.indexOf(c.id) === -1,
        methods: methods.map(function (k) { return { key: k, label: c.startMethods[k].label, event: firstEvent(c, k) }; })
      });
    });
    return out.sort(function (a, b) { return a.difficulty - b.difficulty; });
  }

  return {
    evaluateAll: evaluateAll,
    evaluatePlanting: evaluatePlanting,
    sowableNow: sowableNow,
    seasonCheck: seasonCheck,
    firstEvent: firstEvent,
    currentStage: currentStage,
    evaluatePrep: evaluatePrep,
    prepSchedule: prepSchedule,
    prepAnchor: prepAnchor,
    _util: { daysBetween: daysBetween, addDays: addDays, inCalendarRange: inCalendarRange, gddSince: gddSince, dryDays: dryDays }
  };
});
