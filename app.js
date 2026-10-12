// 畑ノート 試作版 v0.3（実績・時期外れの注意・12品目）
// 素のJS（ES Modules）＋ Firebase（Auth / Firestore オフライン永続化）
// 日付はすべて 'YYYY-MM-DD' 文字列（JST）で扱う。

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot,
  serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const Engine = window.AgriEngine;

// ---------- 定数 ----------
const EVENT_LABELS = {
  prepLime: "苦土石灰をまいた",
  prepBase: "堆肥・元肥を入れた",
  prepRidge: "畝を立てた",
  sow: "種まき",
  plant: "植え付け",
  sprout: "芽が出た",
  budThin: "芽かき",
  stake: "支柱立て",
  germinate: "発芽",
  transplant: "定植",
  rooted: "活着（根付いた）",
  thin1: "間引き 1回目",
  thin2: "間引き 2回目",
  thin3: "間引き 3回目",
  fertilize1: "追肥 1回目",
  fertilize2: "追肥 2回目",
  fertilize3: "追肥 3回目",
  fertilize4: "追肥 4回目",
  bulbStart: "玉の肥大が始まった",
  harvestStart: "収穫開始",
  harvestEnd: "収穫終了"
};
const EVENT_ORDER = [
  "prepLime", "prepBase", "prepRidge", "sow", "plant", "germinate", "sprout", "transplant", "rooted", "stake",
  "thin1", "thin2", "thin3", "budThin", "fertilize1", "fertilize2", "fertilize3", "fertilize4",
  "bulbStart", "harvestStart", "harvestEnd"
];
const WX_TTL_MS = 3 * 60 * 60 * 1000; // 天気キャッシュの有効時間（3時間）

// ---------- 状態 ----------
const state = {
  user: null,
  userDoc: null,
  master: null,
  fields: [],
  plantings: [],
  weather: {},      // fieldId -> { data, fetchedAt, stale }
  unsubs: []
};

// ---------- ユーティリティ ----------
const $ = (sel) => document.querySelector(sel);

function todayJST() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function md(dateStr) {
  const s = String(dateStr).slice(0, 10);
  return Number(s.slice(5, 7)) + "/" + Number(s.slice(8, 10));
}

// ---------- 肥料の設定と量の表示 ----------
// 肥料の設定は作付け（野菜）ごとに持つ。未設定の古い作付けは、以前の共通設定→既定値の順で補う。
function fertType(planting) {
  const v = (planting && planting.fertType) || (state.userDoc && state.userDoc.fertType);
  return v === "organic" ? "organic" : "chemical";
}

function showAmounts(planting) {
  const v = (planting && planting.fertDisplay) || (state.userDoc && state.userDoc.fertDisplay);
  return v !== "timing";
}

function bedArea(planting) {
  const l = Number(planting.bedLength), w = Number(planting.bedWidth);
  return l > 0 && w > 0 ? l * w : 0;
}

function fmtWeight(g) {
  if (g >= 1000) return (Math.round(g / 100) / 10) + "kg";
  if (g >= 50) return (Math.round(g / 5) * 5) + "g";
  return Math.round(g) + "g";
}

function fmtArea(a) {
  return String(Math.round(a * 100) / 100);
}

/** 資材リストを表示用の行に整形する（量を出さない設定なら名前だけ） */
function amountLines(list, planting) {
  if (!list || list.length === 0) return [];
  if (!showAmounts(planting)) return ["使うもの：" + list.map((a) => a.name).join("、")];
  const area = bedArea(planting);
  return list.map((a) => a.name + "　" + fmtWeight(a.g_m2) + "／㎡"
    + (area ? "（この畝 " + fmtArea(area) + "㎡で 約" + fmtWeight(a.g_m2 * area) + "）" : ""));
}

function amountBlock(list, planting, note) {
  const lines = amountLines(list, planting);
  if (lines.length === 0 && !note) return "";
  return '<div class="amounts">' + lines.map((l) => "<div>" + esc(l) + "</div>").join("")
    + (showAmounts(planting) && list && list.length && !bedArea(planting)
      ? '<div class="muted small">畝の大きさを登録すると、必要な量を計算します</div>' : "")
    + (note ? '<div class="muted small">' + esc(note) + "</div>" : "")
    + "</div>";
}

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できなくても動作は継続 */ }
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

/** Firestore の書き込みはオフラインだとサーバー応答まで解決しないため、待たずにエラーだけ拾う */
function fire(promise, okMsg) {
  if (okMsg) toast(okMsg);
  promise.catch((err) => {
    console.error(err);
    toast("保存に失敗しました：" + (err.code || err.message));
  });
}

function cropById(id) {
  return state.master ? state.master.crops.find((c) => c.id === id) : null;
}

function fieldById(id) {
  return state.fields.find((f) => f.id === id) || null;
}

function stageName(crop, stageId) {
  const st = crop.stages.find((s) => s.id === stageId);
  return st ? st.name : stageId;
}

function methodOf(crop, planting) {
  return crop.startMethods[planting.startMethod] || crop.startMethods[crop.defaultStartMethod];
}

/** この開始方法で成立しうるルールか（例：苗からの場合、種まき起点の間引きルールは対象外） */
function ruleApplies(crop, method, r) {
  if (r.enabled === false) return false;
  const methodStageEvents = new Set(method.stages.map((sid) => {
    const st = crop.stages.find((s) => s.id === sid);
    return st ? st.startEvent : null;
  }));
  return (r.trigger.all || []).every((c) => {
    if (c.type === "daysSince" || c.type === "gddSince") {
      const isStageEvent = crop.stages.some((st) => st.startEvent === c.event);
      return !isStageEvent || methodStageEvents.has(c.event);
    }
    if (c.type === "stage") return c.in.some((sid) => method.stages.includes(sid));
    return true;
  });
}

/** その作付けで記録しうるイベントの一覧（開始方法のステージ＋ルールが参照するイベント） */
function eventsForPlanting(crop, planting) {
  const set = new Set();
  const method = methodOf(crop, planting);
  method.stages.forEach((sid) => {
    const st = crop.stages.find((s) => s.id === sid);
    if (st) set.add(st.startEvent);
  });
  crop.rules.filter((r) => ruleApplies(crop, method, r)).forEach((r) => {
    if (r.resolvedBy) set.add(r.resolvedBy);
    (r.trigger.all || []).forEach((c) => {
      if (c.type === "eventDone" || c.type === "daysSince" || c.type === "gddSince") set.add(c.event);
    });
  });
  // 開始方法に含まれないステージのイベント（苗から始めた場合の sow など）は除外
  const methodEvents = new Set(method.stages.map((sid) => {
    const st = crop.stages.find((s) => s.id === sid);
    return st ? st.startEvent : null;
  }));
  crop.stages.forEach((st) => {
    if (!methodEvents.has(st.startEvent)) set.delete(st.startEvent);
  });
  set.add("harvestStart");
  set.add("harvestEnd");
  if (crop.soilPrep) crop.soilPrep.steps.forEach((st) => set.add(st.event));
  const ordered = EVENT_ORDER.filter((e) => set.has(e));
  set.forEach((e) => { if (!ordered.includes(e)) ordered.push(e); });
  return ordered;
}

function firstEventOf(crop, methodKey) {
  const method = crop.startMethods[methodKey];
  const st = crop.stages.find((s) => s.id === method.stages[0]);
  return st ? st.startEvent : "sow";
}

/** 判定の根拠に含まれる内部ID（イベント・ステージ）を表示名に置き換える */
function prettyReason(text, crop) {
  let s = String(text).replace(/ステージ ([a-zA-Z]+)/g, (m, id) => "ステージ：" + stageName(crop, id));
  s = s.replace(/\b([a-zA-Z]+[0-9]?)(から| 済| 未| 未記録)/g, (m, id, tail) => {
    const label = EVENT_LABELS[id];
    if (!label) return m;
    if (tail === "から") return label + "から";
    return label + (tail === " 済" ? "：済" : tail === " 未" ? "：未" : "：未記録");
  });
  return s
    .replace("予報 precipSum=", "予報降水量 ")
    .replace("予報 tempMin=", "予報最低気温 ")
    .replace("予報 tempMax=", "予報最高気温 ");
}

/** 栽培の開始日（土づくりの記録は除く） */
function startDateOf(planting) {
  const ev = planting.events || {};
  const dates = Object.keys(ev).filter((k) => !k.startsWith("prep") && ev[k]).map((k) => ev[k]).sort();
  return dates.length ? dates[0] : null;
}

/** 一覧の並び替え用の日付（予定の作付けは予定日） */
function sortDateOf(planting) {
  return startDateOf(planting) || planting.plannedDate || "9999";
}

function isPlanned(planting) {
  return planting.status === "planned";
}

// ---------- Firebase 初期化 ----------
if (String(firebaseConfig.apiKey).startsWith("YOUR_")) {
  document.body.innerHTML =
    '<div class="login"><h1>畑ノート</h1><p>firebase-config.js に Firebase の設定を貼り付けてください。</p></div>';
  throw new Error("firebase-config.js が未設定です");
}

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const userRef = () => doc(db, "users", state.user.uid);
const subCol = (name) => collection(db, "users", state.user.uid, name);
const subDoc = (name, id) => doc(db, "users", state.user.uid, name, id);

// ---------- 認証 ----------
$("#btnLogin").addEventListener("click", async () => {
  $("#loginErr").textContent = "";
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      $("#loginErr").textContent = "ログインに失敗しました：" + err.code;
    }
  }
});

getRedirectResult(auth).catch((err) => {
  $("#loginErr").textContent = "ログインに失敗しました：" + err.code;
});

$("#btnLogout").addEventListener("click", () => {
  if (confirm("ログアウトしますか？")) signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  state.user = user;
  if (!user) {
    $("#app").hidden = true;
    $("#login").hidden = false;
    return;
  }
  $("#login").hidden = true;
  $("#app").hidden = false;
  await loadMaster();
  await ensureUserDoc(user);
  subscribe();
});

async function ensureUserDoc(user) {
  try {
    const snap = await getDoc(userRef());
    if (!snap.exists()) {
      await setDoc(userRef(), {
        displayName: user.displayName || "",
        region: "mid",
        fertDisplay: "amount",
        fertType: "chemical",
        plan: "trial",
        trialStartedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      });
    }
  } catch (err) {
    // オフラインで初回ログインした場合など。次回オンライン時に作成される
    console.warn("ユーザー情報の確認をスキップ:", err.code || err.message);
  }
}

async function loadMaster() {
  if (state.master) return;
  const res = await fetch("crops.json", { cache: "no-cache" }).catch(() => null);
  if (res && res.ok) {
    state.master = await res.json();
    lsSet("master", state.master);
  } else {
    state.master = lsGet("master", null);
  }
  if (!state.master) {
    toast("作物データを読み込めませんでした");
    state.master = { crops: [] };
  }
}

function subscribe() {
  state.unsubs.push(onSnapshot(userRef(), (snap) => {
    state.userDoc = snap.exists() ? snap.data() : null;
    renderSettings();
    renderToday();
    if (openDetailId) renderDetail(openDetailId);
  }));
  state.unsubs.push(onSnapshot(subCol("fields"), (qs) => {
    state.fields = qs.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
    renderFields();
    refreshWeather();
  }));
  state.unsubs.push(onSnapshot(subCol("plantings"), (qs) => {
    state.plantings = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPlantings();
    renderRecords();
    renderToday();
    if (pendingOpenId && state.plantings.some((p) => p.id === pendingOpenId)) {
      const id = pendingOpenId;
      pendingOpenId = null;
      openDetail(id);
    } else if (openDetailId) {
      renderDetail(openDetailId);
    }
  }));
}

// ---------- 天気（Open-Meteo 無料枠：検証用・非商用） ----------
async function refreshWeather() {
  for (const f of state.fields) {
    const key = "wx:" + f.id;
    const cached = lsGet(key, null);
    const fresh = cached && cached.lat === f.lat && cached.lng === f.lng
      && (Date.now() - cached.fetchedAt) < WX_TTL_MS;
    if (cached) state.weather[f.id] = { ...cached, stale: !fresh };
    if (fresh || !navigator.onLine) continue;
    try {
      const url = "https://api.open-meteo.com/v1/forecast"
        + "?latitude=" + encodeURIComponent(f.lat)
        + "&longitude=" + encodeURIComponent(f.lng)
        + "&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum"
        + "&timezone=Asia%2FTokyo&past_days=92&forecast_days=7";
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const entry = { lat: f.lat, lng: f.lng, fetchedAt: Date.now(), daily: json.daily };
      lsSet(key, entry);
      state.weather[f.id] = { ...entry, stale: false };
    } catch (err) {
      console.warn("天気の取得に失敗:", f.name, err.message);
    }
  }
  renderToday();
}

/** 判定エンジンに渡す気象データ。今日より前＝観測扱い、今日以降＝予報扱い */
function buildCtx(fieldId, today) {
  const ctx = { today, dailyMeanTemps: {}, observedPrecip: {}, forecast: [] };
  const wx = state.weather[fieldId];
  if (!wx || !wx.daily) return ctx;
  const d = wx.daily;
  d.time.forEach((date, i) => {
    if (date < today) {
      if (typeof d.temperature_2m_mean[i] === "number") ctx.dailyMeanTemps[date] = d.temperature_2m_mean[i];
      if (typeof d.precipitation_sum[i] === "number") ctx.observedPrecip[date] = d.precipitation_sum[i];
    } else {
      ctx.forecast.push({
        date,
        tempMin: d.temperature_2m_min[i],
        tempMax: d.temperature_2m_max[i],
        precip: d.precipitation_sum[i]
      });
    }
  });
  return ctx;
}

// ---------- 画面：今日 ----------
function dismissedSet(today) {
  return new Set(lsGet("dismiss:" + today, []));
}

function renderToday() {
  if (!state.master || !state.user) return;
  const today = todayJST();
  $("#hdrSub").textContent = today.replace(/-/g, "/");
  const dismissed = dismissedSet(today);
  const current = state.plantings.filter((p) => p.status === "active" || isPlanned(p));

  const items = [];
  current.forEach((p) => {
    const crop = cropById(p.cropId);
    if (!crop) return;
    // 土づくり（予定日から逆算）と、予定日を迎えたときの記録の案内
    Engine.evaluatePrep(crop, p, { today }, fertType(p)).forEach((t) => {
      if (dismissed.has(p.id + ":" + t.ruleId)) return;
      items.push({ ...t, planting: p, crop, stageLabel: "土づくり", resolvedBy: t.event });
    });
    if (isPlanned(p)) return;
    const res = Engine.evaluatePlanting(crop, p, buildCtx(p.fieldId, today));
    res.tasks.forEach((t) => {
      if (dismissed.has(p.id + ":" + t.ruleId)) return;
      const rule = crop.rules.find((r) => r.id === t.ruleId);
      items.push({ ...t, kind: "rule", planting: p, crop, stageLabel: stageName(crop, res.stage), resolvedBy: rule ? rule.resolvedBy : null });
    });
  });
  items.sort((a, b) => (a.priority - b.priority) || ((b.overdue ? 1 : 0) - (a.overdue ? 1 : 0)));

  const box = $("#todayTasks");
  if (current.length === 0) {
    box.innerHTML = '<div class="card empty">まだ作付けがありません。<br>「作付け」タブから登録しましょう。</div>';
  } else if (items.length === 0) {
    box.innerHTML = '<div class="card empty">今日やることはありません。</div>';
  } else {
    box.innerHTML = items.map((t, i) => {
      const f = fieldById(t.planting.fieldId);
      const badges = (t.overdue ? '<span class="badge late">遅れ気味</span>' : "")
        + (t.confidence === "draft" ? '<span class="badge draft">目安・検証中</span>' : "");
      let title = t.title, msg = t.message, extra = "", why = "";
      const anchorLabel = t.anchor ? (EVENT_LABELS[t.anchor.event] || t.anchor.event) : "";
      if (t.kind === "start") {
        title = anchorLabel + (t.daysLeft < 0 ? "の予定日を過ぎています" : "の予定日です");
        msg = "済んだら記録しましょう。ここから追肥や間引きなどの案内が始まります。予定を変える場合は、作付けの詳細から予定日を変更できます。";
        why = anchorLabel + "予定日：" + md(t.anchor.date);
      } else if (t.kind === "prep") {
        extra = amountBlock(t.amounts, t.planting);
        why = anchorLabel + (t.anchor.estimated ? "予定日（見積もり）：" : "予定日：") + md(t.anchor.date)
          + (t.daysLeft > 0 ? "（あと" + t.daysLeft + "日）" : "") + " / この作業の目安：" + md(t.dueDate) + "ごろ";
      } else {
        const fert = t.fertilizer;
        const ft = fertType(t.planting);
        if (fert) extra = amountBlock(fert[ft], t.planting, ft === "organic" ? fert.organicNote : "");
        why = t.reasons.map((r) => prettyReason(r, t.crop)).join(" / ");
      }
      const btnLabel = t.kind === "start" ? "記録する（今日）" : "やった（今日）";
      const btn = t.resolvedBy
        ? '<button class="primary" data-act="done" data-i="' + i + '">' + btnLabel + "</button>"
          + '<button class="ghost" data-act="pick" data-i="' + i + '">日付を選んで記録</button>'
        : '<button data-act="dismiss" data-i="' + i + '">確認した</button>';
      return '<div class="card task p' + t.priority + '"><div class="bar"></div><div>'
        + '<div class="meta">' + esc(f ? f.name : "畑未設定") + " · " + esc(t.crop.name)
        + (t.planting.memo ? "（" + esc(t.planting.memo) + "）" : "")
        + " · " + esc(t.stageLabel) + badges + "</div>"
        + '<div class="title">' + esc(title) + "</div>"
        + '<p class="msg">' + esc(msg) + "</p>"
        + extra
        + '<p class="why">判定の根拠：' + esc(why) + "</p>"
        + '<div class="row">' + btn + "</div>"
        + "</div></div>";
    }).join("");
    box.querySelectorAll("button[data-act]").forEach((b) => {
      b.addEventListener("click", () => {
        const t = items[Number(b.dataset.i)];
        if (b.dataset.act === "done") {
          recordEvent(t.planting, t.resolvedBy, today);
        } else if (b.dataset.act === "pick") {
          openDetail(t.planting.id);
        } else {
          const set = dismissedSet(today);
          set.add(t.planting.id + ":" + t.ruleId);
          lsSet("dismiss:" + today, Array.from(set));
          renderToday();
        }
      });
    });
  }

  renderWeather(today);
  renderSowable(today);
}

function renderWeather(today) {
  const box = $("#todayWeather");
  if (state.fields.length === 0) {
    box.innerHTML = '<div class="card empty">畑を登録すると、その場所の天気を表示します。</div>';
    return;
  }
  box.innerHTML = state.fields.map((f) => {
    const wx = state.weather[f.id];
    if (!wx || !wx.daily) {
      return '<div class="card"><b>' + esc(f.name) + '</b><p class="small muted" style="margin:6px 0 0">天気を取得できていません'
        + (navigator.onLine ? "（取得中）" : "（オフライン）") + "</p></div>";
    }
    const ctx = buildCtx(f.id, today);
    const days = ctx.forecast.slice(0, 7);
    const updated = new Date(wx.fetchedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return '<div class="card"><div class="spread"><b>' + esc(f.name) + '</b><span class="small muted">'
      + (wx.stale ? "前回取得 " : "更新 ") + esc(updated) + "</span></div>"
      + '<div class="wx" style="margin-top:8px">' + days.map((d) =>
        "<div>" + esc(md(d.date)) + "<b>" + Math.round(d.tempMax) + "°</b>"
        + '<span class="muted">' + Math.round(d.tempMin) + "°</span><br>"
        + '<span class="rain">' + (d.precip >= 0.5 ? (Math.round(d.precip * 10) / 10) + "mm" : "–") + "</span></div>"
      ).join("") + "</div></div>";
  }).join("");
}

function renderSowable(today) {
  const region = (state.userDoc && state.userDoc.region) || "mid";
  const experienced = Array.from(new Set(state.plantings.map((p) => p.cropId)));
  const list = Engine.sowableNow(state.master, region, today, experienced);
  const box = $("#todaySow");
  if (list.length === 0) {
    box.innerHTML = '<div class="card empty small">今が種まき・植え付けの適期の作物はありません。</div>';
    return;
  }
  box.innerHTML = list.map((c) =>
    '<div class="card spread"><div><b>' + esc(c.name) + "</b>"
    + (c.isNew ? '<span class="badge new">未挑戦</span>' : "")
    + '<div class="small muted">' + esc(c.methods.map((m) => m.label).join("・")) + " · 難易度 "
    + "★".repeat(c.difficulty) + "☆".repeat(Math.max(0, 5 - c.difficulty)) + "</div></div>"
    + '<button data-crop="' + esc(c.cropId) + '" data-method="' + esc(c.methods[0].key) + '">始める</button></div>'
  ).join("");
  box.querySelectorAll("button[data-crop]").forEach((b) => {
    b.addEventListener("click", () => openAddPlanting(b.dataset.crop, b.dataset.method));
  });
}

// ---------- 時期外れの注意 ----------
const REGION_LABELS = { cold: "寒地・寒冷地", mid: "中間地", warm: "暖地" };

function userRegion() {
  return (state.userDoc && state.userDoc.region) || "mid";
}

function fmtWindows(wins) {
  return wins.map((w) => md("2000-" + w.from) + "〜" + md("2000-" + w.to)).join("、");
}

/** 開始日が適期外なら注意を返す（適期内・暦データなしなら空） */
function seasonNoteHtml(crop, methodKey, dateStr, opts) {
  if (!crop || !dateStr) return "";
  const region = userRegion();
  const r = Engine.seasonCheck(crop, methodKey, region, dateStr);
  if (!r) return "";
  const evLabel = EVENT_LABELS[r.event] || r.event;
  if (r.ok) {
    return opts && opts.showOk
      ? '<div class="season ok">' + esc(REGION_LABELS[region]) + "の" + esc(evLabel) + "の適期（" + esc(fmtWindows(r.windows)) + "）に入っています。</div>"
      : "";
  }
  const when = r.position === "early" ? "適期より約" + r.days + "日早い時期です" : "適期を約" + r.days + "日過ぎています";
  const risk = crop.offSeason ? crop.offSeason[r.position] : "";
  return '<div class="season"><b>' + esc(crop.name) + "の" + esc(evLabel) + "の時期ではありません（" + esc(when) + "）</b>"
    + esc(REGION_LABELS[region]) + "の" + esc(evLabel) + "の適期：" + esc(fmtWindows(r.windows)) + "<br>"
    + (risk ? esc(risk) + "<br>" : "")
    + "このまま登録することもできます。育てる場合は、保温・遮光・防虫などの対策を検討してください。"
    + '<div class="small" style="margin-top:4px;opacity:.85">地域区分は「畑・設定」で変更できます（目安・検証中）。</div></div>';
}

function syncSeasonNote() {
  const crop = cropById($("#pCrop").value);
  $("#pSeasonNote").innerHTML = crop ? seasonNoteHtml(crop, $("#pMethod").value, $("#pStartDate").value) : "";
}

// ---------- 栽培の結果 ----------
const RATINGS = {
  great: { label: "豊作", cls: "great" },
  normal: { label: "普通", cls: "normal" },
  poor: { label: "不作", cls: "poor" },
  failed: { label: "失敗", cls: "failed" }
};
const CAUSES = [
  ["weather", "天候（長雨・猛暑・寒さ）"], ["disease", "病気"], ["pest", "害虫・鳥獣"],
  ["germination", "発芽・根付きが悪い"], ["timing", "時期が合わなかった"], ["fertilizer", "肥料（多すぎ・少なすぎ）"],
  ["water", "水やり（乾燥・過湿）"], ["soil", "土・水はけ"], ["care", "手入れが遅れた"], ["other", "その他"]
];
const SUCCESS = ["great", "normal"];

function ratingBadge(rating) {
  const r = RATINGS[rating];
  return r ? '<span class="rt ' + r.cls + '">' + r.label + "</span>" : "";
}

function fmtYield(res) {
  if (!res || !(res.yieldValue > 0)) return "";
  return res.yieldUnit === "count" ? res.yieldValue + "本・個" : res.yieldValue + "kg";
}

let finishTargetId = null;

function openFinish(id) {
  const p = state.plantings.find((x) => x.id === id);
  if (!p) return;
  finishTargetId = id;
  const crop = cropById(p.cropId);
  const res = p.result || {};
  $("#fTitle").textContent = (p.status === "done" ? "結果を編集：" : "栽培を終了：") + (crop ? crop.name : "");
  $("#fSub").textContent = (p.memo ? p.memo + " · " : "") + (startDateOf(p) ? md(startDateOf(p)) + "〜" : "");
  document.querySelectorAll('#fRatings input[name="rating"]').forEach((r) => { r.checked = r.value === res.rating; });
  $("#fYield").value = res.yieldValue > 0 ? res.yieldValue : "";
  $("#fYieldUnit").value = res.yieldUnit === "count" ? "count" : "kg";
  $("#fCauses").innerHTML = CAUSES.map(([k, l]) =>
    '<label><input type="checkbox" value="' + k + '"' + ((res.causes || []).includes(k) ? " checked" : "") + "> " + esc(l) + "</label>").join("");
  $("#fNote").value = res.note || "";
  $("#btnFinishSave").textContent = p.status === "done" ? "保存する" : "終了して記録する";
  syncCauseBox();
  $("#dlgFinish").showModal();
}

function syncCauseBox() {
  const sel = document.querySelector('#fRatings input[name="rating"]:checked');
  // 豊作・普通でも振り返りに使えるよう、原因欄は不作・失敗のときに目立たせるだけで常に入力可
  $("#fCauseBox").style.opacity = sel && SUCCESS.includes(sel.value) ? ".55" : "1";
}

$("#fRatings").addEventListener("change", syncCauseBox);
$("#btnFinishCancel").addEventListener("click", () => $("#dlgFinish").close("cancel"));

$("#dlgFinish").addEventListener("close", () => {
  if ($("#dlgFinish").returnValue !== "ok") return;
  const p = state.plantings.find((x) => x.id === finishTargetId);
  const sel = document.querySelector('#fRatings input[name="rating"]:checked');
  if (!p || !sel) return;
  const y = Number($("#fYield").value);
  const result = {
    rating: sel.value,
    yieldValue: y > 0 ? y : null,
    yieldUnit: $("#fYieldUnit").value === "count" ? "count" : "kg",
    causes: Array.from(document.querySelectorAll("#fCauses input:checked")).map((c) => c.value),
    note: $("#fNote").value.trim(),
    region: userRegion(),           // 統計用：記録した時点の地域区分
    recordedAt: todayJST()
  };
  const data = { result, updatedAt: serverTimestamp() };
  if (p.status !== "done") Object.assign(data, { status: "done", finishedAt: todayJST() });
  fire(updateDoc(subDoc("plantings", p.id), data), p.status === "done" ? "結果を保存しました" : "栽培を終了しました");
  if ($("#dlgDetail").open) $("#dlgDetail").close();
});

function resultHtml(p) {
  if (p.status !== "done") return "";
  const res = p.result;
  if (!res) {
    return '<div class="card small" style="margin:0 0 8px">結果がまだ記録されていません。'
      + '<button class="ghost" data-finish="' + esc(p.id) + '" style="margin-left:6px">結果を記録</button></div>';
  }
  const causes = (res.causes || []).map((k) => (CAUSES.find((c) => c[0] === k) || [k, k])[1]);
  return '<div class="card small" style="margin:0 0 8px"><div class="spread"><span>結果 ' + ratingBadge(res.rating)
    + (fmtYield(res) ? "　収穫量 " + esc(fmtYield(res)) : "") + "</span>"
    + '<button class="ghost" data-finish="' + esc(p.id) + '">編集</button></div>'
    + (causes.length ? '<div class="muted">原因：' + esc(causes.join("、")) + "</div>" : "")
    + (res.note ? "<div>" + esc(res.note) + "</div>" : "") + "</div>";
}

// ---------- 画面：実績 ----------
function renderRecords() {
  if (!state.master) return;
  // 予定のままのもの・取りやめたものは実績に含めない
  const list = state.plantings.filter((p) => p.status === "active" || p.status === "done")
    .map((p) => ({ p, start: startDateOf(p) || "" }))
    .sort((a, b) => a.start.localeCompare(b.start));

  // 作物ごとの通し番号（何回目）
  const nth = {};
  list.forEach((x) => { nth[x.p.cropId] = (nth[x.p.cropId] || 0) + 1; x.n = nth[x.p.cropId]; });

  const byCrop = {};
  list.forEach(({ p }) => {
    const s = byCrop[p.cropId] || (byCrop[p.cropId] = { total: 0, active: 0, great: 0, normal: 0, poor: 0, failed: 0, kg: 0 });
    s.total++;
    if (p.status === "active") s.active++;
    const r = p.result;
    if (p.status === "done" && r && RATINGS[r.rating]) s[r.rating]++;
    if (r && r.yieldUnit !== "count" && r.yieldValue > 0) s.kg += r.yieldValue;
  });

  const crops = Object.keys(byCrop).sort((a, b) => byCrop[b].total - byCrop[a].total);
  if (crops.length === 0) {
    $("#recordSummary").innerHTML = '<div class="card empty">まだ実績がありません。種まき・植え付けを記録するとここに集計されます。</div>';
    $("#recordList").innerHTML = "";
    return;
  }
  $("#recordSummary").innerHTML = '<div class="card table-wrap"><table class="stats"><tr><th>作物</th><th>回数</th><th>豊作</th><th>普通</th><th>不作</th><th>失敗</th><th>成功率</th><th>収穫量</th></tr>'
    + crops.map((id) => {
      const s = byCrop[id];
      const crop = cropById(id);
      const rated = s.great + s.normal + s.poor + s.failed;
      const rate = rated ? Math.round((s.great + s.normal) / rated * 100) + "%" : "—";
      return "<tr><td>" + esc(crop ? crop.name : id) + "</td><td>" + s.total + (s.active ? '<div class="muted" style="font-size:11px">栽培中' + s.active + "</div>" : "") + "</td>"
        + "<td>" + s.great + "</td><td>" + s.normal + "</td><td>" + s.poor + "</td><td>" + s.failed + "</td>"
        + "<td><b>" + rate + "</b></td><td>" + (s.kg ? Math.round(s.kg * 10) / 10 + "kg" : "—") + "</td></tr>";
    }).join("") + "</table></div>";

  $("#recordList").innerHTML = list.slice().reverse().map(({ p, start, n }) => {
    const crop = cropById(p.cropId);
    const end = p.finishedAt ? md(p.finishedAt) : "";
    const res = p.result;
    const badge = p.status === "active" ? '<span class="rt growing">栽培中</span>' : (res ? ratingBadge(res.rating) : '<span class="rt growing">結果未記録</span>');
    const causes = res && res.causes && res.causes.length
      ? (res.causes.map((k) => (CAUSES.find((c) => c[0] === k) || [k, k])[1]).join("、")) : "";
    return '<div class="card rec" data-open="' + esc(p.id) + '" style="cursor:pointer">'
      + "<div><b>" + esc(crop ? crop.name : p.cropId) + " " + n + "回目</b>"
      + (p.memo ? ' <span class="small muted">' + esc(p.memo) + "</span>" : "") + "</div>"
      + "<div>" + badge + "</div>"
      + '<div class="small muted">' + esc(start ? start.slice(0, 4) + "/" + md(start) : "") + (end ? "〜" + esc(end) : "〜")
      + " · " + esc(methodOf(crop, p).label) + (res && fmtYield(res) ? " · " + esc(fmtYield(res)) : "") + "</div><div></div>"
      + (causes ? '<div class="small" style="grid-column:1/-1">原因：' + esc(causes) + "</div>" : "")
      + (res && res.note ? '<div class="small muted" style="grid-column:1/-1">' + esc(res.note) + "</div>" : "")
      + "</div>";
  }).join("");
  $("#recordList").querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.open));
  });
}

// ---------- 画面：作付け ----------
function plantingCard(p, today) {
  const crop = cropById(p.cropId);
  if (!crop) return "";
  const f = fieldById(p.fieldId);
  let sub, right;
  if (isPlanned(p)) {
    const ev = p.plannedEvent || firstEventOf(crop, p.startMethod);
    const left = Engine._util.daysBetween(today, p.plannedDate);
    sub = "土づくり・準備中";
    right = esc((EVENT_LABELS[ev] || ev) + "予定") + "<br>" + esc(md(p.plannedDate))
      + (left > 0 ? "（あと" + left + "日）" : "");
  } else {
    const start = startDateOf(p);
    const days = start ? Engine._util.daysBetween(start, today) : null;
    sub = stageName(crop, Engine.currentStage(crop, p));
    right = start ? esc(md(start)) + "〜<br>" + days + "日目" : "";
  }
  return '<div class="card spread" data-open="' + esc(p.id) + '" style="cursor:pointer"><div>'
    + "<b>" + esc(crop.name) + "</b>"
    + (p.memo ? ' <span class="small muted">' + esc(p.memo) + "</span>" : "")
    + (isPlanned(p) ? '<span class="badge new">予定</span>' : "")
    + '<div class="small muted">' + esc(f ? f.name : "畑未設定") + " · " + esc(methodOf(crop, p).label)
    + " · " + esc(sub) + "</div></div>"
    + '<div class="small muted" style="text-align:right">' + right + "</div></div>";
}

function renderPlantings() {
  const box = $("#plantingList");
  if (!state.master) return;
  const today = todayJST();
  const current = state.plantings.filter((p) => p.status === "active" || isPlanned(p))
    .sort((a, b) => String(sortDateOf(a)).localeCompare(String(sortDateOf(b))));
  const done = state.plantings.filter((p) => p.status === "done");

  let html = "";
  if (current.length === 0) {
    html += '<div class="card empty">作付けはまだありません。</div>';
  }
  html += current.map((p) => plantingCard(p, today)).join("");

  if (done.length) {
    html += "<h2>終了した作付け</h2>" + done.map((p) => {
      const crop = cropById(p.cropId);
      return '<div class="card spread small" data-open="' + esc(p.id) + '" style="cursor:pointer"><span>'
        + esc(crop ? crop.name : p.cropId) + (p.memo ? "（" + esc(p.memo) + "）" : "")
        + '</span><span class="muted">' + (p.result ? ratingBadge(p.result.rating) + " " : "") + esc(p.finishedAt ? md(p.finishedAt) + " 終了" : "") + "</span></div>";
    }).join("");
  }
  box.innerHTML = html;
  box.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.open));
  });
}

function openAddPlanting(cropId, methodKey) {
  if (state.fields.length === 0) {
    toast("先に畑を登録してください");
    switchView("fields");
    return;
  }
  $("#pField").innerHTML = state.fields.map((f) => '<option value="' + esc(f.id) + '">' + esc(f.name) + "</option>").join("");
  $("#pCrop").innerHTML = state.master.crops.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>").join("");
  if (cropId) $("#pCrop").value = cropId;
  $("#pStatus").value = "planned";
  $("#pStartDate").value = "";
  $("#pMemo").value = "";
  $("#pLen").value = "";
  $("#pWid").value = "";
  // 肥料の設定は前回登録したときの選択を初期値にする
  const last = lsGet("lastFert", {});
  $("#pFertDisplay").value = last.fertDisplay === "timing" ? "timing" : "amount";
  $("#pFertType").value = last.fertType === "organic" ? "organic" : "chemical";
  showAddStep(1);
  syncMethodOptions();
  if (methodKey && $("#pMethod").querySelector('option[value="' + methodKey + '"]')) {
    $("#pMethod").value = methodKey;
    syncStartLabel();
  }
  $("#dlgPlanting").showModal();
}

function showAddStep(n) {
  $("#pStep1").hidden = n !== 1;
  $("#pStep2").hidden = n !== 2;
  $("#dlgPlanting").scrollTop = 0;
}

function syncMethodOptions() {
  const crop = cropById($("#pCrop").value);
  if (!crop) return;
  $("#pMethod").innerHTML = Object.entries(crop.startMethods).map(([k, m]) =>
    '<option value="' + esc(k) + '">' + esc(m.label) + "</option>").join("");
  $("#pMethod").value = crop.defaultStartMethod;
  syncStartLabel();
}

function syncStartLabel() {
  const crop = cropById($("#pCrop").value);
  if (!crop) return;
  const ev = firstEventOf(crop, $("#pMethod").value);
  const planned = $("#pStatus").value === "planned";
  const today = todayJST();
  $("#pStartLabel").textContent = (EVENT_LABELS[ev] || ev) + (planned ? "の予定日" : "の日");
  const inp = $("#pStartDate");
  if (planned) {
    inp.min = today;
    inp.removeAttribute("max");
    if (!inp.value || inp.value < today) inp.value = Engine._util.addDays(today, 14);
  } else {
    inp.max = today;
    inp.removeAttribute("min");
    if (!inp.value || inp.value > today) inp.value = today;
  }
  $("#pPlanHint").hidden = !planned;
  const m = crop.startMethods[$("#pMethod").value];
  const note = $("#pMethodNote");
  note.textContent = (m && m.warning) || "";
  note.hidden = !(m && m.warning);
  syncSeasonNote();
}

function readBed(lenSel, widSel) {
  const l = Number($(lenSel).value), w = Number($(widSel).value);
  return { bedLength: l > 0 ? l : null, bedWidth: w > 0 ? w : null };
}

/** 追加ダイアログの入力内容から、登録する作付けのデータを組み立てる（保存前の確認にも使う） */
function draftFromForm() {
  const crop = cropById($("#pCrop").value);
  if (!crop) return null;
  const method = $("#pMethod").value;
  const ev = firstEventOf(crop, method);
  const date = $("#pStartDate").value;
  const planned = $("#pStatus").value === "planned" && date >= todayJST();
  const data = {
    fieldId: $("#pField").value,
    cropId: crop.id,
    startMethod: method,
    memo: $("#pMemo").value.trim(),
    fertDisplay: $("#pFertDisplay").value === "timing" ? "timing" : "amount",
    fertType: $("#pFertType").value === "organic" ? "organic" : "chemical",
    ...readBed("#pLen", "#pWid")
  };
  if (planned) Object.assign(data, { status: "planned", plannedEvent: ev, plannedDate: date, events: {} });
  else Object.assign(data, { status: "active", events: { [ev]: date } });
  return { crop, ev, date, planned, data };
}

/** 追肥の予定（いつ・何を・どれだけ）を一覧にする */
function topdressHtml(crop, p) {
  const method = methodOf(crop, p);
  const ft = fertType(p);
  const rules = crop.rules.filter((r) => r.fertilizer && r.action !== "notice" && ruleApplies(crop, method, r));
  if (rules.length === 0) return "";
  const when = (r) => (r.trigger.all || []).map((c) => {
    if (c.type === "daysSince" && c.gte !== undefined) return (EVENT_LABELS[c.event] || c.event) + "から約" + c.gte + "日後";
    if (c.type === "calendar") return md("2000-" + c.from) + "〜" + md("2000-" + c.to);
    return "";
  }).filter(Boolean).join("、");
  return '<div class="prep"><div class="spread"><b>追肥の予定</b><span class="badge draft">目安・検証中</span></div>'
    + '<div class="topdress">' + rules.map((r) =>
      '<div class="item"><div><b>' + esc(r.title) + "</b>"
      + (when(r) ? ' <span class="small muted">' + esc(when(r)) + "</span>" : "") + "</div>"
      + amountBlock(r.fertilizer[ft], p, ft === "organic" ? r.fertilizer.organicNote : "") + "</div>"
    ).join("") + "</div>"
    + '<div class="small muted">実際の時期は、生育の記録と天気から「今日やること」でお知らせします。</div></div>';
}

function goConfirm() {
  if (!$("#formPlanting").reportValidity()) return;
  const d = draftFromForm();
  if (!d) return;
  const { crop, ev, date, planned, data } = d;
  const f = fieldById(data.fieldId);
  const area = bedArea(data);
  const rows = [
    ["畑", f ? f.name : "—"],
    ["作物", crop.name + (data.memo ? "（" + data.memo + "）" : "")],
    ["始め方", methodOf(crop, data).label],
    [(EVENT_LABELS[ev] || ev) + (planned ? "の予定日" : "の日"), date.replace(/-/g, "/")],
    ["畝の大きさ", area ? data.bedLength + "m × " + data.bedWidth + "m（" + fmtArea(area) + "㎡）" : "未入力（1㎡あたりの量で表示）"],
    ["肥料", (data.fertType === "organic" ? "有機肥料" : "化成肥料") + "・" + (data.fertDisplay === "timing" ? "タイミングだけ表示" : "量まで表示")]
  ];
  $("#pSummary").innerHTML = '<table class="summary">'
    + rows.map(([k, v]) => "<tr><th>" + esc(k) + "</th><td>" + esc(v) + "</td></tr>").join("") + "</table>";
  $("#pSeasonConfirm").innerHTML = seasonNoteHtml(crop, data.startMethod, date, { showOk: true });

  const prep = prepHtml(crop, data);
  const noPrep = '<div class="prep small muted">' + (planned
    ? "この作物の土づくりのデータはまだありません。"
    : "すでに" + esc(EVENT_LABELS[ev] || ev) + "済みのため、土づくりの案内はありません。") + "</div>";
  $("#pPreview").innerHTML = (prep || noPrep) + topdressHtml(crop, data);
  showAddStep(2);
}

$("#pCrop").addEventListener("change", syncMethodOptions);
$("#pMethod").addEventListener("change", syncStartLabel);
$("#pStatus").addEventListener("change", syncStartLabel);
$("#pStartDate").addEventListener("change", syncSeasonNote);
$("#btnAddPlanting").addEventListener("click", () => openAddPlanting(null));
$("#btnPConfirm").addEventListener("click", goConfirm);
$("#btnPBack").addEventListener("click", () => showAddStep(1));
$("#btnPCancel").addEventListener("click", () => $("#dlgPlanting").close("cancel"));

// 入力中の Enter キーで確認を飛ばして登録しないようにする
$("#formPlanting").addEventListener("submit", (e) => {
  const submitter = e.submitter;
  if (submitter && submitter.value === "cancel") return;
  if (!$("#pStep2").hidden) return;
  e.preventDefault();
  goConfirm();
});

let pendingOpenId = null;

$("#dlgPlanting").addEventListener("close", () => {
  if ($("#dlgPlanting").returnValue !== "ok") return;
  const d = draftFromForm();
  if (!d || !d.date) return;
  const { crop, ev, date, planned, data } = d;
  lsSet("lastFert", { fertDisplay: data.fertDisplay, fertType: data.fertType });
  const ref = doc(subCol("plantings"));
  // 内容は登録前の確認画面で見ているので、登録後は一覧に戻る（予定表は作付けの詳細でいつでも見られる）
  fire(setDoc(ref, { ...data, createdAt: serverTimestamp() }), crop.name + (planned ? "の予定を登録しました" : "を追加しました"));
  if (!planned) fire(addDoc(subCol("logs"), { plantingId: ref.id, event: ev, date, createdAt: serverTimestamp() }));
});

// ---------- 作付けの詳細・作業記録 ----------
let openDetailId = null;

function openDetail(id) {
  openDetailId = id;
  renderDetail(id);
  if (!$("#dlgDetail").open) $("#dlgDetail").showModal();
}

/** 土づくりの予定表（工程・目安日・量・ポイント） */
function prepHtml(crop, p) {
  const ft = fertType(p);
  const sched = Engine.prepSchedule(crop, p, ft);
  if (!sched) return "";
  const sp = crop.soilPrep;
  const anchorLabel = EVENT_LABELS[sched.anchor.event] || sched.anchor.event;
  let html = '<div class="prep"><div class="spread"><b>土づくりの予定</b><span class="badge draft">目安・検証中</span></div>'
    + '<div class="small muted">' + esc(anchorLabel) + (sched.anchor.estimated ? "予定日（見積もり）" : "予定日") + "："
    + esc(md(sched.anchor.date)) + " · 肥料：" + (ft === "organic" ? "有機" : "化成") + " · 目標の酸度 pH " + esc(sp.targetPH) + "</div>";
  html += sched.steps.map((st) =>
    '<div class="prep-step' + (st.doneDate ? " done" : "") + '">'
    + '<div class="spread"><span><b>' + esc(md(st.dueDate)) + "ごろ</b>　" + esc(st.title) + "</span>"
    + '<span class="small ' + (st.doneDate ? "ok" : "muted") + '">' + (st.doneDate ? "済 " + esc(md(st.doneDate)) : "") + "</span></div>"
    + '<div class="small">' + esc(st.message) + "</div>"
    + amountBlock(st.amounts, p) + "</div>"
  ).join("");
  html += '<div class="small"><b>' + esc(crop.name) + "の土づくりのポイント</b><ul>"
    + sp.tips.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul></div>";
  const note = state.master.fertilizerNotes && state.master.fertilizerNotes[ft];
  if (note && showAmounts(p)) html += '<div class="small muted">' + esc(note) + "</div>";
  return html + "</div>";
}

function renderDetail(id) {
  const p = state.plantings.find((x) => x.id === id);
  if (!p) { $("#dlgDetail").close(); return; }
  const crop = cropById(p.cropId);
  const f = fieldById(p.fieldId);
  const today = todayJST();
  $("#dDetailTitle").textContent = crop.name + (p.memo ? "（" + p.memo + "）" : "");
  $("#dDetailSub").textContent = (f ? f.name : "畑未設定") + " · " + methodOf(crop, p).label
    + " · " + (isPlanned(p) ? "土づくり・準備中" : "現在：" + stageName(crop, Engine.currentStage(crop, p)));

  // 予定日（予定の作付けのみ変更可）と畝の大きさ
  const plan = $("#dPlan");
  if (isPlanned(p)) {
    plan.hidden = false;
    $("#dPlanLabel").textContent = (EVENT_LABELS[p.plannedEvent] || p.plannedEvent) + "の予定日";
    $("#dPlanDate").value = p.plannedDate || "";
    $("#dPlanDate").min = today;
  } else {
    plan.hidden = true;
  }
  $("#dLen").value = p.bedLength || "";
  $("#dWid").value = p.bedWidth || "";
  const area = bedArea(p);
  $("#dArea").textContent = area ? "面積 " + fmtArea(area) + "㎡" : "未登録";

  $("#dFertDisplay").value = showAmounts(p) ? "amount" : "timing";
  $("#dFertType").value = fertType(p);
  $("#dPrep").innerHTML = prepHtml(crop, p);
  $("#dResult").innerHTML = resultHtml(p);
  $("#dResult").querySelectorAll("[data-finish]").forEach((b) => b.addEventListener("click", () => openFinish(b.dataset.finish)));

  const events = p.events || {};
  $("#dEvents").innerHTML = eventsForPlanting(crop, p).map((ev) => {
    const val = events[ev] || "";
    return "<tr><td>" + esc(EVENT_LABELS[ev] || ev) + "</td><td>"
      + '<input type="date" data-ev="' + esc(ev) + '" value="' + esc(val) + '" max="' + esc(today) + '" style="width:auto;min-height:36px;padding:4px 8px">'
      + (val ? ' <button class="ghost small" data-clear="' + esc(ev) + '" style="min-height:36px;padding:4px 10px">取消</button>' : "")
      + "</td></tr>";
  }).join("");
  $("#dEvents").querySelectorAll("input[data-ev]").forEach((inp) => {
    inp.addEventListener("change", () => {
      if (inp.value) recordEvent(p, inp.dataset.ev, inp.value);
    });
  });
  $("#dEvents").querySelectorAll("button[data-clear]").forEach((b) => {
    b.addEventListener("click", () => clearEvent(p, b.dataset.clear));
  });
  $("#btnFinishPlanting").hidden = p.status === "done";
  $("#btnFinishPlanting").textContent = isPlanned(p) ? "予定を取りやめる" : "栽培を終了";
}

$("#dPlanDate").addEventListener("change", () => {
  const p = state.plantings.find((x) => x.id === openDetailId);
  const v = $("#dPlanDate").value;
  if (!p || !v) return;
  fire(updateDoc(subDoc("plantings", p.id), { plannedDate: v, updatedAt: serverTimestamp() }), "予定日を変更しました");
});

function saveBed() {
  const p = state.plantings.find((x) => x.id === openDetailId);
  if (!p) return;
  fire(updateDoc(subDoc("plantings", p.id), { ...readBed("#dLen", "#dWid"), updatedAt: serverTimestamp() }), "畝の大きさを保存しました");
}
$("#dLen").addEventListener("change", saveBed);
$("#dFertDisplay").addEventListener("change", () => {
  const p = state.plantings.find((x) => x.id === openDetailId);
  if (p) fire(updateDoc(subDoc("plantings", p.id), { fertDisplay: $("#dFertDisplay").value, updatedAt: serverTimestamp() }), "肥料の表示を変更しました");
});
$("#dFertType").addEventListener("change", () => {
  const p = state.plantings.find((x) => x.id === openDetailId);
  if (p) fire(updateDoc(subDoc("plantings", p.id), { fertType: $("#dFertType").value, updatedAt: serverTimestamp() }), "肥料の種類を変更しました");
});
$("#dWid").addEventListener("change", saveBed);

function recordEvent(planting, ev, date) {
  const data = { ["events." + ev]: date, updatedAt: serverTimestamp() };
  // 予定の作付けで、種まき（定植）を記録したら栽培中に切り替える
  if (isPlanned(planting) && ev === planting.plannedEvent) data.status = "active";
  fire(updateDoc(subDoc("plantings", planting.id), data), (EVENT_LABELS[ev] || ev) + "を記録しました");
  fire(addDoc(subCol("logs"), { plantingId: planting.id, event: ev, date, createdAt: serverTimestamp() }));
}

function clearEvent(planting, ev) {
  if (!confirm((EVENT_LABELS[ev] || ev) + "の記録を取り消しますか？")) return;
  const data = { ["events." + ev]: deleteField(), updatedAt: serverTimestamp() };
  // 予定から始めた作付けで開始の記録を取り消したら、予定に戻す
  if (planting.status === "active" && planting.plannedEvent === ev && planting.plannedDate) data.status = "planned";
  fire(updateDoc(subDoc("plantings", planting.id), data), "取り消しました");
  fire(addDoc(subCol("logs"), { plantingId: planting.id, event: ev, date: null, action: "clear", createdAt: serverTimestamp() }));
}

$("#btnCloseDetail").addEventListener("click", () => $("#dlgDetail").close());
$("#dlgDetail").addEventListener("close", () => { openDetailId = null; });
$("#btnFinishPlanting").addEventListener("click", () => {
  const p = state.plantings.find((x) => x.id === openDetailId);
  if (!p) return;
  if (isPlanned(p)) {
    if (!confirm("この予定を取りやめますか？")) return;
    fire(updateDoc(subDoc("plantings", p.id), { status: "cancelled", finishedAt: todayJST(), updatedAt: serverTimestamp() }), "予定を取りやめました");
    $("#dlgDetail").close();
    return;
  }
  openFinish(p.id);
});

// ---------- 画面：畑・設定 ----------
let editingFieldId = null;

function renderFields() {
  const box = $("#fieldList");
  if (state.fields.length === 0) {
    box.innerHTML = '<div class="card empty">畑を登録すると、その場所の天気をもとに作業の目安を出します。</div>';
    return;
  }
  box.innerHTML = state.fields.map((f) => {
    const n = state.plantings.filter((p) => p.fieldId === f.id && p.status === "active").length;
    return '<div class="card spread" data-field="' + esc(f.id) + '" style="cursor:pointer"><div><b>' + esc(f.name) + "</b>"
      + '<div class="small muted">' + Number(f.lat).toFixed(4) + ", " + Number(f.lng).toFixed(4) + "</div></div>"
      + '<span class="small muted">栽培中 ' + n + "</span></div>";
  }).join("");
  box.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("click", () => openField(el.dataset.field));
  });
}

function openField(id) {
  editingFieldId = id;
  const f = id ? fieldById(id) : null;
  $("#dlgFieldTitle").textContent = f ? "畑を編集" : "畑を追加";
  $("#fName").value = f ? f.name : "";
  $("#fLat").value = f ? f.lat : "";
  $("#fLng").value = f ? f.lng : "";
  $("#geoMsg").textContent = "";
  $("#btnDeleteField").hidden = !f;
  $("#dlgField").showModal();
}

$("#btnAddField").addEventListener("click", () => openField(null));

$("#btnGeo").addEventListener("click", () => {
  if (!navigator.geolocation) { $("#geoMsg").textContent = "この端末では使えません"; return; }
  $("#geoMsg").textContent = "取得中…";
  navigator.geolocation.getCurrentPosition((pos) => {
    $("#fLat").value = pos.coords.latitude.toFixed(4);
    $("#fLng").value = pos.coords.longitude.toFixed(4);
    $("#geoMsg").textContent = "取得しました";
  }, (err) => {
    $("#geoMsg").textContent = "取得できませんでした（" + err.message + "）";
  }, { enableHighAccuracy: false, timeout: 10000 });
});

$("#dlgField").addEventListener("close", () => {
  if ($("#dlgField").returnValue !== "ok") return;
  const data = {
    name: $("#fName").value.trim(),
    lat: Number($("#fLat").value),
    lng: Number($("#fLng").value),
    updatedAt: serverTimestamp()
  };
  if (!data.name || !isFinite(data.lat) || !isFinite(data.lng)) return;
  if (editingFieldId) {
    fire(updateDoc(subDoc("fields", editingFieldId), data), "保存しました");
  } else {
    fire(addDoc(subCol("fields"), { ...data, createdAt: serverTimestamp() }), "畑を追加しました");
  }
});

$("#btnDeleteField").addEventListener("click", () => {
  const inUse = state.plantings.some((p) => p.fieldId === editingFieldId && p.status === "active");
  if (inUse) { alert("栽培中の作付けがある畑は削除できません。先に作付けを終了してください。"); return; }
  if (!confirm("この畑を削除しますか？")) return;
  fire(deleteDoc(subDoc("fields", editingFieldId)), "削除しました");
  $("#dlgField").close();
});

function renderSettings() {
  const u = state.userDoc;
  if (!u) return;
  $("#selRegion").value = u.region || "mid";
  $("#chkShareStats").checked = u.shareStats === true;
  const started = u.trialStartedAt && u.trialStartedAt.toDate
    ? u.trialStartedAt.toDate().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }) : "";
  $("#planInfo").textContent = u.plan === "trial"
    ? "試用中" + (started ? "（" + started.replace(/-/g, "/") + " 開始）" : "")
    : "プラン：" + u.plan;
}

$("#chkShareStats").addEventListener("change", () => {
  const on = $("#chkShareStats").checked;
  fire(updateDoc(userRef(), { shareStats: on, shareStatsChangedAt: serverTimestamp() }),
    on ? "統計への提供をオンにしました" : "統計への提供をオフにしました");
});

$("#selRegion").addEventListener("change", () => {
  fire(updateDoc(userRef(), { region: $("#selRegion").value }), "地域区分を変更しました");
});

// ---------- タブ切り替え ----------
const VIEW_TITLES = { today: "今日やること", plantings: "作付け", records: "実績", fields: "畑・設定" };

function switchView(name) {
  document.querySelectorAll("section.view").forEach((s) => s.classList.toggle("active", s.id === "view-" + name));
  document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#hdrTitle").textContent = VIEW_TITLES[name];
  window.scrollTo(0, 0);
}

document.querySelectorAll("nav.tabs button").forEach((b) => {
  b.addEventListener("click", () => switchView(b.dataset.view));
});

// ---------- オンライン状態・PWA ----------
function syncNet() {
  $("#netBadge").classList.toggle("show", !navigator.onLine);
  if (navigator.onLine && state.user) refreshWeather();
}
window.addEventListener("online", syncNet);
window.addEventListener("offline", syncNet);
syncNet();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("Service Worker 登録失敗:", err));
}

// 日付が変わったら再描画（アプリを開きっぱなしの場合）
let lastDay = todayJST();
setInterval(() => {
  const d = todayJST();
  if (d !== lastDay) { lastDay = d; renderToday(); renderPlantings(); }
}, 60 * 1000);
