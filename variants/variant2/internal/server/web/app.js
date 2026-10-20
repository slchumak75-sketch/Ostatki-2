(() => {
  'use strict';

  const MONTH_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

  const state = {
    report: null,
    canSaveInPlace: false,
    desktopMode: false,
    filteredItems: [],
    selectedExcelRow: null,
    sortKey: 'finalOrderQty',
    sortDir: 'desc',
    page: 1,
    pageSize: 100,
    activeTab: 'table',
    debounceTimer: null,
  };

  const el = (id) => document.getElementById(id);

  function fmtInt(n) {
    return Math.round(Number(n) || 0).toLocaleString('ru-RU');
  }

  function fmtMoney(n) {
    return (Number(n) || 0).toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function fmtNum(n, d = 2) {
    return (Number(n) || 0).toLocaleString('ru-RU', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  function esc(str) {
    const s = String(str ?? '');
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let toastTimer = null;
  function showToast(msg) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
  }

  async function apiGet(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Ошибка HTTP ${res.status}`);
    return data;
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Ошибка HTTP ${res.status}`);
    return data;
  }

  function applyEnvelope(env) {
    state.canSaveInPlace = Boolean(env.canSaveInPlace);
    state.desktopMode = Boolean(env.desktopMode);
    state.report = env.report || null;

    el('btnSaveInPlace').classList.toggle('hidden', !state.canSaveInPlace);
    if (!state.report) return;

    syncParamsControls(state.report);
    populateFilterDropdowns(state.report);
    renderKPIs(state.report);
    recomputeFilteredList();

    if (state.selectedExcelRow == null && state.filteredItems.length > 0) {
      state.selectedExcelRow = state.filteredItems[0].excelRow;
    }

    renderTable();
    renderInspector();
    renderDiffView(state.report);
    renderSeasonalityView(state.report);
    renderSuppliersView(state.report);
    renderOverstockView(state.report);
  }

  function syncParamsControls(rep) {
    const p = rep.params;
    el('inpStartDate').value = rep.effectiveStartDate || '';
    el('inpHorizon').value = p.horizonDays;
    el('lblHorizon').textContent = p.horizonDays;
    el('inpLeadTime').value = p.leadTimeDays;
    el('lblLeadTime').textContent = p.leadTimeDays;
    el('inpSafety').value = p.safetyStockPct;
    el('lblSafety').textContent = `${p.safetyStockPct}%`;
    el('inpBudgetCap').value = p.budgetCap || 0;
    el('inpMinSupplier').value = p.minSupplierOrder ?? 50;
    el('selSeasonMode').value = p.seasonMode;
    el('inpDecay').value = p.recencyDecay;
    el('lblDecay').textContent = Number(p.recencyDecay).toFixed(2);
    el('selPackMultiple').value = String(p.packMultiple || 1);
    el('selMinDisplay').value = String(p.minDisplayStock || 0);
    el('selRounding').value = p.rounding;
    el('chkOutlierFilter').checked = Boolean(p.outlierFilter);
    el('chkCrostonZ').checked = Boolean(p.useCrostonZ);
    el('chkAdaptiveSLA').checked = Boolean(p.adaptiveSafetySLA);
    el('chkNormalizeLast').checked = Boolean(p.normalizePartialLast);
    el('chkWriteZeros').checked = Boolean(p.writeZeroValues);
    el('inpHeaderName').value = p.columnHeader || 'К закупкам';

    el('hintBudget').textContent = p.budgetCap > 0
      ? `Срезано лимитом: ${fmtInt(rep.budgetTrimmedUnits)} ед. (без лимита: ${fmtMoney(rep.uncappedOrderCost)} р.)`
      : '0 — без ограничения бюджета';

    const lastPeriod = rep.periods[rep.periods.length - 1];
    if (lastPeriod && rep.lastMonthCompleteness < 0.999) {
      el('hintCompleteness').textContent = `${lastPeriod.label}: учтён неполный месяц (${Math.round(rep.lastMonthCompleteness * 100)}%)`;
    } else {
      el('hintCompleteness').textContent = `Срез ведомости: ${rep.createdDate || 'полные месяцы'}`;
    }
  }

  function populateFilterDropdowns(rep) {
    const keepSet = (selectEl, items, defaultLabel, formatter) => {
      const prev = selectEl.value;
      selectEl.innerHTML = `<option value="">${esc(defaultLabel)}</option>` +
        items.map((item) => {
          const val = typeof item === 'string' ? item : item.value;
          const label = formatter ? formatter(item) : val;
          return `<option value="${esc(val)}">${esc(label)}</option>`;
        }).join('');
      if ([...selectEl.options].some((o) => o.value === prev)) {
        selectEl.value = prev;
      }
    };

    keepSet(
      el('fltWarehouse'),
      rep.warehouses.map((w) => ({ value: w.warehouse, ...w })),
      'Все склады',
      (w) => `${w.warehouse} (${w.orderItems}/${w.totalItems})`
    );
    keepSet(
      el('fltGroup'),
      rep.groups.map((g) => ({ value: g.group, ...g })),
      'Все группы',
      (g) => `${g.group} (к закупке: ${g.orderItemCount})`
    );
    keepSet(
      el('fltSupplier'),
      rep.suppliers.map((s) => ({ value: s.supplier, ...s })),
      'Все поставщики',
      (s) => `${s.supplier} — ${fmtMoney(s.totalOrderCost)} р. (${s.orderItems})`
    );
  }

  function renderKPIs(rep) {
    const firstP = rep.periods[0]?.label || '';
    const lastP = rep.periods[rep.periods.length - 1]?.label || '';
    el('fileMetaLine').textContent =
      `Файл: ${rep.fileName} • Срез: ${rep.createdDate || 'н/д'} • Статистика: ${firstP} — ${lastP} (${rep.periods.length} мес.) • Позиций: ${fmtInt(rep.totalItems)}`;

    el('kpiOrderUnits').textContent = `${fmtInt(rep.totalOrderUnits)} ед.`;
    const pct = rep.totalItems ? ((rep.orderItemsCount / rep.totalItems) * 100).toFixed(1) : '0.0';
    el('kpiOrderItems').textContent = `К закупке: ${fmtInt(rep.orderItemsCount)} из ${fmtInt(rep.totalItems)} SKU (${pct}%)`;

    el('kpiOrderCost').textContent = `${fmtMoney(rep.totalOrderCost)} руб.`;
    const savedVsV1 = rep.variant1OrderCost - rep.totalOrderCost;
    if (Math.abs(savedVsV1) < 1) {
      el('kpiV1Diff').textContent = `Совпадает со сборкой «Вариант 1»`;
    } else if (savedVsV1 > 0) {
      el('kpiV1Diff').innerHTML = `<span style="color:var(--success);font-weight:700">−${fmtMoney(savedVsV1)} руб.</span> к «Варианту 1» (${fmtMoney(rep.variant1OrderCost)} р.)`;
    } else {
      el('kpiV1Diff').innerHTML = `<span style="color:var(--warn);font-weight:700">+${fmtMoney(Math.abs(savedVsV1))} руб.</span> к «Варианту 1»`;
    }

    el('kpiRetailValue').textContent = `${fmtMoney(rep.totalRetailValue)} руб.`;
    el('kpiMarginValue').textContent = `Ожидаемая маржа: +${fmtMoney(rep.expectedMargin)} руб.`;

    const totalDays = rep.params.horizonDays + rep.params.leadTimeDays;
    el('kpiHorizonRange').textContent = `${rep.effectiveStartDate} → ${rep.effectiveEndDate}`;
    const grpIdxSummary = rep.groups
      .map((g) => `${g.group.replace(/^\d+\s*/, '')}: ×${g.horizonIndex.toFixed(2)}`)
      .join(' • ');
    el('kpiSeasonSummary').textContent = `${totalDays} дн. • ${grpIdxSummary}`;

    el('kpiOverstockVal').textContent = `${fmtMoney(rep.overstockFrozenCost)} руб. (${rep.overstockItemsCount} SKU)`;
    el('kpiOutlierInfo').textContent = `Сглажено опт-выбросов: ${rep.outlierItemsCount} SKU • Ручных правок: ${rep.manualOverrideCount}`;

    el('btnClearOverrides').classList.toggle('hidden', rep.manualOverrideCount === 0);
    el('cntTabSuppliers').textContent = rep.suppliers.filter((s) => s.orderItems > 0).length;
    el('cntTabOverstock').textContent = rep.overstockItemsCount;
    el('cntTabDiff').textContent = rep.items.filter((x) => x.deltaFromV1 !== 0).length;
  }

  function recomputeFilteredList() {
    if (!state.report) {
      state.filteredItems = [];
      return;
    }
    const q = el('inpSearch').value.trim().toLowerCase();
    const wh = el('fltWarehouse').value;
    const grp = el('fltGroup').value;
    const sup = el('fltSupplier').value;
    const seg = el('fltABCXYZ').value;
    const status = el('fltStatus').value;

    const list = state.report.items.filter((it) => {
      if (wh && it.warehouse !== wh) return false;
      if (grp && it.group !== grp) return false;
      const itemSup = it.supplier || '(Поставщик не указан)';
      if (sup && itemSup !== sup) return false;
      if (seg && it.abcxyz !== seg) return false;

      if (status === 'order' && it.finalOrderQty <= 0) return false;
      if (status === 'outliers' && it.outlierMonths <= 0) return false;
      if (status === 'diff_v1' && it.deltaFromV1 === 0) return false;
      if (status === 'overstock' && !it.isOverstock) return false;
      if (status === 'critical' && !it.isCritical1C) return false;
      if (status === 'zero' && it.closingStock > 0) return false;
      if (status === 'manual' && it.manualOverride == null) return false;

      if (q) {
        const hay = `${it.excelRow} ${it.name} ${it.sku} ${it.supplier} ${it.group} ${it.warehouse} ${it.abcxyz}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const key = state.sortKey;
    const mult = state.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const va = a[key];
      const vb = b[key];
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va !== vb) return (va - vb) * mult;
        return a.excelRow - b.excelRow;
      }
      return String(va ?? '').localeCompare(String(vb ?? ''), 'ru') * mult;
    });

    state.filteredItems = list;
    el('cntTabTable').textContent = list.length;

    const maxPage = Math.max(1, Math.ceil(list.length / state.pageSize));
    if (state.page > maxPage) state.page = maxPage;
  }

  function renderTable() {
    const tbody = el('tableBody');
    const total = state.filteredItems.length;
    const maxPage = Math.max(1, Math.ceil(total / state.pageSize));
    const start = (state.page - 1) * state.pageSize;
    const slice = state.filteredItems.slice(start, start + state.pageSize);

    el('paginationInfo').textContent = total === 0
      ? 'Нет строк по выбранным фильтрам'
      : `Показаны строки ${start + 1}–${start + slice.length} из ${fmtInt(total)}`;
    el('lblPageNum').textContent = `${state.page} / ${maxPage}`;
    el('btnPrevPage').disabled = state.page <= 1;
    el('btnNextPage').disabled = state.page >= maxPage;

    if (slice.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:32px;color:var(--text-muted)">По заданным условиям фильтрации позиций не найдено</td></tr>`;
      return;
    }

    tbody.innerHTML = slice.map((it) => {
      const isSelected = it.excelRow === state.selectedExcelRow;
      const isManual = it.manualOverride != null;
      const seasonClass = it.horizonSeasonIdx >= 1.15 ? 'season-high'
        : it.horizonSeasonIdx <= 0.75 ? 'season-low' : 'season-mid';

      const qtyCls = [
        'qty-input',
        it.finalOrderQty > 0 ? 'has-order' : '',
        isManual ? 'is-manual' : '',
      ].filter(Boolean).join(' ');

      const badges = [
        it.isCritical1C ? `<span class="badge badge-red" title="Красная ячейка дефицита 1С">1С</span>` : '',
        it.outlierMonths > 0 ? `<span class="badge badge-warn" title="Подавлен разовый оптовый выброс в истории продаж (${it.outlierMonths} мес.)">⚡ опт</span>` : '',
        it.budgetTrimmedQty > 0 ? `<span class="badge badge-accent" title="Сокращено лимитом бюджета на ${it.budgetTrimmedQty} ед.">лимит</span>` : '',
      ].filter(Boolean).join(' ');

      const v1DiffStyle = it.deltaFromV1 < 0 ? 'color:var(--success);font-weight:600'
        : it.deltaFromV1 > 0 ? 'color:var(--warn);font-weight:600' : 'color:var(--text-muted)';

      return `<tr data-row="${it.excelRow}" class="${isSelected ? 'selected-row' : ''}">
        <td class="num-col" style="color:var(--text-muted)">${it.excelRow}</td>
        <td>
          <div class="wh-line">${esc(it.warehouse)}</div>
          <div class="grp-line">${esc(it.group)}</div>
        </td>
        <td>
          <div class="item-title">${badges ? badges + ' ' : ''}${esc(it.name)}</div>
          <div class="item-sub">${it.sku ? `Арт: ${esc(it.sku)} • ` : ''}${esc(it.unit)} • 3г: ${fmtInt(it.sumSalesAll)} • Приоритет: ${it.priorityScore.toFixed(0)}</div>
        </td>
        <td class="center-col"><span class="abc-pill abc-${esc(it.abcClass)}" style="width:auto;padding:0 5px">${esc(it.abcxyz)}</span></td>
        <td class="num-col">${fmtInt(it.sumSalesLast12M)}</td>
        <td class="num-col"><span class="season-tag ${seasonClass}">×${it.horizonSeasonIdx.toFixed(2)}</span></td>
        <td class="num-col">${fmtNum(it.targetStock, 1)}</td>
        <td class="num-col ${it.closingStock <= 0 ? 'stock-crit' : ''}">${fmtInt(it.closingStock)}</td>
        <td class="num-col order-cell" onclick="event.stopPropagation()">
          <div class="qty-editor">
            ${isManual ? `<button class="reset-cell-btn" data-reset="${it.excelRow}" title="Вернуть авторасчёт Варианта 2 (${it.autoOrderQty})">↺</button>` : ''}
            <input type="number" min="0" step="1" class="${qtyCls}" value="${it.finalOrderQty}" data-qty-row="${it.excelRow}" />
          </div>
        </td>
        <td class="num-col" style="${v1DiffStyle}" title="Разница Вариант 2 − Вариант 1: ${it.deltaFromV1 > 0 ? '+' : ''}${it.deltaFromV1} ед.">${fmtInt(it.variant1OrderQty)}</td>
        <td class="num-col">${fmtMoney(it.purchasePrice)}</td>
        <td class="num-col" style="font-weight:${it.orderCost > 0 ? '700' : '400'}">${it.orderCost > 0 ? fmtMoney(it.orderCost) : '—'}</td>
        <td style="max-width:175px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.supplier)}">${esc(it.supplier || '—')}</td>
      </tr>`;
    }).join('');
  }

  function renderInspector() {
    if (!state.report || state.selectedExcelRow == null) return;
    const item = state.report.items.find((x) => x.excelRow === state.selectedExcelRow);
    if (!item) {
      el('inspectorPlaceholder').classList.remove('hidden');
      el('inspectorContent').classList.add('hidden');
      return;
    }

    el('inspectorPlaceholder').classList.add('hidden');
    const box = el('inspectorContent');
    box.classList.remove('hidden');

    const groupObj = state.report.groups.find((g) => g.group === item.group);
    const groupIndices = groupObj ? groupObj.monthlyIndices : Array(12).fill(1);

    box.innerHTML = `
      <div class="ins-head">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span class="badge badge-accent">Строка Excel #${item.excelRow} (H${item.excelRow})</span>
          <span class="badge badge-v2">Сегмент ${esc(item.abcxyz)} • SLA ${item.effectiveSafety.toFixed(0)}%</span>
        </div>
        <h3>${esc(item.name)}</h3>
        <div class="item-sub">${esc(item.warehouse)} • ${esc(item.group)} • Поставщик: <strong>${esc(item.supplier || 'не указан')}</strong></div>
      </div>

      <div class="ins-metrics">
        <div class="ins-metric">
          <span>Вариант 2 «К закупкам»</span>
          <strong style="color:var(--primary);font-size:19px">${fmtInt(item.finalOrderQty)} ${esc(item.unit)}</strong>
        </div>
        <div class="ins-metric">
          <span>Сравнение с Вариантом 1</span>
          <strong>${fmtInt(item.variant1OrderQty)} ${esc(item.unit)} (${item.deltaFromV1 >= 0 ? '+' : ''}${item.deltaFromV1})</strong>
        </div>
        <div class="ins-metric">
          <span>Остаток / Запас в днях</span>
          <strong>${fmtInt(item.closingStock)} ${esc(item.unit)} (${item.daysOfSupply >= 900 ? '365+' : Math.round(item.daysOfSupply)} дн.)</strong>
        </div>
        <div class="ins-metric">
          <span>Сумма закупки (Приоритет ${item.priorityScore.toFixed(0)})</span>
          <strong>${fmtMoney(item.orderCost)} руб.</strong>
        </div>
      </div>

      <div class="explain-box">
        <strong>Расчёт Варианта 2:</strong> ${esc(item.explanation)}
      </div>

      <div class="chart-block">
        <h4>История продаж (${state.report.periods.length} мес.) ${item.outlierMonths > 0 ? '• красная верхушка = отсечённый опт-выброс' : ''}</h4>
        ${buildHistoryBarSVG(item.monthlySales, item.cappedSales, state.report.periods)}
      </div>

      <div class="chart-block">
        <h4>Прогноз спроса Варианта 2 по 12 месяцам года (ед./мес.)</h4>
        ${buildTwelveMonthSVG(item.monthlyForecast12, groupIndices)}
      </div>
    `;
  }

  function buildHistoryBarSVG(rawSales, cappedSales, periods) {
    const W = 356, H = 138, padL = 28, padR = 8, padT = 10, padB = 24;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const maxV = Math.max(1, ...rawSales);
    const n = Math.max(1, rawSales.length);
    const step = innerW / n;
    const barW = Math.max(2, step - 2);

    const bars = rawSales.map((v, i) => {
      const capV = cappedSales?.[i] ?? v;
      const p = periods[i] || {};
      const m = p.month || 1;
      const x = padL + i * step + 1;

      const hRaw = (v / maxV) * innerH;
      const yRaw = padT + innerH - hRaw;
      const hCap = (Math.min(v, capV) / maxV) * innerH;
      const yCap = padT + innerH - hCap;

      let fill = '#3b82f6';
      if (m >= 3 && m <= 5) fill = '#10b981';
      else if (m >= 6 && m <= 8) fill = '#f59e0b';
      else if (m >= 9 && m <= 11) fill = '#6366f1';

      const isOutlier = v > capV + 0.01;
      const tip = isOutlier
        ? `${p.label || ''}: факт ${v} (разовый опт → сглажено до ${capV})`
        : `${p.label || ''}: ${v}`;

      return `
        ${isOutlier ? `<rect x="${x.toFixed(1)}" y="${yRaw.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, hRaw).toFixed(1)}" rx="1.5" fill="#ef4444" opacity="0.85"><title>${esc(tip)}</title></rect>` : ''}
        <rect x="${x.toFixed(1)}" y="${yCap.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(v > 0 ? 2 : 0, hCap).toFixed(1)}" rx="1.5" fill="${fill}"><title>${esc(tip)}</title></rect>
      `;
    }).join('');

    const yearLabels = periods.map((p, i) => {
      if (p.month === 1 || i === 0 || i === periods.length - 1) {
        const x = padL + i * step + barW / 2;
        const shortLbl = p.month === 1 ? String(p.year) : `${MONTH_SHORT[(p.month || 1) - 1]}'${String(p.year).slice(-2)}`;
        return `<text x="${x.toFixed(1)}" y="${H - 6}" font-size="9.5" text-anchor="middle" fill="var(--text-muted)">${esc(shortLbl)}</text>`;
      }
      return '';
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--border)" stroke-dasharray="2,2"/>
      <line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--border-strong)"/>
      <text x="${padL - 4}" y="${padT + 8}" font-size="9.5" text-anchor="end" fill="var(--text-muted)">${fmtInt(maxV)}</text>
      <text x="${padL - 4}" y="${padT + innerH}" font-size="9.5" text-anchor="end" fill="var(--text-muted)">0</text>
      ${bars}
      ${yearLabels}
    </svg>`;
  }

  function buildTwelveMonthSVG(forecast12, groupIdx12) {
    const W = 356, H = 126, padL = 28, padR = 8, padT = 14, padB = 22;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const maxV = Math.max(0.5, ...forecast12);
    const step = innerW / 12;

    const pts = forecast12.map((v, m) => ({
      x: padL + m * step + step / 2,
      y: padT + innerH - (v / maxV) * innerH,
      v,
      g: groupIdx12[m] || 1,
    }));

    const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${pts[0].x.toFixed(1)},${(padT + innerH).toFixed(1)} ${poly} ${pts[11].x.toFixed(1)},${(padT + innerH).toFixed(1)}`;

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      <polygon points="${area}" fill="rgba(16,185,129,0.16)"/>
      <polyline points="${poly}" fill="none" stroke="var(--success)" stroke-width="2.2"/>
      ${pts.map((p, m) => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.3" fill="var(--success)">
          <title>${MONTH_SHORT[m]}: прогноз ${p.v.toFixed(2)} ед./мес. (индекс группы ×${p.g.toFixed(2)})</title>
        </circle>
        <text x="${p.x.toFixed(1)}" y="${H - 6}" font-size="9.5" text-anchor="middle" fill="var(--text-muted)">${MONTH_SHORT[m]}</text>
      `).join('')}
      <text x="${padL - 4}" y="${padT + 6}" font-size="9.5" text-anchor="end" fill="var(--text-muted)">${maxV.toFixed(1)}</text>
      <text x="${padL - 4}" y="${padT + innerH}" font-size="9.5" text-anchor="end" fill="var(--text-muted)">0</text>
    </svg>`;
  }

  function renderDiffView(rep) {
    const diffs = rep.items
      .filter((it) => it.deltaFromV1 !== 0)
      .sort((a, b) => Math.abs(b.deltaFromV1 * b.purchasePrice) - Math.abs(a.deltaFromV1 * a.purchasePrice));

    const savedRub = rep.variant1OrderCost - rep.totalOrderCost;
    el('diffSummaryBlock').innerHTML = `
      <h3>Прямое сравнение сборок: «Вариант 2 (PRO SCM)» vs «Вариант 1»</h3>
      <p class="muted">«Вариант 1» сохранён в репозитории и GitHub Actions как отдельный эталонный дистрибутив. Ниже показано, как фильтрация разовых оптовых сделок, метод Croston/SBA для редких позиций и адаптивный SLA уточнили заказ по <strong>${diffs.length}</strong> строкам (экономия оборотных средств: <strong style="color:var(--success)">${fmtMoney(savedRub)} руб.</strong>, с ${fmtMoney(rep.variant1OrderCost)} до ${fmtMoney(rep.totalOrderCost)} руб.).</p>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num-col">Стр.</th>
              <th>Склад</th>
              <th>Номенклатура</th>
              <th class="center-col">ABC-XYZ</th>
              <th class="num-col">Вариант 1</th>
              <th class="num-col">Вариант 2</th>
              <th class="num-col">Разница</th>
              <th class="num-col">Эффект (руб.)</th>
              <th>Причина корректировки</th>
            </tr>
          </thead>
          <tbody>
            ${diffs.slice(0, 120).map((it) => {
              const effRub = it.deltaFromV1 * it.purchasePrice;
              const reason = it.outlierMonths > 0
                ? `Подавлен разовый оптовый выброс (${it.outlierMonths} мес.)`
                : it.budgetTrimmedQty > 0
                  ? `Оптимизация под лимит бюджета (−${it.budgetTrimmedQty} ед.)`
                  : it.xyzClass === 'Z' && it.deltaFromV1 < 0
                    ? `Эпизодический спрос Z (демпфирование Croston/SBA)`
                    : it.deltaFromV1 > 0
                      ? `Усиление страхового SLA ходового сегмента ${it.abcxyz}`
                      : `Снижение избыточного SLA для сегмента ${it.abcxyz}`;
              return `<tr data-jump-row="${it.excelRow}">
                <td class="num-col">${it.excelRow}</td>
                <td>${esc(it.warehouse)}</td>
                <td><strong>${esc(it.name)}</strong></td>
                <td class="center-col"><span class="abc-pill abc-${esc(it.abcClass)}" style="width:auto;padding:0 5px">${esc(it.abcxyz)}</span></td>
                <td class="num-col">${fmtInt(it.variant1OrderQty)}</td>
                <td class="num-col"><strong>${fmtInt(it.finalOrderQty)}</strong></td>
                <td class="num-col" style="font-weight:700;color:${it.deltaFromV1 < 0 ? 'var(--success)' : 'var(--warn)'}">${it.deltaFromV1 > 0 ? '+' : ''}${it.deltaFromV1}</td>
                <td class="num-col" style="font-weight:700;color:${effRub < 0 ? 'var(--success)' : 'var(--warn)'}">${effRub > 0 ? '+' : ''}${fmtMoney(effRub)} р.</td>
                <td>${esc(reason)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderSeasonalityView(rep) {
    const container = el('seasonalityContainer');
    const matrixDesc = {
      AX: 'Стабильные лидеры оборота (SLA ×1.25)',
      AY: 'Сезонные лидеры оборота (SLA ×1.15)',
      AZ: 'Крупные нерегулярные продажи (SLA ×0.95)',
      BX: 'Стабильный средний спрос (SLA ×1.10)',
      BY: 'Сезонный средний спрос (SLA ×1.00)',
      BZ: 'Прерывистый средний спрос (Croston SBA)',
      CX: 'Регулярная мелочь / расходники',
      CY: 'Сезонная мелочь',
      CZ: 'Штучный эпизодический спрос (SLA ×0.50)',
    };

    const matrixCards = rep.matrixABCXYZ.flat().map((c) => `
      <div class="matrix-cell" data-matrix-seg="${esc(c.code)}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="badge badge-v2" style="font-size:12.5px">${esc(c.code)}</span>
          <span style="font-weight:700">${fmtInt(c.itemCount)} SKU</span>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin:5px 0 8px">${esc(matrixDesc[c.code] || '')}</div>
        <div style="font-size:12.5px">К закупке: <strong>${fmtInt(c.orderItems)} поз.</strong> (${fmtInt(c.orderUnits)} ед.) • <strong>${fmtMoney(c.orderCost)} р.</strong></div>
      </div>
    `).join('');

    const matrixRows = rep.groups.map((g) => {
      const cells = g.monthlyIndices.map((idx) => {
        let bg = 'transparent';
        if (idx >= 1.35) bg = 'rgba(245, 158, 11, 0.25)';
        else if (idx >= 1.10) bg = 'rgba(16, 185, 129, 0.18)';
        else if (idx <= 0.55) bg = 'rgba(59, 130, 246, 0.20)';
        return `<td style="background:${bg};font-weight:${idx >= 1.25 || idx <= 0.55 ? '700' : '500'}">×${idx.toFixed(2)}</td>`;
      }).join('');
      return `<tr>
        <td>${esc(g.group)}</td>
        ${cells}
        <td><strong>×${g.horizonIndex.toFixed(2)}</strong></td>
        <td class="num-col"><strong>${fmtMoney(g.totalCost)} р.</strong></td>
      </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="card-block">
        <h3>Интерактивная матрица ABC × XYZ ассортимента (нажмите на сегмент для фильтрации ведомости)</h3>
        <p class="muted">Объединяет вклад товара в оборот магазина (A — 80%, B — 15%, C — 5%) с предсказуемостью спроса (X — стабильный, Y — сезонный, Z — эпизодический).</p>
        <div class="matrix-grid-3x3">${matrixCards}</div>
      </div>

      <div class="card-block">
        <h3>Очищенная от оптовых выбросов матрица сезонных индексов групп (среднегодовой = ×1.00)</h3>
        <p class="muted">В «Варианте 2» разовые оптовые аномалии больше не искажают сезонные коэффициенты группы (например, индекс ноября по фурнитуре очищен от разовой партии 1 100 гаражных петель).</p>
        <div style="overflow-x:auto">
          <table class="season-matrix">
            <thead>
              <tr>
                <th>Группа номенклатуры</th>
                ${MONTH_SHORT.map((m) => `<th>${m}</th>`).join('')}
                <th>Горизонт</th>
                <th>Бюджет v2</th>
              </tr>
            </thead>
            <tbody>${matrixRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderSuppliersView(rep) {
    el('warehousesContainer').innerHTML = rep.warehouses.map((w) => `
      <div class="card-block">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <h3>${esc(w.warehouse)}</h3>
            <p class="muted" style="margin-bottom:8px">Всего: ${fmtInt(w.totalItems)} SKU • 0 остаток: ${fmtInt(w.zeroStockItems)} • Неликвидов: ${fmtInt(w.overstockItems)} (${fmtMoney(w.overstockCost)} р.)</p>
          </div>
          <a class="btn btn-secondary btn-sm" href="api/export/orders?warehouse=${encodeURIComponent(w.warehouse)}" style="text-decoration:none">
            Отчёт склада (.xlsx)
          </a>
        </div>
        <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:4px">
          <div><span class="field-hint">Позиций к закупке</span><div style="font-size:18px;font-weight:700">${fmtInt(w.orderItems)} SKU</div></div>
          <div><span class="field-hint">Единиц товара</span><div style="font-size:18px;font-weight:700;color:var(--primary)">${fmtInt(w.totalOrderQty)} ед.</div></div>
          <div><span class="field-hint">Сумма закупки</span><div style="font-size:18px;font-weight:700">${fmtMoney(w.totalOrderCost)} руб.</div></div>
          <div><span class="field-hint">Оценка в рознице</span><div style="font-size:18px;font-weight:700;color:var(--success)">${fmtMoney(w.totalRetailVal)} руб.</div></div>
        </div>
      </div>
    `).join('');

    el('suppliersBody').innerHTML = rep.suppliers.map((s) => {
      const rawSupParam = s.supplier === '(Поставщик не указан)' ? '' : s.supplier;
      const statusBadge = s.orderItems === 0
        ? `<span class="badge" style="color:var(--text-muted)">Нет потребности</span>`
        : s.belowMinOrder
          ? `<span class="badge badge-warn">Мелкий заказ (&lt; ${fmtInt(rep.params.minSupplierOrder)} р.)</span>`
          : `<span class="badge badge-green">Готов к отправке (${s.shareOfBudget.toFixed(1)}%)</span>`;

      return `<tr>
        <td><strong>${esc(s.supplier)}</strong></td>
        <td class="num-col">${fmtInt(s.totalItems)}</td>
        <td class="num-col">${fmtInt(s.orderItems)}</td>
        <td class="num-col" style="font-weight:700;color:var(--primary)">${fmtInt(s.totalOrderQty)}</td>
        <td class="num-col" style="font-weight:700">${fmtMoney(s.totalOrderCost)} руб.</td>
        <td class="num-col">${fmtMoney(s.totalRetailVal)} руб.</td>
        <td class="center-col">${statusBadge}</td>
        <td class="right-col">
          <button class="btn btn-ghost btn-sm" data-filter-sup="${esc(s.supplier)}">В таблице</button>
          ${s.orderItems > 0 && rawSupParam ? `<a class="btn btn-secondary btn-sm" href="api/export/orders?supplier=${encodeURIComponent(rawSupParam)}" style="text-decoration:none">Заказ .xlsx</a>` : ''}
        </td>
      </tr>`;
    }).join('');
  }

  function renderOverstockView(rep) {
    const over = rep.items
      .filter((it) => it.isOverstock)
      .sort((a, b) => b.overstockValue - a.overstockValue);

    el('overstockContainer').innerHTML = `
      <h3>Радар замороженного капитала и неликвидов (&gt; 365 дней продаж или 0 продаж за 12 мес.)</h3>
      <p class="muted">Выявлено <strong>${over.length} позиций</strong> со сверхнормативным запасом на сумму <strong style="color:var(--warn)">${fmtMoney(rep.overstockFrozenCost)} руб.</strong> (в закупочных ценах сверх годовой потребности). Рекомендуется промо-выкладка, скидка или межскладской обмен.</p>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num-col">Стр.</th>
              <th>Склад</th>
              <th>Номенклатура</th>
              <th>Поставщик</th>
              <th class="num-col">Остаток</th>
              <th class="num-col">Продажи 12м</th>
              <th class="num-col">Цена зак.</th>
              <th class="num-col">Заморожено сверх года</th>
            </tr>
          </thead>
          <tbody>
            ${over.slice(0, 150).map((it) => `<tr data-jump-row="${it.excelRow}">
              <td class="num-col">${it.excelRow}</td>
              <td>${esc(it.warehouse)}</td>
              <td><strong>${esc(it.name)}</strong></td>
              <td>${esc(it.supplier || '—')}</td>
              <td class="num-col"><strong>${fmtInt(it.closingStock)} ${esc(it.unit)}</strong></td>
              <td class="num-col">${fmtInt(it.sumSalesLast12M)}</td>
              <td class="num-col">${fmtMoney(it.purchasePrice)}</td>
              <td class="num-col" style="color:var(--warn);font-weight:700">${fmtMoney(it.overstockValue)} руб.</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function collectParamsFromUI() {
    return {
      planStartDate: el('inpStartDate').value || '',
      normalizePartialLast: el('chkNormalizeLast').checked,
      lastMonthDaysElapsed: 0,
      horizonDays: Number(el('inpHorizon').value) || 30,
      leadTimeDays: Number(el('inpLeadTime').value) || 0,
      safetyStockPct: Number(el('inpSafety').value) || 0,
      seasonMode: el('selSeasonMode').value,
      recencyDecay: Number(el('inpDecay').value) || 0.65,
      shrinkageK: 12,
      minDisplayStock: Number(el('selMinDisplay').value) || 0,
      rounding: el('selRounding').value,
      writeZeroValues: el('chkWriteZeros').checked,
      columnHeader: el('inpHeaderName').value.trim() || 'К закупкам',
      outlierFilter: el('chkOutlierFilter').checked,
      useCrostonZ: el('chkCrostonZ').checked,
      adaptiveSafetySLA: el('chkAdaptiveSLA').checked,
      budgetCap: Number(el('inpBudgetCap').value) || 0,
      minSupplierOrder: Number(el('inpMinSupplier').value) || 0,
      packMultiple: Number(el('selPackMultiple').value) || 1,
    };
  }

  function scheduleRecalculate() {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(async () => {
      try {
        const env = await apiPost('api/params', collectParamsFromUI());
        applyEnvelope(env);
      } catch (err) {
        showToast(err.message);
      }
    }, 110);
  }

  async function uploadExcelFile(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    showToast(`Загрузка и расчёт «${file.name}»…`);
    try {
      const res = await fetch('api/upload', { method: 'POST', body: fd });
      const env = await res.json();
      if (!res.ok) throw new Error(env.error || 'Ошибка загрузки файла');
      state.selectedExcelRow = null;
      state.page = 1;
      applyEnvelope(env);
      showToast(`Готово! Столбец 8 рассчитан (Вариант 2) для ${fmtInt(env.report.totalItems)} позиций`);
    } catch (err) {
      showToast(err.message);
    }
  }

  function bindEvents() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.activeTab}`));
      });
    });

    document.querySelectorAll('.preset-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.preset-chip').forEach((c) => c.classList.toggle('active', c === chip));
        const preset = chip.dataset.preset;
        el('chkOutlierFilter').checked = true;
        el('chkCrostonZ').checked = true;
        el('chkAdaptiveSLA').checked = true;
        el('inpBudgetCap').value = 0;

        if (preset === 'short') {
          el('inpHorizon').value = 14;
          el('inpLeadTime').value = 3;
          el('inpSafety').value = 15;
          el('inpStartDate').value = '';
        } else if (preset === 'standard') {
          el('inpHorizon').value = 30;
          el('inpLeadTime').value = 7;
          el('inpSafety').value = 20;
          el('inpStartDate').value = '';
        } else if (preset === 'budget5k') {
          el('inpHorizon').value = 30;
          el('inpLeadTime').value = 7;
          el('inpSafety').value = 20;
          el('inpBudgetCap').value = 5000;
          el('inpStartDate').value = '';
        } else if (preset === 'twomonths') {
          el('inpHorizon').value = 60;
          el('inpLeadTime').value = 7;
          el('inpSafety').value = 20;
          el('inpStartDate').value = '';
        } else if (preset === 'spring') {
          const baseYear = (state.report?.periods?.at(-1)?.year || 2026) + 1;
          el('inpStartDate').value = `${baseYear}-03-01`;
          el('inpHorizon').value = 60;
          el('inpLeadTime').value = 10;
          el('inpSafety').value = 25;
        } else if (preset === 'emulate_v1') {
          el('inpHorizon').value = 30;
          el('inpLeadTime').value = 7;
          el('inpSafety').value = 20;
          el('inpStartDate').value = '';
          el('chkOutlierFilter').checked = false;
          el('chkCrostonZ').checked = false;
          el('chkAdaptiveSLA').checked = false;
        }
        el('selSeasonMode').value = 'hybrid';
        scheduleRecalculate();
      });
    });

    el('btnToggleAdvanced').addEventListener('click', () => {
      el('paramsBody').classList.toggle('hidden');
    });

    ['inpHorizon', 'inpLeadTime', 'inpSafety', 'inpDecay'].forEach((id) => {
      el(id).addEventListener('input', () => {
        el('lblHorizon').textContent = el('inpHorizon').value;
        el('lblLeadTime').textContent = el('inpLeadTime').value;
        el('lblSafety').textContent = `${el('inpSafety').value}%`;
        el('lblDecay').textContent = Number(el('inpDecay').value).toFixed(2);
        scheduleRecalculate();
      });
    });
    [
      'inpStartDate', 'inpBudgetCap', 'inpMinSupplier', 'selSeasonMode',
      'selPackMultiple', 'selMinDisplay', 'selRounding', 'chkOutlierFilter',
      'chkCrostonZ', 'chkAdaptiveSLA', 'chkNormalizeLast', 'chkWriteZeros', 'inpHeaderName',
    ].forEach((id) => {
      el(id).addEventListener('change', scheduleRecalculate);
    });

    el('btnResetParams').addEventListener('click', async () => {
      const env = await apiPost('api/params', {
        planStartDate: '',
        normalizePartialLast: true,
        horizonDays: 30,
        leadTimeDays: 7,
        safetyStockPct: 20,
        seasonMode: 'hybrid',
        recencyDecay: 0.65,
        shrinkageK: 12,
        minDisplayStock: 0,
        rounding: 'nearest',
        writeZeroValues: true,
        columnHeader: 'К закупкам',
        outlierFilter: true,
        useCrostonZ: true,
        adaptiveSafetySLA: true,
        budgetCap: 0,
        minSupplierOrder: 50,
        packMultiple: 1,
      });
      applyEnvelope(env);
      showToast('Восстановлены оптимальные настройки «Варианта 2»');
    });

    el('inpSearch').addEventListener('input', () => {
      state.page = 1;
      recomputeFilteredList();
      renderTable();
    });
    ['fltWarehouse', 'fltGroup', 'fltSupplier', 'fltABCXYZ', 'fltStatus'].forEach((id) => {
      el(id).addEventListener('change', () => {
        state.page = 1;
        recomputeFilteredList();
        renderTable();
      });
    });

    document.querySelectorAll('#itemsTable thead th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          state.sortKey = key;
          state.sortDir = typeof state.report?.items?.[0]?.[key] === 'number' ? 'desc' : 'asc';
        }
        recomputeFilteredList();
        renderTable();
      });
    });

    el('tableBody').addEventListener('click', async (e) => {
      const resetBtn = e.target.closest('[data-reset]');
      if (resetBtn) {
        const rowNum = Number(resetBtn.dataset.reset);
        const env = await apiPost('api/override', { excelRow: rowNum, clear: true });
        applyEnvelope(env);
        showToast(`Строка #${rowNum}: возвращён авторасчёт Варианта 2`);
        return;
      }
      const tr = e.target.closest('tr[data-row]');
      if (tr) {
        state.selectedExcelRow = Number(tr.dataset.row);
        renderTable();
        renderInspector();
      }
    });

    el('tableBody').addEventListener('change', async (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      const rowNum = Number(inp.dataset.qtyRow);
      const val = Math.max(0, Math.round(Number(inp.value) || 0));
      state.selectedExcelRow = rowNum;
      const env = await apiPost('api/override', { excelRow: rowNum, value: val });
      applyEnvelope(env);
      showToast(`Строка Excel #${rowNum}: столбец 8 = ${val}`);
    });

    el('btnClearOverrides').addEventListener('click', async () => {
      const env = await apiPost('api/override', { clearAll: true });
      applyEnvelope(env);
      showToast('Все ручные корректировки сброшены');
    });

    // Переход по клику на ячейку ABC-XYZ или строку в Diff/Overstock вкладках
    document.body.addEventListener('click', (e) => {
      const segCard = e.target.closest('[data-matrix-seg]');
      if (segCard) {
        el('fltABCXYZ').value = segCard.dataset.matrixSeg;
        state.page = 1;
        recomputeFilteredList();
        renderTable();
        document.querySelector('.tab-btn[data-tab="table"]').click();
        return;
      }
      const jumpRow = e.target.closest('tr[data-jump-row]');
      if (jumpRow) {
        const rNum = Number(jumpRow.dataset.jumpRow);
        state.selectedExcelRow = rNum;
        el('inpSearch').value = String(rNum);
        state.page = 1;
        recomputeFilteredList();
        renderTable();
        renderInspector();
        document.querySelector('.tab-btn[data-tab="table"]').click();
      }
    });

    el('suppliersBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter-sup]');
      if (!btn) return;
      el('fltSupplier').value = btn.dataset.filterSup;
      state.page = 1;
      recomputeFilteredList();
      renderTable();
      document.querySelector('.tab-btn[data-tab="table"]').click();
    });

    el('selPageSize').addEventListener('change', () => {
      state.pageSize = Number(el('selPageSize').value) || 100;
      state.page = 1;
      renderTable();
    });
    el('btnPrevPage').addEventListener('click', () => {
      if (state.page > 1) { state.page--; renderTable(); }
    });
    el('btnNextPage').addEventListener('click', () => {
      state.page++;
      renderTable();
    });

    el('btnUpload').addEventListener('click', () => el('fileInput').click());
    el('fileInput').addEventListener('change', (e) => {
      uploadExcelFile(e.target.files?.[0]);
      e.target.value = '';
    });

    el('btnDownloadXlsx').addEventListener('click', () => {
      window.location.href = 'api/export/xlsx';
    });

    el('btnDownloadOrders').addEventListener('click', () => {
      const wh = el('fltWarehouse').value;
      const sup = el('fltSupplier').value;
      const qs = new URLSearchParams();
      if (wh) qs.set('warehouse', wh);
      if (sup && sup !== '(Поставщик не указан)') qs.set('supplier', sup);
      const qStr = qs.toString();
      window.location.href = qStr ? `api/export/orders?${qStr}` : 'api/export/orders';
    });

    el('btnPrintOrder').addEventListener('click', () => {
      el('fltStatus').value = 'order';
      state.pageSize = 2000;
      el('selPageSize').value = '2000';
      state.page = 1;
      recomputeFilteredList();
      renderTable();
      document.querySelector('.tab-btn[data-tab="table"]').click();
      setTimeout(() => window.print(), 100);
    });

    el('btnSaveInPlace').addEventListener('click', async () => {
      try {
        const res = await apiPost('api/save-inplace', {});
        showToast(`Сохранено в «${res.filePath}» (${res.items} поз., ${res.units} ед. в столбце 8)`);
      } catch (err) {
        showToast(err.message);
      }
    });

    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      el('dropOverlay').classList.remove('hidden');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) el('dropOverlay').classList.add('hidden');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      el('dropOverlay').classList.add('hidden');
      const f = e.dataTransfer?.files?.[0];
      if (f) uploadExcelFile(f);
    });

    el('btnHelp').addEventListener('click', () => el('helpModal').classList.remove('hidden'));
    el('btnCloseHelp').addEventListener('click', () => el('helpModal').classList.add('hidden'));
    el('helpModal').addEventListener('click', (e) => {
      if (e.target === el('helpModal')) el('helpModal').classList.add('hidden');
    });

    const savedTheme = localStorage.getItem('ostatki2_theme');
    if (savedTheme === 'dark') document.documentElement.dataset.theme = 'dark';
    el('btnTheme').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('ostatki2_theme', next);
    });

    setInterval(() => {
      fetch('api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
    }, 3000);
    window.addEventListener('pagehide', () => {
      if (state.desktopMode && navigator.sendBeacon) {
        navigator.sendBeacon('api/shutdown', '{}');
      }
    });
  }

  async function bootstrap() {
    bindEvents();
    try {
      const env = await apiGet('api/state');
      applyEnvelope(env);
    } catch (err) {
      el('fileMetaLine').textContent = 'Откройте или перетащите файл Ведомости (.xlsx) для начала работы';
      showToast(err.message);
    }
  }

  bootstrap();
})();
