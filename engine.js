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

  /** 今の時期に播種適期の作物（植え付け提案・挑戦提案の土台） */
  function sowableNow(master, region, today, experiencedCropIds) {
    var exp = experiencedCropIds || [];
    return master.crops
      .filter(function (c) {
        var cal = c.calendar && c.calendar[region];
        if (!cal || !cal.sow) return false;
        return cal.sow.some(function (r) { return inCalendarRange(today, r.from, r.to); });
      })
      .map(function (c) {
        return { cropId: c.id, name: c.name, difficulty: c.difficulty, isNew: exp.indexOf(c.id) === -1 };
      })
      .sort(function (a, b) { return a.difficulty - b.difficulty; });
  }

  return {
    evaluateAll: evaluateAll,
    evaluatePlanting: evaluatePlanting,
    sowableNow: sowableNow,
    currentStage: currentStage,
    _util: { daysBetween: daysBetween, addDays: addDays, inCalendarRange: inCalendarRange, gddSince: gddSince, dryDays: dryDays }
  };
});
