// 畑ノート 試作版 v0.1
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
  sow: "種まき",
  germinate: "発芽",
  transplant: "定植",
  rooted: "活着（根付いた）",
  thin1: "間引き 1回目",
  thin2: "間引き 2回目",
  thin3: "間引き 3回目",
  fertilize1: "追肥 1回目",
  fertilize2: "追肥 2回目",
  bulbStart: "玉の肥大が始まった",
  harvestStart: "収穫開始",
  harvestEnd: "収穫終了"
};
const EVENT_ORDER = [
  "sow", "germinate", "transplant", "rooted", "thin1", "thin2", "thin3",
  "fertilize1", "fertilize2", "bulbStart", "harvestStart", "harvestEnd"
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

/** その作付けで記録しうるイベントの一覧（開始方法のステージ＋ルールが参照するイベント） */
function eventsForPlanting(crop, planting) {
  const set = new Set();
  const method = methodOf(crop, planting);
  method.stages.forEach((sid) => {
    const st = crop.stages.find((s) => s.id === sid);
    if (st) set.add(st.startEvent);
  });
  crop.rules.forEach((r) => {
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

function startDateOf(planting) {
  const ev = planting.events || {};
  const dates = Object.values(ev).filter(Boolean).sort();
  return dates.length ? dates[0] : null;
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
    renderToday();
    if (openDetailId) renderDetail(openDetailId);
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
  const active = state.plantings.filter((p) => p.status === "active");

  const items = [];
  active.forEach((p) => {
    const crop = cropById(p.cropId);
    if (!crop) return;
    const res = Engine.evaluatePlanting(crop, p, buildCtx(p.fieldId, today));
    res.tasks.forEach((t) => {
      if (dismissed.has(p.id + ":" + t.ruleId)) return;
      const rule = crop.rules.find((r) => r.id === t.ruleId);
      items.push({ ...t, planting: p, crop, stage: res.stage, resolvedBy: rule ? rule.resolvedBy : null });
    });
  });
  items.sort((a, b) => (a.priority - b.priority) || ((b.overdue ? 1 : 0) - (a.overdue ? 1 : 0)));

  const box = $("#todayTasks");
  if (active.length === 0) {
    box.innerHTML = '<div class="card empty">まだ作付けがありません。<br>「作付け」タブから登録しましょう。</div>';
  } else if (items.length === 0) {
    box.innerHTML = '<div class="card empty">今日やることはありません。</div>';
  } else {
    box.innerHTML = items.map((t, i) => {
      const f = fieldById(t.planting.fieldId);
      const draft = (t.overdue ? '<span class="badge late">遅れ気味</span>' : "")
        + (t.confidence === "draft" ? '<span class="badge draft">目安・検証中</span>' : "");
      const btn = t.resolvedBy
        ? '<button class="primary" data-act="done" data-i="' + i + '">やった（今日）</button>'
          + '<button class="ghost" data-act="pick" data-i="' + i + '">日付を選んで記録</button>'
        : '<button data-act="dismiss" data-i="' + i + '">確認した</button>';
      return '<div class="card task p' + t.priority + '"><div class="bar"></div><div>'
        + '<div class="meta">' + esc(f ? f.name : "畑未設定") + " · " + esc(t.crop.name)
        + " · " + esc(stageName(t.crop, t.stage)) + draft + "</div>"
        + '<div class="title">' + esc(t.title) + "</div>"
        + '<p class="msg">' + esc(t.message) + "</p>"
        + '<p class="why">判定の根拠：' + esc(t.reasons.map((r) => prettyReason(r, t.crop)).join(" / ")) + "</p>"
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
    box.innerHTML = '<div class="card empty small">登録済みの作物の中で、今が種まき適期のものはありません。</div>';
    return;
  }
  box.innerHTML = list.map((c) =>
    '<div class="card spread"><div><b>' + esc(c.name) + "</b>"
    + (c.isNew ? '<span class="badge new">未挑戦</span>' : "")
    + '<div class="small muted">難易度 ' + "★".repeat(c.difficulty) + "☆".repeat(Math.max(0, 5 - c.difficulty)) + "</div></div>"
    + '<button data-crop="' + esc(c.cropId) + '">植える</button></div>'
  ).join("");
  box.querySelectorAll("button[data-crop]").forEach((b) => {
    b.addEventListener("click", () => openAddPlanting(b.dataset.crop));
  });
}

// ---------- 画面：作付け ----------
function renderPlantings() {
  const box = $("#plantingList");
  if (!state.master) return;
  const today = todayJST();
  const active = state.plantings.filter((p) => p.status === "active")
    .sort((a, b) => String(startDateOf(a)).localeCompare(String(startDateOf(b))));
  const done = state.plantings.filter((p) => p.status !== "active");

  let html = "";
  if (active.length === 0) {
    html += '<div class="card empty">作付けはまだありません。</div>';
  }
  html += active.map((p) => {
    const crop = cropById(p.cropId);
    if (!crop) return "";
    const f = fieldById(p.fieldId);
    const start = startDateOf(p);
    const days = start ? Engine._util.daysBetween(start, today) : null;
    const stage = Engine.currentStage(crop, p);
    return '<div class="card spread" data-open="' + esc(p.id) + '" style="cursor:pointer"><div>'
      + "<b>" + esc(crop.name) + "</b>"
      + (p.memo ? ' <span class="small muted">' + esc(p.memo) + "</span>" : "")
      + '<div class="small muted">' + esc(f ? f.name : "畑未設定") + " · " + esc(methodOf(crop, p).label)
      + " · " + esc(stageName(crop, stage)) + "</div></div>"
      + '<div class="small muted" style="text-align:right">' + (start ? esc(md(start)) + "〜<br>" + days + "日目" : "") + "</div></div>";
  }).join("");

  if (done.length) {
    html += "<h2>終了した作付け</h2>" + done.map((p) => {
      const crop = cropById(p.cropId);
      return '<div class="card spread small" data-open="' + esc(p.id) + '" style="cursor:pointer"><span>'
        + esc(crop ? crop.name : p.cropId) + (p.memo ? "（" + esc(p.memo) + "）" : "")
        + '</span><span class="muted">' + esc(p.finishedAt ? md(p.finishedAt) + " 終了" : "") + "</span></div>";
    }).join("");
  }
  box.innerHTML = html;
  box.querySelectorAll("[data-open]").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.open));
  });
}

function openAddPlanting(cropId) {
  if (state.fields.length === 0) {
    toast("先に畑を登録してください");
    switchView("fields");
    return;
  }
  $("#pField").innerHTML = state.fields.map((f) => '<option value="' + esc(f.id) + '">' + esc(f.name) + "</option>").join("");
  $("#pCrop").innerHTML = state.master.crops.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>").join("");
  if (cropId) $("#pCrop").value = cropId;
  $("#pStartDate").value = todayJST();
  $("#pMemo").value = "";
  syncMethodOptions();
  $("#dlgPlanting").showModal();
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
  $("#pStartLabel").textContent = (EVENT_LABELS[ev] || ev) + "の日";
}

$("#pCrop").addEventListener("change", syncMethodOptions);
$("#pMethod").addEventListener("change", syncStartLabel);
$("#btnAddPlanting").addEventListener("click", () => openAddPlanting(null));

$("#dlgPlanting").addEventListener("close", () => {
  if ($("#dlgPlanting").returnValue !== "ok") return;
  const crop = cropById($("#pCrop").value);
  if (!crop) return;
  const method = $("#pMethod").value;
  const ev = firstEventOf(crop, method);
  const date = $("#pStartDate").value;
  const ref = doc(subCol("plantings"));
  fire(setDoc(ref, {
    fieldId: $("#pField").value,
    cropId: crop.id,
    startMethod: method,
    memo: $("#pMemo").value.trim(),
    events: { [ev]: date },
    status: "active",
    createdAt: serverTimestamp()
  }), crop.name + "を追加しました");
  fire(addDoc(subCol("logs"), { plantingId: ref.id, event: ev, date, createdAt: serverTimestamp() }));
});

// ---------- 作付けの詳細・作業記録 ----------
let openDetailId = null;

function openDetail(id) {
  openDetailId = id;
  renderDetail(id);
  if (!$("#dlgDetail").open) $("#dlgDetail").showModal();
}

function renderDetail(id) {
  const p = state.plantings.find((x) => x.id === id);
  if (!p) { $("#dlgDetail").close(); return; }
  const crop = cropById(p.cropId);
  const f = fieldById(p.fieldId);
  $("#dDetailTitle").textContent = crop.name + (p.memo ? "（" + p.memo + "）" : "");
  $("#dDetailSub").textContent = (f ? f.name : "畑未設定") + " · " + methodOf(crop, p).label
    + " · 現在：" + stageName(crop, Engine.currentStage(crop, p));
  const events = p.events || {};
  const today = todayJST();
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
  $("#btnFinishPlanting").hidden = p.status !== "active";
}

function recordEvent(planting, ev, date) {
  fire(updateDoc(subDoc("plantings", planting.id), {
    ["events." + ev]: date,
    updatedAt: serverTimestamp()
  }), (EVENT_LABELS[ev] || ev) + "を記録しました");
  fire(addDoc(subCol("logs"), { plantingId: planting.id, event: ev, date, createdAt: serverTimestamp() }));
}

function clearEvent(planting, ev) {
  if (!confirm((EVENT_LABELS[ev] || ev) + "の記録を取り消しますか？")) return;
  fire(updateDoc(subDoc("plantings", planting.id), {
    ["events." + ev]: deleteField(),
    updatedAt: serverTimestamp()
  }), "取り消しました");
  fire(addDoc(subCol("logs"), { plantingId: planting.id, event: ev, date: null, action: "clear", createdAt: serverTimestamp() }));
}

$("#btnCloseDetail").addEventListener("click", () => $("#dlgDetail").close());
$("#dlgDetail").addEventListener("close", () => { openDetailId = null; });
$("#btnFinishPlanting").addEventListener("click", () => {
  const p = state.plantings.find((x) => x.id === openDetailId);
  if (!p || !confirm("この作付けを終了しますか？（記録は残ります）")) return;
  fire(updateDoc(subDoc("plantings", p.id), { status: "done", finishedAt: todayJST(), updatedAt: serverTimestamp() }), "終了しました");
  $("#dlgDetail").close();
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
  const started = u.trialStartedAt && u.trialStartedAt.toDate
    ? u.trialStartedAt.toDate().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }) : "";
  $("#planInfo").textContent = u.plan === "trial"
    ? "試用中" + (started ? "（" + started.replace(/-/g, "/") + " 開始）" : "")
    : "プラン：" + u.plan;
}

$("#selRegion").addEventListener("change", () => {
  fire(updateDoc(userRef(), { region: $("#selRegion").value }), "地域区分を変更しました");
});

// ---------- タブ切り替え ----------
const VIEW_TITLES = { today: "今日やること", plantings: "作付け", fields: "畑・設定" };

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
