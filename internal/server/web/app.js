(() => {
  'use strict';

  const state = {
    report: null,
    canSaveInPlace: false,
    desktopMode: false,
    planStartDate: '',
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

  function fmtRetail(it) {
    if (it.retailPrice > 0 || (it.retailRaw && it.retailRaw.trim() !== '')) {
      return fmtMoney(it.retailPrice);
    }
    return '';
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

  function cleanFilenamePart(raw) {
    const s = String(raw ?? '').trim();
    let out = '';
    let openQuote = true;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        if (openQuote) {
          if (i > 0 && s[i - 1] !== ' ') out += ' ';
          out += '«';
        } else {
          out += '»';
        }
        openQuote = !openQuote;
      } else {
        out += ch;
      }
    }
    return out
      .replace(/[\/\\]/g, '_')
      .replace(/:/g, '-')
      .replace(/[*?<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatOrderFileName(warehouse, supplier) {
    const wh = cleanFilenamePart(warehouse) || 'Все склады';
    const sup = cleanFilenamePart(supplier) || 'Поставщик не указан';
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    return `${wh}, ${sup}, ${dd}.${mm}.${yyyy}.xlsx`;
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
    renderSuppliersView(state.report);
    renderOverstockView(state.report);
  }

  function syncParamsControls(rep) {
    const p = rep.params;
    state.planStartDate = p.planStartDate || '';
    el('inpHorizon').value = p.horizonDays;
    el('inpLeadTime').value = p.leadTimeDays;
    el('inpSafety').value = p.safetyStockPct;
    el('inpBudgetCap').value = p.budgetCap || 0;
    el('inpMinSupplier').value = p.minSupplierOrder ?? 50;
    el('selSeasonMode').value = p.seasonMode;
    el('selPackMultiple').value = String(p.packMultiple || 1);
    el('selMinDisplay').value = String(p.minDisplayStock || 0);
    el('chkOutlierFilter').checked = Boolean(p.outlierFilter);
    el('chkCrostonZ').checked = Boolean(p.useCrostonZ);
    el('chkAdaptiveSLA').checked = Boolean(p.adaptiveSafetySLA);
    el('chkNormalizeLast').checked = Boolean(p.normalizePartialLast);
    el('chkWriteZeros').checked = Boolean(p.writeZeroValues);

    el('hintBudget').textContent = p.budgetCap > 0
      ? `Срезано лимитом: ${fmtInt(rep.budgetTrimmedUnits)} ед. (без лимита: ${fmtMoney(rep.uncappedOrderCost)} р.)`
      : '0 — без ограничения бюджета';
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
    // Уникальные поставщики для выпадающего фильтра на вкладке «Ведомость»
    const supAgg = new Map();
    for (const s of rep.suppliers) {
      const prev = supAgg.get(s.supplier);
      if (!prev) {
        supAgg.set(s.supplier, { value: s.supplier, supplier: s.supplier, totalOrderCost: s.totalOrderCost, orderItems: s.orderItems });
      } else {
        prev.totalOrderCost += s.totalOrderCost;
        prev.orderItems += s.orderItems;
      }
    }
    const uniqueSuppliers = [...supAgg.values()].sort((a, b) => b.totalOrderCost - a.totalOrderCost || a.supplier.localeCompare(b.supplier, 'ru'));

    keepSet(
      el('fltSupplier'),
      uniqueSuppliers,
      'Все поставщики',
      (s) => `${s.supplier} — ${fmtMoney(s.totalOrderCost)} р. (${s.orderItems})`
    );
  }

  function renderKPIs(rep) {
    const firstP = rep.periods[0]?.label || '';
    const lastP = rep.periods[rep.periods.length - 1]?.label || '';
    el('fileMetaLine').textContent =
      `Файл: ${rep.fileName} • Срез: ${rep.createdDate || 'н/д'} • Статистика: ${firstP} — ${lastP} (${rep.periods.length} мес.) • Позиций: ${fmtInt(rep.totalItems)} (к закупке: ${fmtInt(rep.orderItemsCount)} SKU / ${fmtInt(rep.totalOrderUnits)} ед.)`;

    el('kpiOrderCost').textContent = `${fmtMoney(rep.totalOrderCost)} руб.`;
    const activeSups = rep.suppliers.filter((s) => s.orderItems > 0).length;
    if (rep.params.budgetCap > 0) {
      el('kpiBudgetInfo').textContent = `Лимит: ${fmtMoney(rep.params.budgetCap)} р. • Поставщиков: ${activeSups}`;
    } else {
      el('kpiBudgetInfo').textContent = `Активных поставщиков: ${activeSups} из ${rep.suppliers.length}`;
    }

    el('btnClearOverrides').classList.toggle('hidden', rep.manualOverrideCount === 0);
    el('cntTabSuppliers').textContent = activeSups;
    el('cntTabOverstock').textContent = rep.overstockItemsCount;
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
      if (seg !== '' && String(it.salesSegment) !== seg && it.salesSegmentLabel !== seg) return false;

      if (status === 'order' && it.finalOrderQty <= 0) return false;
      if (status === 'outliers' && it.outlierMonths <= 0) return false;
      if (status === 'overstock' && !it.isOverstock) return false;
      if (status === 'zero' && it.closingStock > 0) return false;
      if (status === 'manual' && it.manualOverride == null) return false;

      if (q) {
        const hay = `${it.name} ${it.sku} ${it.supplier} ${it.group} ${it.warehouse} ${it.salesSegmentLabel}`.toLowerCase();
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
  }

  function renderTable() {
    const tbody = el('tableBody');
    const total = state.filteredItems.length;
    const allTotal = state.report?.totalItems ?? total;
    const slice = state.filteredItems;

    // Сохраняем позицию скролла и активное поле ввода, если пользователь перешёл в соседнюю строку
    const prevScrollY = window.scrollY;
    const activeEl = document.activeElement;
    const activeQtyRow = activeEl?.dataset?.qtyRow ? Number(activeEl.dataset.qtyRow) : null;
    const activeFresh = activeEl?.dataset?.freshEdit;
    const activeDraft = activeEl?.dataset?.qtyRow ? activeEl.value : null;

    el('paginationInfo').textContent = total === 0
      ? 'Нет строк по выбранным фильтрам'
      : `Отображены все строки: ${fmtInt(total)} из ${fmtInt(allTotal)}`;

    if (slice.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:32px;color:var(--text-muted)">По заданным условиям фильтрации позиций не найдено</td></tr>`;
      return;
    }

    tbody.innerHTML = slice.map((it) => {
      const isSelected = it.excelRow === state.selectedExcelRow;
      const isManual = it.manualOverride != null;
      const hasAutoOrder = it.autoOrderQty > 0;
      const segNum = Number(it.salesSegment) || 0;
      const segLabel = it.salesSegmentLabel || `${segNum}-Нет продаж`;
      const segTitle = `Рейтинг ${segLabel} • продажи за 6 мес.: ${fmtInt(it.sumSalesLast6M)}, за 12 мес.: ${fmtInt(it.sumSalesLast12M)}`;

      const rowCls = [
        hasAutoOrder ? 'auto-order-row' : '',
        isSelected ? 'selected-row' : '',
      ].filter(Boolean).join(' ');

      const qtyCls = [
        'qty-input',
        it.finalOrderQty > 0 ? 'has-order' : '',
        isManual ? 'is-manual' : '',
      ].filter(Boolean).join(' ');

      return `<tr data-row="${it.excelRow}" class="${rowCls}">
        <td class="wh-cell" title="${esc(it.warehouse)}">${esc(it.warehouse)}</td>
        <td class="grp-cell" title="${esc(it.group)}">${esc(it.group)}</td>
        <td class="sku-cell">${esc(it.sku)}</td>
        <td class="name-cell">${esc(it.name)}</td>
        <td class="unit-cell">шт.</td>
        <td class="seg-cell" title="${esc(segTitle)}"><span class="seg-pill seg-${segNum}">${segNum}</span></td>
        <td class="num-col col-5digits">${fmtInt(it.sumSalesLast12M)}</td>
        <td class="num-col col-5digits">${fmtInt(it.closingStock)}</td>
        <td class="num-col col-5digits order-cell" onclick="event.stopPropagation()">
          <div class="qty-editor">
            ${isManual ? `<button class="reset-cell-btn" data-reset="${it.excelRow}" title="Вернуть авторасчёт (${fmtInt(it.autoOrderQty)})">↺</button>` : ''}
            <input type="text" inputmode="numeric" autocomplete="off" class="${qtyCls}" value="${fmtInt(it.finalOrderQty)}" data-qty-row="${it.excelRow}" />
          </div>
        </td>
        <td class="num-col">${fmtMoney(it.purchasePrice)}</td>
        <td class="num-col">${fmtRetail(it)}</td>
        <td class="num-col" style="font-weight:${it.orderCost > 0 ? '700' : '400'}">${it.orderCost > 0 ? fmtMoney(it.orderCost) : '—'}</td>
        <td class="sup-cell" title="${esc(it.supplier)}">${esc(it.supplier || '')}</td>
      </tr>`;
    }).join('');

    if (activeQtyRow != null) {
      const nextInp = tbody.querySelector(`input[data-qty-row="${activeQtyRow}"]`);
      if (nextInp) {
        nextInp.focus({ preventScroll: true });
        if (activeFresh === '0' && activeDraft !== null) {
          nextInp.value = activeDraft;
          nextInp.dataset.freshEdit = '0';
          nextInp.setSelectionRange(nextInp.value.length, nextInp.value.length);
        } else {
          nextInp.select();
        }
      }
    }
    if (window.scrollY !== prevScrollY) {
      window.scrollTo(0, prevScrollY);
    }
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
      const orderQs = new URLSearchParams();
      if (s.warehouse) orderQs.set('warehouse', s.warehouse);
      if (s.supplier) orderQs.set('supplier', s.supplier);
      const orderHref = `api/export/supplier-order?${orderQs.toString()}`;
      const orderFileName = formatOrderFileName(s.warehouse, s.supplier);

      const statusBadge = s.orderItems === 0
        ? `<span class="badge" style="color:var(--text-muted)">Нет потребности</span>`
        : s.belowMinOrder
          ? `<span class="badge badge-warn">Мелкий заказ (&lt; ${fmtInt(rep.params.minSupplierOrder)} р.)</span>`
          : `<span class="badge badge-green">Готов к отправке (${s.shareOfBudget.toFixed(1)}%)</span>`;

      return `<tr>
        <td class="wh-cell" title="${esc(s.warehouse)}">${esc(s.warehouse)}</td>
        <td><strong>${esc(s.supplier)}</strong></td>
        <td class="num-col">${fmtInt(s.totalItems)}</td>
        <td class="num-col">${fmtInt(s.orderItems)}</td>
        <td class="num-col" style="font-weight:700;color:var(--primary)">${fmtInt(s.totalOrderQty)}</td>
        <td class="num-col" style="font-weight:700">${fmtMoney(s.totalOrderCost)} руб.</td>
        <td class="num-col">${fmtMoney(s.totalRetailVal)} руб.</td>
        <td class="center-col">${statusBadge}</td>
        <td class="right-col" style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" data-filter-sup="${esc(s.supplier)}" data-filter-wh="${esc(s.warehouse || '')}">В таблице</button>
          ${s.orderItems > 0 ? `<a class="btn btn-secondary btn-sm" href="${esc(orderHref)}" download="${esc(orderFileName)}" title="Скачать заказ: ${esc(orderFileName)}" style="text-decoration:none">Заказ .xlsx</a>` : ''}
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
      <div>
        <table class="data-table">
          <thead>
            <tr>
              <th class="wh-col">Склад</th>
              <th class="grp-col">Группа</th>
              <th>Артикул</th>
              <th class="col-name">Номенклатура</th>
              <th>Поставщик</th>
              <th class="num-col col-5digits">Продажи</th>
              <th class="num-col col-5digits">Остаток</th>
              <th class="num-col">Цена</th>
              <th class="num-col">Розница</th>
              <th class="num-col">Заморожено сверх года</th>
            </tr>
          </thead>
          <tbody>
            ${over.map((it) => `<tr data-jump-row="${it.excelRow}">
              <td class="wh-cell" title="${esc(it.warehouse)}">${esc(it.warehouse)}</td>
              <td class="grp-cell" title="${esc(it.group)}">${esc(it.group)}</td>
              <td class="sku-cell">${esc(it.sku)}</td>
              <td class="name-cell">${esc(it.name)}</td>
              <td>${esc(it.supplier || '')}</td>
              <td class="num-col col-5digits">${fmtInt(it.sumSalesLast12M)}</td>
              <td class="num-col col-5digits">${fmtInt(it.closingStock)}</td>
              <td class="num-col">${fmtMoney(it.purchasePrice)}</td>
              <td class="num-col">${fmtRetail(it)}</td>
              <td class="num-col" style="color:var(--warn);font-weight:700">${fmtMoney(it.overstockValue)} руб.</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function collectParamsFromUI() {
    const rawLead = el('inpLeadTime').value.trim();
    const rawSafety = el('inpSafety').value.trim();
    return {
      planStartDate: state.planStartDate || '',
      normalizePartialLast: el('chkNormalizeLast').checked,
      lastMonthDaysElapsed: 0,
      horizonDays: Number(el('inpHorizon').value) || 30,
      leadTimeDays: rawLead === '' ? 4 : Number(rawLead),
      safetyStockPct: rawSafety === '' ? 10 : Number(rawSafety),
      seasonMode: el('selSeasonMode').value,
      recencyDecay: state.report?.params?.recencyDecay ?? 0.65,
      shrinkageK: 12,
      minDisplayStock: Number(el('selMinDisplay').value) || 0,
      rounding: state.report?.params?.rounding || 'nearest',
      writeZeroValues: el('chkWriteZeros').checked,
      columnHeader: state.report?.params?.columnHeader || 'К закупкам',
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
      showToast(`Готово! Столбец 8 рассчитан для ${fmtInt(env.report.totalItems)} позиций`);
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
          el('inpSafety').value = 10;
          state.planStartDate = '';
        } else if (preset === 'standard') {
          el('inpHorizon').value = 30;
          el('inpLeadTime').value = 4;
          el('inpSafety').value = 10;
          state.planStartDate = '';
        } else if (preset === 'budget5k') {
          el('inpHorizon').value = 30;
          el('inpLeadTime').value = 4;
          el('inpSafety').value = 10;
          el('inpBudgetCap').value = 5000;
          state.planStartDate = '';
        } else if (preset === 'twomonths') {
          el('inpHorizon').value = 60;
          el('inpLeadTime').value = 4;
          el('inpSafety').value = 10;
          state.planStartDate = '';
        } else if (preset === 'spring') {
          const baseYear = (state.report?.periods?.at(-1)?.year || 2026) + 1;
          state.planStartDate = `${baseYear}-03-01`;
          el('inpHorizon').value = 60;
          el('inpLeadTime').value = 7;
          el('inpSafety').value = 15;
        }
        el('selSeasonMode').value = 'hybrid';
        scheduleRecalculate();
      });
    });

    el('btnToggleAdvanced').addEventListener('click', () => {
      el('paramsBody').classList.toggle('hidden');
    });

    [
      'inpHorizon', 'inpLeadTime', 'inpSafety',
      'inpBudgetCap', 'inpMinSupplier', 'selSeasonMode',
      'selPackMultiple', 'selMinDisplay', 'chkOutlierFilter',
      'chkCrostonZ', 'chkAdaptiveSLA', 'chkNormalizeLast', 'chkWriteZeros',
    ].forEach((id) => {
      const node = el(id);
      node.addEventListener('change', scheduleRecalculate);
      if (node.tagName === 'INPUT' && node.type !== 'checkbox') {
        node.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            scheduleRecalculate();
          }
        });
      }
    });

    el('btnResetParams').addEventListener('click', async () => {
      state.planStartDate = '';
      const env = await apiPost('api/params', {
        planStartDate: '',
        normalizePartialLast: true,
        horizonDays: 30,
        leadTimeDays: 4,
        safetyStockPct: 10,
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
      showToast('Восстановлены настройки по умолчанию');
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
        showToast('Возвращён авторасчёт заказа');
        return;
      }
      const tr = e.target.closest('tr[data-row]');
      if (tr) {
        state.selectedExcelRow = Number(tr.dataset.row);
        el('tableBody').querySelector('tr.selected-row')?.classList.remove('selected-row');
        tr.classList.add('selected-row');
      }
    });

    // Автоматическое удаление старого значения в поле «Заказ» при начале ввода новых данных
    el('tableBody').addEventListener('focusin', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      inp.dataset.origVal = inp.value;
      inp.dataset.freshEdit = '1';
      inp.select();
    });

    el('tableBody').addEventListener('mouseup', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      if (inp.dataset.freshEdit === '1') {
        e.preventDefault();
        inp.select();
      }
    });

    el('tableBody').addEventListener('paste', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      if (inp.dataset.freshEdit === '1') {
        inp.value = '';
        inp.dataset.freshEdit = '0';
      }
    });

    el('tableBody').addEventListener('keydown', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        inp.blur();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        inp.value = inp.dataset.origVal ?? inp.value;
        inp.dataset.freshEdit = '1';
        inp.blur();
        return;
      }
      if (inp.dataset.freshEdit === '1' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (/^\d$/.test(e.key)) {
          inp.value = '';
          inp.dataset.freshEdit = '0';
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          inp.value = '';
          inp.dataset.freshEdit = '0';
        }
      }
    });

    el('tableBody').addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      inp.dataset.freshEdit = '0';
      const digits = inp.value.replace(/[^\d]/g, '');
      const formatted = digits === '' ? '' : Number(digits).toLocaleString('ru-RU');
      if (inp.value !== formatted) inp.value = formatted;
    });

    el('tableBody').addEventListener('change', async (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      if (inp.dataset.freshEdit === '1') return;
      const rowNum = Number(inp.dataset.qtyRow);
      const digits = inp.value.replace(/[^\d]/g, '');
      const val = Math.max(0, Math.round(Number(digits) || 0));
      state.selectedExcelRow = rowNum;
      const env = await apiPost('api/override', { excelRow: rowNum, value: val });
      applyEnvelope(env);
      showToast(`Заказ обновлён: ${fmtInt(val)}`);
    });

    el('btnClearOverrides').addEventListener('click', async () => {
      const env = await apiPost('api/override', { clearAll: true });
      applyEnvelope(env);
      showToast('Все ручные корректировки сброшены');
    });

    // Переход по клику на строку во вкладке неликвидов
    document.body.addEventListener('click', (e) => {
      const jumpRow = e.target.closest('tr[data-jump-row]');
      if (jumpRow) {
        const rNum = Number(jumpRow.dataset.jumpRow);
        state.selectedExcelRow = rNum;
        el('inpSearch').value = '';
        el('fltWarehouse').value = '';
        el('fltGroup').value = '';
        el('fltSupplier').value = '';
        el('fltABCXYZ').value = '';
        el('fltStatus').value = 'all';
        recomputeFilteredList();
        renderTable();
        document.querySelector('.tab-btn[data-tab="table"]').click();
        requestAnimationFrame(() => {
          el('tableBody').querySelector(`tr[data-row="${rNum}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    });

    el('suppliersBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter-sup]');
      if (!btn) return;
      el('fltSupplier').value = btn.dataset.filterSup;
      el('fltWarehouse').value = btn.dataset.filterWh || '';
      recomputeFilteredList();
      renderTable();
      document.querySelector('.tab-btn[data-tab="table"]').click();
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

    const topbarEl = document.querySelector('.topbar');
    const toolbarEl = document.querySelector('#view-table .toolbar');
    const syncStickyHeaderOffset = () => {
      const topbarH = topbarEl ? Math.round(topbarEl.getBoundingClientRect().height) : 39;
      const toolbarH = toolbarEl ? Math.round(toolbarEl.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty('--sticky-head-top', `${topbarH}px`);
      document.documentElement.style.setProperty('--sticky-toolbar-top', `${topbarH}px`);
      const tableHeadTop = toolbarH > 0 ? topbarH + toolbarH + 5 : topbarH;
      document.documentElement.style.setProperty('--sticky-table-head-top', `${tableHeadTop}px`);
    };
    syncStickyHeaderOffset();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(syncStickyHeaderOffset);
      if (topbarEl) ro.observe(topbarEl);
      if (toolbarEl) ro.observe(toolbarEl);
    } else {
      window.addEventListener('resize', syncStickyHeaderOffset);
    }

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
