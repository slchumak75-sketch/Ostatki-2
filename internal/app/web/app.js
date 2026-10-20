"use strict";
/* Ostatki GUI. Контракт с сервером — docs/ARCHITECTURE.md (тот же API у Go и Python dev-сервера). */

const $ = (id) => document.getElementById(id);
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STATUS = {
  urgent: ["🔴 Срочно", "b-urgent"], order: ["🟠 К закупке", "b-order"],
  ok: ["🟢 Достаточно", "b-ok"], excess: ["🔵 Избыток", "b-excess"], dead: ["⚪ Нет продаж", "b-dead"],
};
const REGULARITY = { regular: "регулярный", irregular: "нерегулярный", sporadic: "эпизодический" };
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const COLORS = ["#2f5496", "#e67e22", "#548235", "#7f4fbf", "#c0392b", "#16a0a8"];

let state = null;
let sortKey = "orderCost", sortDir = -1, page = 0;
const PAGE_SIZE = 100;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(v) { return v == null ? "—" : nf2.format(v); }
function qty(v) { return v == null ? "—" : (Number.isInteger(v) ? nf0.format(v) : nf2.format(v)); }
function pct(v) { return v == null ? "—" : nf0.format(Math.round(v)) + "%"; }

function readParams() {
  return {
    horizon: Number($("pHorizon").value) || 3,
    safetyPercent: Number($("pSafety").value) || 0,
    leadDays: Number($("pLead").value) || 0,
    deadMonths: Number($("pDead").value) || 0,
    partialLast: $("pPartial").checked,
    useTrend: $("pTrend").checked,
    shrinkageK: 30,
  };
}
function applyParams(p) {
  if (!p) return;
  $("pHorizon").value = p.horizon; $("pSafety").value = p.safetyPercent;
  $("pLead").value = p.leadDays; $("pDead").value = p.deadMonths;
  $("pPartial").checked = !!p.partialLast; $("pTrend").checked = !!p.useTrend;
}
function showError(msg) {
  const b = $("errorBox");
  if (!msg) { b.classList.add("hidden"); b.textContent = ""; return; }
  b.textContent = "Ошибка: " + msg; b.classList.remove("hidden");
}
async function apiJSON(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

async function uploadFile(file) {
  if (!file) return;
  showError("");
  const fd = new FormData();
  fd.append("file", file);
  fd.append("params", JSON.stringify(readParams()));
  $("fileInfo").textContent = "Загружаю и считаю: " + file.name + "…";
  try {
    state = await apiJSON(await fetch("/api/upload", { method: "POST", body: fd }));
    page = 0; renderAll();
  } catch (e) { showError(e.message); $("fileInfo").textContent = "Не удалось загрузить файл."; }
}
async function recalc() {
  if (!state) return;
  showError("");
  try {
    state = await apiJSON(await fetch("/api/recalc", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: readParams() }),
    }));
    page = 0; renderAll();
  } catch (e) { showError(e.message); }
}

function fillSelect(id, values, allLabel) {
  const sel = $(id); const cur = sel.value;
  sel.innerHTML = '<option value="">' + esc(allLabel) + "</option>" +
    values.map((v) => '<option value="' + esc(v) + '"' + (v === cur ? " selected" : "") + ">" + esc(v) + "</option>").join("");
}

function renderAll() {
  if (!state || state.empty) return;
  applyParams(state.params);
  $("version").textContent = state.version ? "v" + state.version : "";
  const fc = (state.forecastMonths || []).map((m) => m.label).join(", ");
  $("fileInfo").textContent = "Файл: " + (state.fileName || "") + " · загружен " + (state.loadedAt || "");
  $("forecastInfo").textContent = fc ? "Период прогноза: " + fc : "";
  $("warnings").innerHTML = (state.warnings || []).map((w) => '<div class="warn">⚠️ ' + esc(w) + "</div>").join("");
  $("btnExportXlsx").disabled = false; $("btnExportCsv").disabled = false; $("btnRecalc").disabled = false;
  $("emptyState").classList.add("hidden");
  $("kpis").classList.remove("hidden"); $("tabs").classList.remove("hidden");
  document.querySelectorAll(".tab").forEach((t) => t.classList.add("hidden"));
  $("tab-" + currentTab).classList.remove("hidden");

  const s = state.summary;
  const kpi = (v, t, cls) => '<div class="kpi ' + (cls || "") + '"><div class="v">' + v + '</div><div class="t">' + t + "</div></div>";
  $("kpis").innerHTML =
    kpi(nf0.format(s.orderBudget) + " руб.", "БЮДЖЕТ ЗАКУПКИ · " + nf0.format(s.orderSku) + " SKU · " + qty(s.orderUnits) + " ед.", "accent") +
    kpi(nf0.format(s.urgentSku), "срочно: продаётся, но остаток = 0", "bad") +
    kpi(nf0.format(s.stockPurchase) + " руб.", "остатки по закупочной цене") +
    kpi(nf0.format(s.potentialProfit) + " руб.", "потенц. прибыль остатков (розница−закупка)") +
    kpi(s.avgMarginPct == null ? "—" : pct(s.avgMarginPct), "средняя маржа · медианная наценка " + pct(s.medianMarkupPct)) +
    kpi(nf0.format(s.deadValue) + " руб.", "«мёртвые» остатки без продаж · " + nf0.format(s.deadSku) + " SKU", "bad") +
    kpi(qty(s.sales12Units), "продано за 12 мес., ед.") +
    kpi(nf0.format(s.sku), "всего SKU · складов " + s.warehouses + " · поставщиков " + s.suppliers);

  const uniq = (key) => [...new Set(state.rows.map((r) => r[key] || ""))].filter(Boolean).sort();
  fillSelect("fWarehouse", uniq("warehouse"), "Все склады");
  fillSelect("fGroup", uniq("group"), "Все группы");
  fillSelect("fSupplier", uniq("supplier"), "Все поставщики");
  renderTable(); renderPurchase(); renderAnalytics();
}

function filteredRows() {
  const q = $("fSearch").value.trim().toLowerCase();
  const wh = $("fWarehouse").value, gr = $("fGroup").value, sup = $("fSupplier").value;
  const st = $("fStatus").value, abc = $("fAbc").value, only = $("fOnlyOrder").checked;
  let rows = state.rows.filter((r) =>
    (!q || (r.name + " " + (r.article || "")).toLowerCase().includes(q)) &&
    (!wh || r.warehouse === wh) && (!gr || r.group === gr) && (!sup || r.supplier === sup) &&
    (!st || r.status === st) && (!abc || r.abc === abc) && (!only || r.recommend > 0));
  rows.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (x == null) x = typeof y === "string" ? "" : -Infinity;
    if (y == null) y = typeof x === "string" ? "" : -Infinity;
    if (typeof x === "string") return x.localeCompare(y, "ru") * sortDir;
    return (x - y) * sortDir;
  });
  return rows;
}

function detailHTML(r) {
  const fcRows = (state.forecastMonths || []).map((m, i) =>
    "<div><dt>" + esc(m.label) + "</dt><dd>" + qty(Math.round((r.forecast[i] || 0) * 10) / 10) + "</dd></div>").join("");
  return '<div class="detail-inner"><div><canvas data-chart="' + r.id + '"></canvas>' +
    '<div class="legend"><span><i style="background:#2f5496"></i>Продажи по месяцам</span><span><i style="background:#e67e22"></i>Прогноз</span></div></div>' +
    "<dl>" +
    "<div><dt>Прогноз на период</dt><dd>" + qty(Math.round(r.forecastTotal * 10) / 10) + "</dd></div>" + fcRows +
    "<div><dt>Спрос за срок поставки</dt><dd>" + qty(Math.round(r.leadDemand * 10) / 10) + "</dd></div>" +
    "<div><dt>Страховой запас</dt><dd>" + qty(Math.round(r.safetyStock * 10) / 10) + "</dd></div>" +
    "<div><dt>Потребность всего</dt><dd>" + qty(Math.round(r.need * 10) / 10) + "</dd></div>" +
    "<div><dt>Минус остаток</dt><dd>" + qty(r.stock) + "</dd></div>" +
    "<div><dt><b>К закупке</b></dt><dd>" + qty(r.recommend) + "</dd></div>" +
    "<div><dt>Базовый уровень/мес.</dt><dd>" + qty(Math.round(r.baseLevel * 100) / 100) + "</dd></div>" +
    "<div><dt>Тренд</dt><dd>×" + r.trendFactor + "</dd></div>" +
    "<div><dt>Сезонность янв…дек</dt><dd>" + (r.seasonal || []).map((v) => v.toFixed(2)).join(" ") + "</dd></div>" +
    "<div><dt>Последняя продажа</dt><dd>" + esc(r.lastSaleLabel || "—") + "</dd></div>" +
    "<div><dt>Спрос</dt><dd>" + esc(REGULARITY[r.regularity] || "") + ", ABC=" + esc(r.abc) + "</dd></div>" +
    "<div><dt>Прибыль за ед.</dt><dd>" + money(r.profitPerUnit) + "</dd></div>" +
    "<div><dt>Валовая прибыль 12 мес.</dt><dd>" + money(r.grossProfit12) + "</dd></div>" +
    (r.retailEstimated ? "<div><dt>Розница</dt><dd>оценена по наценке группы</dd></div>" : "") +
    "</dl></div>";
}

function renderTable() {
  const rows = filteredRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page >= pages) page = pages - 1;
  $("rowCount").textContent = "Строк: " + rows.length + " из " + state.rows.length;
  $("pageInfo").textContent = "Страница " + (page + 1) + " из " + pages;
  document.querySelectorAll("#mainTable th").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === sortKey) th.classList.add(sortDir === 1 ? "sorted-asc" : "sorted-desc");
  });
  const part = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  $("mainBody").innerHTML = part.map((r) => {
    const st = STATUS[r.status] || [r.status, ""];
    return '<tr class="main-row" data-id="' + r.id + '">' +
      '<td class="expand" data-expand="' + r.id + '">▸</td>' +
      '<td class="name-cell">' + esc(r.name) + '<div class="sub">' + esc([r.article, r.warehouse, r.group, r.unit].filter(Boolean).join(" · ")) + "</div></td>" +
      '<td class="num">' + qty(r.stock) + "</td>" +
      '<td class="num">' + qty(r.sales12) + "</td>" +
      '<td class="num">' + qty(Math.round(r.forecastTotal * 10) / 10) + "</td>" +
      '<td class="num rec ' + (r.recommend > 0 ? "pos" : "") + '">' + qty(r.recommend) + "</td>" +
      '<td class="num">' + money(r.purchasePrice) + "</td>" +
      '<td class="num">' + money(r.retailEffective) + (r.retailEstimated ? ' <span class="est">оценка</span>' : "") + "</td>" +
      '<td class="num">' + pct(r.markupPct) + "</td>" +
      '<td class="num">' + money(r.orderCost) + "</td>" +
      '<td class="num">' + (r.monthsOfStock == null ? "—" : qty(r.monthsOfStock)) + "</td>" +
      '<td class="abc abc-' + esc(r.abc) + '">' + esc(r.abc) + "</td>" +
      '<td><span class="badge ' + st[1] + '">' + esc(st[0]) + "</span></td>" +
      "<td>" + esc(r.supplier) + "</td></tr>" +
      '<tr class="detail hidden" id="detail-' + r.id + '"><td colspan="14">' + detailHTML(r) + "</td></tr>";
  }).join("");
  document.querySelectorAll("[data-expand]").forEach((el) => el.addEventListener("click", () => {
    const row = $("detail-" + el.dataset.expand);
    const open = row.classList.toggle("hidden") === false;
    el.textContent = open ? "▾" : "▸";
    if (open) drawItemChart(row.querySelector("canvas"), state.rows[Number(el.dataset.expand)]);
  }));
}

function renderPurchase() {
  const bySup = new Map();
  state.rows.filter((r) => r.recommend > 0).forEach((r) => {
    if (!bySup.has(r.supplier)) bySup.set(r.supplier, []);
    bySup.get(r.supplier).push(r);
  });
  const order = (state.suppliersAgg || []).filter((a) => a.orderSku > 0);
  if (!order.length) { $("tab-purchase").innerHTML = '<div class="card">Нет позиций к закупке при текущих параметрах.</div>'; return; }
  $("tab-purchase").innerHTML = order.map((a, idx) => {
    const rows = (bySup.get(a.name) || []).slice().sort((x, y) => y.orderCost - x.orderCost);
    const body = rows.map((r) => "<tr><td>" + esc(r.name) + '</td><td>' + esc(r.article || "") + '</td><td class="num">' + qty(r.stock) +
      '</td><td class="num">' + qty(Math.round(r.forecastTotal * 10) / 10) + '</td><td class="num rec pos">' + qty(r.recommend) +
      " " + esc(r.unit || "") + '</td><td class="num">' + money(r.purchasePrice) + '</td><td class="num">' + money(r.orderCost) +
      "</td><td>" + esc(r.warehouse) + "</td></tr>").join("");
    return '<div class="card supplier-block"><div class="supplier-head" data-sup="' + idx + '"><h3>🚚 ' + esc(a.name || "(без поставщика)") +
      '</h3><span><b>' + money(a.orderBudget) + " руб.</b> · " + a.orderSku + " SKU · " + qty(a.orderUnits) + " ед. — нажмите, чтобы свернуть/развернуть</span></div>" +
      '<div class="table-wrap" id="supBody-' + idx + '"><table class="mini-table"><thead><tr><th>Номенклатура</th><th>Артикул</th><th class="num">Остаток</th><th class="num">Прогноз</th><th class="num">К закупке</th><th class="num">Цена</th><th class="num">Сумма</th><th>Склад</th></tr></thead><tbody>' +
      body + "</tbody></table></div></div>";
  }).join("");
  document.querySelectorAll("[data-sup]").forEach((el) => el.addEventListener("click", () => {
    $("supBody-" + el.dataset.sup).classList.toggle("hidden");
  }));
}

function aggTable(title, agg) {
  if (!agg || !agg.length) return "";
  const body = agg.map((a) => "<tr><td>" + esc(a.name) + '</td><td class="num">' + a.sku + '</td><td class="num">' + qty(a.stockUnits) +
    '</td><td class="num">' + money(a.stockPurchase) + '</td><td class="num">' + money(a.stockRetail) + '</td><td class="num">' + qty(a.sales12) +
    '</td><td class="num">' + money(a.grossProfit12) + '</td><td class="num">' + a.orderSku + '</td><td class="num">' + money(a.orderBudget) + "</td></tr>").join("");
  return '<div class="card"><h3>' + esc(title) + '</h3><div class="table-wrap"><table class="mini-table"><thead><tr><th>Название</th><th class="num">SKU</th><th class="num">Остатки, ед.</th><th class="num">Остатки, закупка</th><th class="num">Остатки, розница</th><th class="num">Продажи 12м, ед.</th><th class="num">Валовая прибыль 12м</th><th class="num">К закупке, SKU</th><th class="num">Бюджет закупки</th></tr></thead><tbody>' + body + "</tbody></table></div></div>";
}
function topList(title, rows, valFn, fmt) {
  const body = rows.map((r) => "<tr><td>" + esc(r.name) + '</td><td>' + esc(r.warehouse) + '</td><td class="num">' + fmt(valFn(r)) + '</td><td class="num">' + qty(r.stock) + '</td><td class="num">' + qty(r.sales12) + "</td></tr>").join("");
  return '<div class="card"><h3>' + esc(title) + '</h3><div class="table-wrap"><table class="mini-table"><thead><tr><th>Номенклатура</th><th>Склад</th><th class="num">Значение</th><th class="num">Остаток</th><th class="num">Продажи 12м</th></tr></thead><tbody>' + body + "</tbody></table></div></div>";
}

function renderAnalytics() {
  const rows = state.rows;
  const byGross = rows.slice().sort((a, b) => b.grossProfit12 - a.grossProfit12).slice(0, 15);
  const dead = rows.filter((r) => r.status === "dead" && r.stock > 0).sort((a, b) => b.stockPurchase - a.stockPurchase).slice(0, 15);
  const lost = rows.filter((r) => r.stock === 0 && r.sales12 > 0).sort((a, b) => b.grossProfit12 - a.grossProfit12).slice(0, 15);
  $("analyticsTables").innerHTML =
    aggTable("По складам", state.warehousesAgg) +
    aggTable("По группам номенклатуры", state.groupsAgg) +
    aggTable("По поставщикам", state.suppliersAgg) +
    topList("ТОП-15 по валовой прибыли за 12 мес., руб.", byGross, (r) => r.grossProfit12, money) +
    topList("ТОП-15 упущенных продаж: остаток 0, а товар продавался (валовая прибыль 12 мес., руб.)", lost, (r) => r.grossProfit12, money) +
    topList("ТОП-15 «мёртвых» остатков по стоимости закупки, руб.", dead, (r) => r.stockPurchase, money);
  // Графики рисуем только если вкладка видима (иначе ширина canvas = 0).
  if (currentTab === "analytics") drawAnalyticsCharts();
}

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || cv.parentElement.clientWidth || 600;
  const h = Number(cv.getAttribute("height")) || 200;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + "px";
  const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
  return { ctx, w, h };
}
function drawBars(cv, series, labels) {
  if (!cv) return;
  const { ctx, w, h } = setupCanvas(cv);
  const pad = { l: 44, r: 8, t: 10, b: 26 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  let max = 0; series.forEach((s) => s.values.forEach((v) => { if (v > max) max = v; }));
  if (max <= 0) max = 1;
  ctx.strokeStyle = "#d9e1ec"; ctx.fillStyle = "#68798c"; ctx.font = "10px Segoe UI, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ih - (ih * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(nf0.format((max * i) / 4), 4, y + 3);
  }
  const n = labels.length, groupW = iw / n, barW = Math.max(2, (groupW * 0.78) / series.length);
  series.forEach((s, si) => {
    ctx.fillStyle = s.color;
    s.values.forEach((v, i) => {
      const bh = (v / max) * ih;
      const x = pad.l + i * groupW + groupW * 0.11 + si * barW;
      ctx.fillRect(x, pad.t + ih - bh, barW - 1, bh);
    });
  });
  ctx.fillStyle = "#68798c";
  const step = Math.max(1, Math.floor(n / Math.max(1, Math.floor(iw / 46))));
  labels.forEach((lb, i) => { if (i % step === 0) ctx.fillText(lb, pad.l + i * groupW + 2, h - 8); });
}
function drawAnalyticsCharts() {
  const groupNames = Object.keys(state.seasonalByGroup || {});
  const series = [{ values: state.seasonalGlobal || [], color: COLORS[0] }];
  groupNames.forEach((g, i) => series.push({ values: state.seasonalByGroup[g], color: COLORS[(i + 1) % COLORS.length] }));
  drawBars($("chartSeason"), series, MONTHS_SHORT);
  $("seasonLegend").innerHTML = '<span><i style="background:' + COLORS[0] + '"></i>Все товары</span>' +
    groupNames.map((g, i) => '<span><i style="background:' + COLORS[(i + 1) % COLORS.length] + '"></i>' + esc(g) + "</span>").join("");
  const totals = (state.months || []).map((m, t) => state.rows.reduce((acc, r) => acc + (r.sales[t] || 0), 0));
  drawBars($("chartSales"), [{ values: totals, color: COLORS[0] }],
    (state.months || []).map((m) => MONTHS_SHORT[m.month - 1] + " " + String(m.year).slice(2)));
}
function drawItemChart(cv, r) {
  if (!cv || !r) return;
  const labels = (state.months || []).map((m) => MONTHS_SHORT[m.month - 1] + String(m.year).slice(2))
    .concat((state.forecastMonths || []).map((m) => MONTHS_SHORT[m.month - 1] + String(m.year).slice(2) + "*"));
  const hist = r.sales.concat((state.forecastMonths || []).map(() => 0));
  const fc = r.sales.map(() => 0).concat(r.forecast || []);
  drawBars(cv, [{ values: hist, color: "#2f5496" }, { values: fc, color: "#e67e22" }], labels);
}

/* ---- события ---- */
let currentTab = "table";
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
  currentTab = b.dataset.tab;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.add("hidden"));
  $("tab-" + currentTab).classList.remove("hidden");
  if (currentTab === "analytics" && state) drawAnalyticsCharts();
}));
$("fileInput").addEventListener("change", (e) => uploadFile(e.target.files[0]));
$("btnRecalc").addEventListener("click", recalc);
["fSearch", "fWarehouse", "fGroup", "fSupplier", "fStatus", "fAbc", "fOnlyOrder"].forEach((id) =>
  $(id).addEventListener("input", () => { page = 0; if (state) renderTable(); }));
document.querySelectorAll("#mainTable th[data-sort]").forEach((th) => th.addEventListener("click", () => {
  if (sortKey === th.dataset.sort) sortDir *= -1; else { sortKey = th.dataset.sort; sortDir = sortKey === "name" ? 1 : -1; }
  if (state) renderTable();
}));
$("pagePrev").addEventListener("click", () => { if (page > 0) { page--; renderTable(); } });
$("pageNext").addEventListener("click", () => { page++; renderTable(); });
$("btnExportXlsx").addEventListener("click", () => { window.location = "/api/export.xlsx"; });
$("btnExportCsv").addEventListener("click", () => { window.location = "/api/purchase.csv"; });
$("btnShutdown").addEventListener("click", async () => {
  if (!confirm("Остановить приложение?")) return;
  try { await fetch("/api/shutdown", { method: "POST" }); } catch (e) { /* сервер уже остановлен */ }
  $("overlay").classList.remove("hidden");
});
let dragDepth = 0;
document.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("dragleave", (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
document.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging"); });
document.addEventListener("drop", (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) uploadFile(f); });
window.addEventListener("resize", () => { if (state && currentTab === "analytics") drawAnalyticsCharts(); });

(async function init() {
  try {
    const health = await apiJSON(await fetch("/api/health"));
    if (health.version) $("version").textContent = "v" + health.version;
    const st = await apiJSON(await fetch("/api/state"));
    if (st && !st.empty) { state = st; renderAll(); }
  } catch (e) { /* сервер ещё не готов — пользователь загрузит файл вручную */ }
})();
