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
    pendingOverrides: new Map(),
    checkedSuppliers: new Set(),
    justResizedColumn: false,
  };

  const el = (id) => document.getElementById(id);

  function fmtInt(n) {
    return Math.round(Number(n) || 0).toLocaleString('ru-RU');
  }

  function parseQtyInput(raw) {
    const digits = String(raw ?? '').replace(/[^\d]/g, '');
    return Math.max(0, Math.round(Number(digits) || 0));
  }

  function calcLineSum(qty, price) {
    const q = Math.max(0, Math.round(Number(qty) || 0));
    const p = Math.round((Number(price) || 0) * 100) / 100;
    return Math.round(q * p * 100) / 100;
  }

  function hasActiveTableFilter() {
    return Boolean(
      el('inpSearchSku')?.value.trim() ||
      el('inpSearch')?.value.trim() ||
      el('fltWarehouse')?.value ||
      el('fltGroup')?.value ||
      el('fltSupplier')?.value ||
      el('fltABCXYZ')?.value ||
      (el('fltStatus')?.value && el('fltStatus').value !== 'all')
    );
  }

  function recomputeReportSummaries(rep) {
    if (!rep?.items) return;
    let orderItemsCount = 0;
    let totalOrderUnits = 0;
    let totalOrderCost = 0;
    let totalRetailValue = 0;

    const whMap = new Map();
    for (const prevW of rep.warehouses || []) {
      whMap.set(prevW.warehouse, {
        ...prevW,
        totalItems: 0,
        orderItems: 0,
        zeroStockItems: 0,
        totalOrderQty: 0,
        totalOrderCost: 0,
        totalRetailVal: 0,
        overstockItems: 0,
        overstockCost: 0,
      });
    }
    const supMap = new Map();
    const grpOrderItems = new Map();
    const grpOrderUnits = new Map();
    const grpOrderCost = new Map();

    for (const it of rep.items) {
      const qty = Math.max(0, Math.round(Number(it.finalOrderQty) || 0));
      const lineCost = calcLineSum(qty, it.purchasePrice);
      const unitRetail = Math.round((Number(it.retailPrice) || 0) * 100) / 100;
      const lineRetail = unitRetail > 0
        ? Math.round(qty * unitRetail * 100) / 100
        : (it.finalOrderQty > 0 && it.orderRetailValue > 0
          ? Math.round((it.orderRetailValue / it.finalOrderQty) * qty * 100) / 100
          : 0);

      it.finalOrderQty = qty;
      it.orderCost = lineCost;
      it.orderRetailValue = lineRetail;

      if (qty > 0) {
        orderItemsCount += 1;
        totalOrderUnits += qty;
        totalOrderCost += lineCost;
        totalRetailValue += lineRetail;
        grpOrderItems.set(it.group, (grpOrderItems.get(it.group) || 0) + 1);
        grpOrderUnits.set(it.group, (grpOrderUnits.get(it.group) || 0) + qty);
        grpOrderCost.set(it.group, (grpOrderCost.get(it.group) || 0) + lineCost);
      }

      const whName = it.warehouse || '';
      let ws = whMap.get(whName);
      if (!ws) {
        ws = {
          warehouse: whName,
          totalItems: 0,
          orderItems: 0,
          zeroStockItems: 0,
          totalOrderQty: 0,
          totalOrderCost: 0,
          totalRetailVal: 0,
          overstockItems: 0,
          overstockCost: 0,
        };
        whMap.set(whName, ws);
      }
      ws.totalItems += 1;
      if (it.closingStock <= 0) ws.zeroStockItems += 1;
      if (it.isOverstock) {
        ws.overstockItems += 1;
        ws.overstockCost += Number(it.overstockValue) || 0;
      }
      if (qty > 0) {
        ws.orderItems += 1;
        ws.totalOrderQty += qty;
        ws.totalOrderCost += lineCost;
        ws.totalRetailVal += lineRetail;
      }

      const supName = it.supplier || '(Поставщик не указан)';
      const supKey = `${whName}\x00${supName}`;
      let ss = supMap.get(supKey);
      if (!ss) {
        ss = {
          warehouse: whName,
          supplier: supName,
          totalItems: 0,
          orderItems: 0,
          totalOrderQty: 0,
          totalOrderCost: 0,
          totalRetailVal: 0,
          shareOfBudget: 0,
          belowMinOrder: false,
        };
        supMap.set(supKey, ss);
      }
      ss.totalItems += 1;
      if (qty > 0) {
        ss.orderItems += 1;
        ss.totalOrderQty += qty;
        ss.totalOrderCost += lineCost;
        ss.totalRetailVal += lineRetail;
      }
    }

    rep.orderItemsCount = orderItemsCount;
    rep.totalOrderUnits = totalOrderUnits;
    rep.totalOrderCost = Math.round(totalOrderCost * 100) / 100;
    rep.totalRetailValue = Math.round(totalRetailValue * 100) / 100;

    rep.warehouses = [...whMap.values()]
      .map((ws) => ({
        ...ws,
        totalOrderCost: Math.round(ws.totalOrderCost * 100) / 100,
        totalRetailVal: Math.round(ws.totalRetailVal * 100) / 100,
        overstockCost: Math.round(ws.overstockCost * 100) / 100,
      }))
      .sort((a, b) => a.warehouse.localeCompare(b.warehouse, 'ru'));

    const minSupOrder = Number(rep.params?.minSupplierOrder) || 0;
    rep.suppliers = [...supMap.values()]
      .map((ss) => {
        const cost = Math.round(ss.totalOrderCost * 100) / 100;
        return {
          ...ss,
          totalOrderCost: cost,
          totalRetailVal: Math.round(ss.totalRetailVal * 100) / 100,
          shareOfBudget: rep.totalOrderCost > 0 ? Math.round((cost / rep.totalOrderCost) * 10000) / 100 : 0,
          belowMinOrder: ss.orderItems > 0 && minSupOrder > 0 && cost < minSupOrder,
        };
      })
      .sort((a, b) => {
        if (Math.abs(a.totalOrderCost - b.totalOrderCost) > 1e-6) return b.totalOrderCost - a.totalOrderCost;
        if (a.warehouse !== b.warehouse) return a.warehouse.localeCompare(b.warehouse, 'ru');
        return a.supplier.localeCompare(b.supplier, 'ru');
      });

    if (Array.isArray(rep.groups)) {
      for (const g of rep.groups) {
        g.orderItemCount = grpOrderItems.get(g.group) || 0;
        g.totalUnits = grpOrderUnits.get(g.group) || 0;
        g.totalCost = Math.round((grpOrderCost.get(g.group) || 0) * 100) / 100;
      }
    }
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
    el('btnCloseApp').classList.toggle('hidden', !state.desktopMode);
    if (!state.report) {
      hideRatingChartPopover();
      state.filteredItems = [];
      state.selectedExcelRow = null;
      el('inpSearch').value = '';
      el('fltABCXYZ').value = '';
      el('fltStatus').value = 'all';
      el('fltWarehouse').innerHTML = '<option value="">Все склады</option>';
      el('fltGroup').innerHTML = '<option value="">Все группы</option>';
      el('fltSupplier').innerHTML = '<option value="">Все поставщики</option>';
      el('ovFltWarehouse').innerHTML = '<option value="">Все склады</option>';
      el('ovFltName').innerHTML = '<option value="">Вся номенклатура</option>';
      el('ovFltSupplier').innerHTML = '<option value="">Все поставщики</option>';
      el('ovInpSearch').value = '';
      el('btnResetOverstockFilters').classList.add('hidden');
      el('btnClearOverrides').classList.add('hidden');

      el('fileMetaLine').textContent = 'База очищена • Загрузите файл Ведомости (.xlsx) для расчёта';
      el('kpiOrderCost').textContent = '0,00 руб.';
      el('kpiBudgetInfo').textContent = 'База пуста';
      el('cntTabTable').textContent = '0';
      el('cntTabSuppliers').textContent = '0';
      el('cntTabOverstock').textContent = '0';
      el('paginationInfo').textContent = 'База очищена (0 строк)';
      el('tableBody').innerHTML = '<tr><td colspan="13" style="text-align:center;padding:32px;color:var(--text-muted)">База данных очищена — нажмите «Загрузить .xlsx» или перетащите файл Ведомости</td></tr>';
      el('tableFoot').innerHTML = '';
      el('warehousesContainer').innerHTML = '';
      el('suppliersBody').innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">База данных очищена</td></tr>';
      el('suppliersFoot').innerHTML = '';
      el('overstockContainer').innerHTML = '<p class="muted" style="margin:0;padding:12px 0">База данных очищена — загрузите файл Ведомости (.xlsx) для анализа неликвидов.</p>';
      return;
    }

    if (state.pendingOverrides.size > 0) {
      for (const [rNum, qty] of state.pendingOverrides.entries()) {
        const target = state.report.items?.find((x) => x.excelRow === rNum);
        if (target) {
          target.finalOrderQty = qty;
          target.manualOverride = qty;
        }
      }
    }
    recomputeReportSummaries(state.report);

    syncParamsControls(state.report);
    populateFilterDropdowns(state.report);
    recomputeFilteredList();
    renderKPIs(state.report);

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
      (w) => `${w.warehouse} — ${fmtMoney(w.totalOrderCost)} р. (${w.orderItems}/${w.totalItems})`
    );

    const selectedWh = el('fltWarehouse').value;
    if (selectedWh) {
      const grpByWh = new Map();
      for (const g of rep.groups) {
        grpByWh.set(g.group, { value: g.group, group: g.group, orderItemCount: 0, totalCost: 0 });
      }
      for (const it of rep.items) {
        if (it.warehouse !== selectedWh || it.finalOrderQty <= 0) continue;
        const g = grpByWh.get(it.group) || { value: it.group, group: it.group, orderItemCount: 0, totalCost: 0 };
        g.orderItemCount += 1;
        g.totalCost += calcLineSum(it.finalOrderQty, it.purchasePrice);
        grpByWh.set(it.group, g);
      }
      keepSet(
        el('fltGroup'),
        [...grpByWh.values()],
        'Все группы',
        (g) => `${g.group} (к закупке: ${g.orderItemCount})`
      );
    } else {
      keepSet(
        el('fltGroup'),
        rep.groups.map((g) => ({ value: g.group, ...g })),
        'Все группы',
        (g) => `${g.group} (к закупке: ${g.orderItemCount})`
      );
    }

    // Уникальные поставщики с учётом выбранного склада — полное совпадение сумм с вкладкой «Поставщики и склады»
    const supAgg = new Map();
    for (const s of rep.suppliers) {
      if (selectedWh && s.warehouse !== selectedWh) continue;
      const prev = supAgg.get(s.supplier);
      if (!prev) {
        supAgg.set(s.supplier, { value: s.supplier, supplier: s.supplier, totalOrderCost: s.totalOrderCost, orderItems: s.orderItems });
      } else {
        prev.totalOrderCost = Math.round((prev.totalOrderCost + s.totalOrderCost) * 100) / 100;
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

    renderSupplierDropdownMenu(rep, uniqueSuppliers);
  }

  function renderSupplierDropdownMenu(rep, uniqueSuppliers) {
    const selectedWh = el('fltWarehouse')?.value || '';
    const activeSup = el('fltSupplier')?.value || '';
    const filterQuery = (el('inpSupplierFilter')?.value || '').trim().toLowerCase();

    // Определяем, у каких поставщиков обнулён автозаказ (manualOverride === 0)
    const zeroedStats = new Map();
    for (const it of rep.items || []) {
      if (selectedWh && it.warehouse !== selectedWh) continue;
      const supName = it.supplier || '(Поставщик не указан)';
      let st = zeroedStats.get(supName);
      if (!st) {
        st = { zeroedCount: 0, activeCount: 0 };
        zeroedStats.set(supName, st);
      }
      if (it.finalOrderQty > 0) st.activeCount += 1;
      if (it.manualOverride === 0 && (it.autoOrderQty > 0 || it.finalOrderQty === 0)) {
        st.zeroedCount += 1;
      }
    }

    let fullyZeroedSuppliers = 0;
    for (const s of uniqueSuppliers) {
      const st = zeroedStats.get(s.supplier);
      if (st && st.activeCount === 0 && st.zeroedCount > 0) {
        fullyZeroedSuppliers += 1;
      }
    }

    const labelEl = el('supplierDropdownLabel');
    if (labelEl) {
      if (activeSup) {
        const found = uniqueSuppliers.find((s) => s.supplier === activeSup);
        labelEl.textContent = found
          ? `${found.supplier} — ${fmtMoney(found.totalOrderCost)} р. (${found.orderItems})`
          : activeSup;
      } else if (fullyZeroedSuppliers > 0) {
        labelEl.textContent = `Все поставщики (обнулено: ${fullyZeroedSuppliers})`;
      } else {
        labelEl.textContent = 'Все поставщики';
      }
    }

    const listEl = el('supplierDropdownList');
    if (!listEl) return;

    const visibleSuppliers = filterQuery
      ? uniqueSuppliers.filter((s) => s.supplier.toLowerCase().includes(filterQuery))
      : uniqueSuppliers;

    const allRowHtml = `<div class="supplier-dd-row ${activeSup === '' ? 'active-filter' : ''}">
      <button type="button" class="supplier-dd-item-btn" data-sup-select="" style="font-weight:700">
        Все поставщики (${uniqueSuppliers.length})
      </button>
    </div>`;

    const rowsHtml = visibleSuppliers.map((s) => {
      const st = zeroedStats.get(s.supplier) || { zeroedCount: 0, activeCount: 0 };
      const isZeroed = st.activeCount === 0 && st.zeroedCount > 0;
      const isChecked = state.checkedSuppliers.has(s.supplier);
      const isActive = activeSup === s.supplier;
      const actionBtn = isZeroed
        ? `<button type="button" class="supplier-dd-zero-btn restore" data-sup-restore="${esc(s.supplier)}" title="Вернуть авторасчёт заказа этому поставщику">Авто</button>`
        : `<button type="button" class="supplier-dd-zero-btn" data-sup-zero="${esc(s.supplier)}" title="Обнулить автозаполнение графы «Заказ» по этому поставщику">Обнулить</button>`;

      return `<div class="supplier-dd-row ${isActive ? 'active-filter' : ''} ${isZeroed ? 'is-zeroed' : ''}">
        <input type="checkbox" class="supplier-dd-check" data-sup-check="${esc(s.supplier)}" ${isChecked ? 'checked' : ''} title="Отметить поставщика для группового обнуления заказа" />
        <button type="button" class="supplier-dd-item-btn" data-sup-select="${esc(s.supplier)}" title="${esc(s.supplier)}">
          ${esc(s.supplier)} — ${fmtMoney(s.totalOrderCost)} р. (${s.orderItems})
        </button>
        ${actionBtn}
      </div>`;
    }).join('');

    listEl.innerHTML = allRowHtml + rowsHtml;
  }

  function renderKPIs(rep) {
    const firstP = rep.periods[0]?.label || '';
    const lastP = rep.periods[rep.periods.length - 1]?.label || '';
    el('fileMetaLine').textContent =
      `Файл: ${rep.fileName} • Срез: ${rep.createdDate || 'н/д'} • Статистика: ${firstP} — ${lastP} (${rep.periods.length} мес.) • Позиций: ${fmtInt(rep.totalItems)} (к закупке: ${fmtInt(rep.orderItemsCount)} SKU / ${fmtInt(rep.totalOrderUnits)} ед.)`;

    const isFiltered = hasActiveTableFilter();
    const visibleCost = isFiltered
      ? Math.round(state.filteredItems.reduce((acc, it) => acc + calcLineSum(it.finalOrderQty, it.purchasePrice), 0) * 100) / 100
      : rep.totalOrderCost;

    el('kpiOrderCost').textContent = `${fmtMoney(visibleCost)} руб.`;
    const activeSups = rep.suppliers.filter((s) => s.orderItems > 0).length;
    if (isFiltered) {
      el('kpiBudgetInfo').textContent = `По фильтру • Всего: ${fmtMoney(rep.totalOrderCost)} р.`;
    } else if (rep.params.budgetCap > 0) {
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
    const qSku = (el('inpSearchSku')?.value || '').trim().toLowerCase();
    const qName = el('inpSearch').value.trim().toLowerCase();
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

      if (qSku) {
        if (!String(it.sku || '').toLowerCase().includes(qSku)) return false;
      }
      if (qName) {
        if (!String(it.name || '').toLowerCase().includes(qName)) return false;
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

  function renderTableFooter() {
    const tfoot = el('tableFoot');
    const slice = state.filteredItems;
    const total = slice.length;
    const allTotal = state.report?.totalItems ?? total;

    if (total === 0) {
      el('paginationInfo').textContent = 'Нет строк по выбранным фильтрам';
      if (tfoot) tfoot.innerHTML = '';
      return;
    }

    let orderRows = 0;
    let orderUnits = 0;
    let orderSum = 0;
    for (const it of slice) {
      const qty = Math.max(0, Math.round(Number(it.finalOrderQty) || 0));
      const lineSum = calcLineSum(qty, it.purchasePrice);
      if (qty > 0) {
        orderRows += 1;
        orderUnits += qty;
      }
      orderSum += lineSum;
    }
    const roundedOrderSum = Math.round(orderSum * 100) / 100;

    el('paginationInfo').textContent =
      `Отображены все строки: ${fmtInt(total)} из ${fmtInt(allTotal)} • К закупке: ${fmtInt(orderRows)} SKU / ${fmtInt(orderUnits)} шт. • Сумма закупки: ${fmtMoney(roundedOrderSum)} руб.`;

    if (tfoot) {
      tfoot.innerHTML = `<tr>
        <td colspan="8" style="text-align:right;color:var(--text-muted)">Итого (к закупке: ${fmtInt(orderRows)} поз.):</td>
        <td class="num-col col-5digits" style="color:var(--primary)">${fmtInt(orderUnits)}</td>
        <td class="num-col"></td>
        <td class="num-col"></td>
        <td class="num-col">${fmtMoney(roundedOrderSum)}</td>
        <td>руб.</td>
      </tr>`;
    }
  }

  function renderTable() {
    const tbody = el('tableBody');
    const slice = state.filteredItems;

    // Сохраняем позицию скролла и активное поле ввода, если пользователь перешёл в соседнюю строку
    const prevScrollY = window.scrollY;
    const activeEl = document.activeElement;
    const activeQtyRow = activeEl?.dataset?.qtyRow ? Number(activeEl.dataset.qtyRow) : null;
    const activeFresh = activeEl?.dataset?.freshEdit;
    const activeDirty = activeEl?.dataset?.dirty;
    const activeOrigQty = activeEl?.dataset?.origQty;
    const activeDraft = activeEl?.dataset?.qtyRow ? activeEl.value : null;

    renderTableFooter();

    if (slice.length === 0) {
      tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;padding:32px;color:var(--text-muted)">По заданным условиям фильтрации позиций не найдено</td></tr>`;
      return;
    }

    tbody.innerHTML = slice.map((it) => {
      const isSelected = it.excelRow === state.selectedExcelRow;
      const isManual = it.manualOverride != null;
      const hasAutoOrder = it.autoOrderQty > 0;
      const segNum = Number(it.salesSegment) || 0;
      const lineSum = calcLineSum(it.finalOrderQty, it.purchasePrice);

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
        <td class="seg-cell" data-rating-row="${it.excelRow}"><span class="seg-pill seg-${segNum}" data-rating-row="${it.excelRow}">${segNum}</span></td>
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
        <td class="num-col" data-sum-row="${it.excelRow}" style="font-weight:${lineSum > 0 ? '700' : '400'}">${fmtMoney(lineSum)}</td>
        <td class="sup-cell" title="${esc(it.supplier)}">${esc(it.supplier || '')}</td>
      </tr>`;
    }).join('');

    if (activeQtyRow != null) {
      const nextInp = tbody.querySelector(`input[data-qty-row="${activeQtyRow}"]`);
      if (nextInp) {
        nextInp.focus({ preventScroll: true });
        if (activeOrigQty != null) nextInp.dataset.origQty = activeOrigQty;
        if (activeDirty === '1') nextInp.dataset.dirty = '1';
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

  let activePopoverRow = null;

  function renderThreeYearSalesChart(rep, it) {
    const allPeriods = rep?.periods || [];
    const salesArr = it?.monthlySales || [];
    const count = Math.min(36, allPeriods.length);
    const startIdx = Math.max(0, allPeriods.length - count);
    const slicePeriods = allPeriods.slice(startIdx);
    const sliceSales = slicePeriods.map((_, i) => Math.max(0, Number(salesArr[startIdx + i]) || 0));

    const sumWindow = (from, to) => sliceSales.slice(from, to).reduce((a, b) => a + b, 0);
    const n = sliceSales.length;
    const y1Sum = sumWindow(0, Math.max(0, n - 24));
    const y2Sum = sumWindow(Math.max(0, n - 24), Math.max(0, n - 12));
    const y3Sum = sumWindow(Math.max(0, n - 12), n);
    const total3Y = sliceSales.reduce((a, b) => a + b, 0);

    const W = 520;
    const H = 186;
    const padL = 36;
    const padR = 10;
    const padT = 24;
    const padB = 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.max(0, ...sliceSales);
    const yScaleMax = maxVal > 0 ? maxVal * 1.16 : 10;
    const step = n > 0 ? plotW / n : plotW;
    const barW = Math.max(5, Math.min(11, step * 0.68));

    const yPos = (val) => padT + plotH - (val / yScaleMax) * plotH;

    let gridSVG = '';
    const ticks = maxVal > 0 ? [0, Math.round(maxVal / 2), Math.round(maxVal)] : [0];
    ticks.forEach((tv) => {
      const y = yPos(tv).toFixed(1);
      gridSVG += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--border)" stroke-width="1" stroke-dasharray="${tv === 0 ? 'none' : '3,3'}" />`;
      gridSVG += `<text x="${padL - 5}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--text-muted)">${fmtInt(tv)}</text>`;
    });

    let yearLinesSVG = '';
    let barsSVG = '';
    slicePeriods.forEach((p, idx) => {
      const val = sliceSales[idx];
      const cx = padL + idx * step + step / 2;
      const bx = cx - barW / 2;
      const bh = val > 0 ? Math.max(2.5, (val / yScaleMax) * plotH) : 0;
      const by = padT + plotH - bh;

      if (idx === 0 || p.month === 1) {
        const lx = (padL + idx * step).toFixed(1);
        if (idx > 0) {
          yearLinesSVG += `<line x1="${lx}" y1="${padT - 12}" x2="${lx}" y2="${padT + plotH}" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="2,2" />`;
        }
        yearLinesSVG += `<text x="${(Number(lx) + 3).toFixed(1)}" y="${padT - 5}" font-size="10" font-weight="700" fill="var(--text)">${p.year}</text>`;
      }

      const barColor = idx >= n - 12 ? '#10b981' : (idx >= n - 24 ? '#3b82f6' : '#93c5fd');
      if (bh > 0) {
        barsSVG += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${barColor}" />`;
        barsSVG += `<text x="${cx.toFixed(1)}" y="${(by - 3).toFixed(1)}" text-anchor="middle" font-size="8.5" font-weight="700" fill="var(--text)">${fmtInt(val)}</text>`;
      }
      const mm = String(p.month).padStart(2, '0');
      barsSVG += `<text x="${cx.toFixed(1)}" y="${padT + plotH + 13}" text-anchor="middle" font-size="8.5" fill="var(--text-muted)">${mm}</text>`;
    });

    const emptyNotice = maxVal === 0
      ? `<text x="${(padL + plotW / 2).toFixed(1)}" y="${(padT + plotH / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--text-muted)">За последние 3 года продаж не было (0 шт.)</text>`
      : '';

    const segNum = Number(it.salesSegment) || 0;
    const firstLbl = slicePeriods[0]?.label || '';
    const lastLbl = slicePeriods[slicePeriods.length - 1]?.label || '';
    const skuPart = it.sku ? ` • Арт. ${esc(it.sku)}` : '';

    return `
      <div class="rcp-header">
        <div class="rcp-title-wrap">
          <span class="seg-pill seg-${segNum}">${segNum}</span>
          <span class="rcp-item-name">${esc(it.name)}${skuPart}</span>
        </div>
        <span class="rcp-period-tag">График продаж за 3 года (${esc(firstLbl)} — ${esc(lastLbl)})</span>
      </div>
      <div class="rcp-summary">
        <span>Всего за 3 года: <strong>${fmtInt(total3Y)} шт.</strong></span>
        <span><i class="rcp-dot" style="background:#93c5fd"></i>1-й год: <strong>${fmtInt(y1Sum)} шт.</strong></span>
        <span><i class="rcp-dot" style="background:#3b82f6"></i>2-й год: <strong>${fmtInt(y2Sum)} шт.</strong></span>
        <span><i class="rcp-dot" style="background:#10b981"></i>Посл. 12 мес.: <strong>${fmtInt(y3Sum)} шт.</strong></span>
        <span>Остаток: <strong>${fmtInt(it.closingStock)} шт.</strong></span>
      </div>
      <svg class="rcp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${gridSVG}
        ${yearLinesSVG}
        ${barsSVG}
        ${emptyNotice}
      </svg>
    `;
  }

  function showRatingChartPopover(anchorEl, excelRow) {
    const pop = el('ratingChartPopover');
    if (!pop || !state.report) return;
    const item = state.report.items.find((x) => x.excelRow === excelRow);
    if (!item) return;

    if (activePopoverRow !== excelRow) {
      pop.innerHTML = renderThreeYearSalesChart(state.report, item);
      activePopoverRow = excelRow;
    }
    pop.classList.remove('hidden');

    const pillEl = anchorEl.classList.contains('seg-pill')
      ? anchorEl
      : (anchorEl.querySelector('.seg-pill') || anchorEl);
    const rect = pillEl.getBoundingClientRect();

    // Размещаем всплывающее окно строго справа от кружочка с цифрой рейтинга
    const left = Math.round(rect.right + 12);
    const availRight = window.innerWidth - left - 10;
    const width = Math.max(300, Math.min(548, availRight));
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;

    const popH = pop.offsetHeight || 248;
    const centerY = rect.top + rect.height / 2;
    const top = Math.max(8, Math.min(Math.round(centerY - popH / 2), window.innerHeight - popH - 8));
    pop.style.top = `${top}px`;

    const arrowTop = Math.max(16, Math.min(Math.round(centerY - top), popH - 16));
    pop.style.setProperty('--arrow-top', `${arrowTop}px`);
  }

  function hideRatingChartPopover() {
    const pop = el('ratingChartPopover');
    if (!pop) return;
    pop.classList.add('hidden');
    activePopoverRow = null;
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

    let sumSupTotalSKU = 0;
    let sumSupOrderSKU = 0;
    let sumSupOrderUnits = 0;
    let sumSupOrderCost = 0;
    let sumSupRetailVal = 0;
    for (const s of rep.suppliers) {
      sumSupTotalSKU += Number(s.totalItems) || 0;
      sumSupOrderSKU += Number(s.orderItems) || 0;
      sumSupOrderUnits += Number(s.totalOrderQty) || 0;
      sumSupOrderCost += Number(s.totalOrderCost) || 0;
      sumSupRetailVal += Number(s.totalRetailVal) || 0;
    }
    const supFoot = el('suppliersFoot');
    if (supFoot) {
      supFoot.innerHTML = `<tr>
        <td colspan="2" style="text-align:right;color:var(--text-muted)">Итого по всем складам и поставщикам:</td>
        <td class="num-col">${fmtInt(sumSupTotalSKU)}</td>
        <td class="num-col">${fmtInt(sumSupOrderSKU)}</td>
        <td class="num-col" style="color:var(--primary)">${fmtInt(sumSupOrderUnits)}</td>
        <td class="num-col">${fmtMoney(Math.round(sumSupOrderCost * 100) / 100)} руб.</td>
        <td class="num-col">${fmtMoney(Math.round(sumSupRetailVal * 100) / 100)} руб.</td>
        <td colspan="2"></td>
      </tr>`;
    }
  }

  function renderOverstockView(rep) {
    if (!rep) return;
    const allOver = rep.items
      .filter((it) => it.isOverstock)
      .sort((a, b) => b.overstockValue - a.overstockValue);

    const setSelectOptions = (selectEl, items, defaultLabel, formatter) => {
      const prev = selectEl.value;
      selectEl.innerHTML = `<option value="">${esc(defaultLabel)}</option>` +
        items.map((item) => {
          const val = typeof item === 'string' ? item : item.value;
          const label = formatter ? formatter(item) : val;
          return `<option value="${esc(val)}">${esc(label)}</option>`;
        }).join('');
      if ([...selectEl.options].some((o) => o.value === prev)) {
        selectEl.value = prev;
      } else {
        selectEl.value = '';
      }
    };

    const whAgg = new Map();
    const supAgg = new Map();
    for (const it of allOver) {
      const whName = it.warehouse || '';
      if (whName) {
        const w = whAgg.get(whName) || { value: whName, warehouse: whName, count: 0, frozen: 0 };
        w.count += 1;
        w.frozen += it.overstockValue;
        whAgg.set(whName, w);
      }
      const sName = it.supplier || '(Поставщик не указан)';
      const s = supAgg.get(sName) || { value: sName, supplier: sName, count: 0, frozen: 0 };
      s.count += 1;
      s.frozen += it.overstockValue;
      supAgg.set(sName, s);
    }

    setSelectOptions(
      el('ovFltWarehouse'),
      [...whAgg.values()].sort((a, b) => b.frozen - a.frozen || a.warehouse.localeCompare(b.warehouse, 'ru')),
      'Все склады',
      (w) => `${w.warehouse} (${w.count})`
    );
    setSelectOptions(
      el('ovFltSupplier'),
      [...supAgg.values()].sort((a, b) => b.frozen - a.frozen || a.supplier.localeCompare(b.supplier, 'ru')),
      'Все поставщики',
      (s) => `${s.supplier} — ${fmtMoney(s.frozen)} р. (${s.count})`
    );

    const selWh = el('ovFltWarehouse').value;
    const selSup = el('ovFltSupplier').value;

    const nameCandidates = new Set();
    for (const it of allOver) {
      if (selWh && it.warehouse !== selWh) continue;
      const sName = it.supplier || '(Поставщик не указан)';
      if (selSup && sName !== selSup) continue;
      if (it.name) nameCandidates.add(it.name);
    }
    setSelectOptions(
      el('ovFltName'),
      [...nameCandidates].sort((a, b) => a.localeCompare(b, 'ru')),
      'Вся номенклатура'
    );

    const selName = el('ovFltName').value;
    const searchQ = el('ovInpSearch').value.trim().toLowerCase();
    const hasActiveFilter = Boolean(selWh || selSup || selName || searchQ);
    el('btnResetOverstockFilters').classList.toggle('hidden', !hasActiveFilter);

    const over = allOver.filter((it) => {
      if (selWh && it.warehouse !== selWh) return false;
      const sName = it.supplier || '(Поставщик не указан)';
      if (selSup && sName !== selSup) return false;
      if (selName && it.name !== selName) return false;
      if (searchQ) {
        const hay = `${it.name} ${it.sku} ${it.group} ${it.supplier} ${it.warehouse}`.toLowerCase();
        if (!hay.includes(searchQ)) return false;
      }
      return true;
    });

    const filteredFrozen = over.reduce((acc, it) => acc + (Number(it.overstockValue) || 0), 0);
    const totalHint = hasActiveFilter
      ? ` (всего по базе: ${fmtInt(allOver.length)} поз. на ${fmtMoney(rep.overstockFrozenCost)} руб.)`
      : '';

    el('overstockContainer').innerHTML = `
      <h3>Радар замороженного капитала и неликвидов (&gt; 365 дней продаж или 0 продаж за 12 мес.)</h3>
      <p class="muted">Выявлено <strong>${fmtInt(over.length)} позиций</strong> со сверхнормативным запасом на сумму <strong style="color:var(--warn)">${fmtMoney(filteredFrozen)} руб.</strong>${totalHint} (в закупочных ценах сверх годовой потребности). Рекомендуется промо-выкладка, скидка или межскладской обмен.</p>
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
            ${over.length === 0
              ? '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted)">По выбранным фильтрам позиций не найдено</td></tr>'
              : over.map((it) => `<tr data-jump-row="${it.excelRow}">
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
          el('selSeasonMode').value = 'hybrid';
        } else if (preset === 'standard') {
          el('inpHorizon').value = 30;
          el('inpLeadTime').value = 4;
          el('inpSafety').value = 10;
          state.planStartDate = '';
          el('selSeasonMode').value = 'hybrid';
        } else if (preset === 'budget5k') {
          el('inpHorizon').value = 30;
          el('inpLeadTime').value = 4;
          el('inpSafety').value = 10;
          el('inpBudgetCap').value = 5000;
          state.planStartDate = '';
          el('selSeasonMode').value = 'hybrid';
        } else if (preset === 'spring') {
          const baseYear = (state.report?.periods?.at(-1)?.year || 2026) + 1;
          state.planStartDate = `${baseYear}-03-01`;
          el('inpHorizon').value = 21;
          el('inpLeadTime').value = 4;
          el('inpSafety').value = 5;
          el('selSeasonMode').value = 'conservative';
        }
        scheduleRecalculate();
      });
    });

    el('btnClearDatabase').addEventListener('click', async () => {
      try {
        const env = await apiPost('api/clear', {});
        applyEnvelope(env);
        showToast('База данных очищена');
      } catch (err) {
        showToast(err.message);
      }
    });

    ['ovFltWarehouse', 'ovFltName', 'ovFltSupplier'].forEach((id) => {
      el(id).addEventListener('change', () => {
        if (state.report) renderOverstockView(state.report);
      });
    });
    el('ovInpSearch').addEventListener('input', () => {
      if (state.report) renderOverstockView(state.report);
    });
    el('btnResetOverstockFilters').addEventListener('click', () => {
      el('ovFltWarehouse').value = '';
      el('ovFltName').value = '';
      el('ovFltSupplier').value = '';
      el('ovInpSearch').value = '';
      if (state.report) renderOverstockView(state.report);
    });

    el('btnToggleAdvanced').addEventListener('click', () => {
      const body = el('paramsBody');
      const isHidden = body.classList.toggle('hidden');
      el('btnToggleAdvanced').setAttribute('aria-expanded', String(!isHidden));
      el('btnToggleAdvanced').textContent = isHidden ? 'Параметры PRO SCM ▸' : 'Параметры PRO SCM ▾';
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

    ['inpSearchSku', 'inpSearch'].forEach((id) => {
      el(id).addEventListener('input', () => {
        state.page = 1;
        recomputeFilteredList();
        if (state.report) renderKPIs(state.report);
        renderTable();
      });
    });
    ['fltWarehouse', 'fltGroup', 'fltSupplier', 'fltABCXYZ', 'fltStatus'].forEach((id) => {
      el(id).addEventListener('change', () => {
        state.page = 1;
        if (state.report) {
          populateFilterDropdowns(state.report);
        }
        recomputeFilteredList();
        if (state.report) renderKPIs(state.report);
        renderTable();
      });
    });

    // Кастомный выпадающий список «Все поставщики» с обнулением автозаполнения заказа по избранным поставщикам
    const closeSupplierDropdown = () => {
      const menu = el('supplierDropdownMenu');
      const trig = el('btnSupplierDropdown');
      if (menu && !menu.classList.contains('hidden')) {
        menu.classList.add('hidden');
        trig?.setAttribute('aria-expanded', 'false');
      }
    };

    el('btnSupplierDropdown').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = el('supplierDropdownMenu');
      const isHidden = menu.classList.toggle('hidden');
      el('btnSupplierDropdown').setAttribute('aria-expanded', String(!isHidden));
      if (!isHidden) {
        if (state.report) populateFilterDropdowns(state.report);
        requestAnimationFrame(() => el('inpSupplierFilter')?.focus());
      }
    });

    el('inpSupplierFilter').addEventListener('input', () => {
      if (state.report) populateFilterDropdowns(state.report);
    });

    el('supplierDropdownList').addEventListener('change', (e) => {
      const chk = e.target.closest('input[data-sup-check]');
      if (!chk) return;
      const sup = chk.dataset.supCheck;
      if (chk.checked) {
        state.checkedSuppliers.add(sup);
      } else {
        state.checkedSuppliers.delete(sup);
      }
    });

    el('supplierDropdownList').addEventListener('click', async (e) => {
      const zeroBtn = e.target.closest('[data-sup-zero]');
      if (zeroBtn) {
        e.stopPropagation();
        const sup = zeroBtn.dataset.supZero;
        const wh = el('fltWarehouse').value || '';
        const env = await apiPost('api/override', { warehouse: wh, zeroSuppliers: [sup] });
        applyEnvelope(env);
        showToast(`Заказ обнулён: ${sup}`);
        return;
      }

      const restoreBtn = e.target.closest('[data-sup-restore]');
      if (restoreBtn) {
        e.stopPropagation();
        const sup = restoreBtn.dataset.supRestore;
        const wh = el('fltWarehouse').value || '';
        const env = await apiPost('api/override', { warehouse: wh, restoreSuppliers: [sup] });
        applyEnvelope(env);
        showToast(`Авторасчёт восстановлен: ${sup}`);
        return;
      }

      const selBtn = e.target.closest('[data-sup-select]');
      if (selBtn) {
        el('fltSupplier').value = selBtn.dataset.supSelect || '';
        el('fltSupplier').dispatchEvent(new Event('change'));
        closeSupplierDropdown();
      }
    });

    el('btnZeroCheckedSuppliers').addEventListener('click', async (e) => {
      e.stopPropagation();
      let targets = [...state.checkedSuppliers];
      if (targets.length === 0 && el('fltSupplier').value) {
        targets = [el('fltSupplier').value];
      }
      if (targets.length === 0) {
        showToast('Отметьте галочками избранных поставщиков в списке');
        return;
      }
      const wh = el('fltWarehouse').value || '';
      const env = await apiPost('api/override', { warehouse: wh, zeroSuppliers: targets });
      applyEnvelope(env);
      showToast(`Обнулён заказ у поставщиков: ${targets.length}`);
    });

    el('btnRestoreCheckedSuppliers').addEventListener('click', async (e) => {
      e.stopPropagation();
      let targets = [...state.checkedSuppliers];
      if (targets.length === 0 && el('fltSupplier').value) {
        targets = [el('fltSupplier').value];
      }
      if (targets.length === 0) {
        showToast('Отметьте галочками поставщиков для возврата авторасчёта');
        return;
      }
      const wh = el('fltWarehouse').value || '';
      const env = await apiPost('api/override', { warehouse: wh, restoreSuppliers: targets });
      applyEnvelope(env);
      showToast(`Восстановлен авторасчёт у поставщиков: ${targets.length}`);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#supplierDropdown')) {
        closeSupplierDropdown();
      }
    });

    document.querySelectorAll('#itemsTable thead th[data-sort]').forEach((th) => {
      th.addEventListener('click', (e) => {
        if (state.justResizedColumn || e.target.closest('.col-resizer')) return;
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

    // Всплывающий справа график продаж за последние 3 года при наведении курсора на цифру рейтинга
    el('tableBody').addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-rating-row]');
      if (!target) {
        if (activePopoverRow !== null) hideRatingChartPopover();
        return;
      }
      showRatingChartPopover(target, Number(target.dataset.ratingRow));
    });

    el('tableBody').addEventListener('mouseleave', () => {
      hideRatingChartPopover();
    });

    window.addEventListener('scroll', () => {
      if (activePopoverRow !== null) hideRatingChartPopover();
    }, { passive: true });

    let liveOverrideTimer = null;

    async function pushOverrideToServer(rowNum, val, silent = false) {
      state.pendingOverrides.set(rowNum, val);
      try {
        const env = await apiPost('api/override', { excelRow: rowNum, value: val });
        if (state.pendingOverrides.get(rowNum) === val) {
          state.pendingOverrides.delete(rowNum);
        }
        if (silent) {
          if (env.report) {
            state.report = env.report;
            if (state.pendingOverrides.size > 0) {
              for (const [r, q] of state.pendingOverrides.entries()) {
                const t = state.report.items?.find((x) => x.excelRow === r);
                if (t) {
                  t.finalOrderQty = q;
                  t.manualOverride = q;
                }
              }
            }
            recomputeReportSummaries(state.report);
            populateFilterDropdowns(state.report);
            renderKPIs(state.report);
            renderTableFooter();
            renderSuppliersView(state.report);
          }
        } else {
          applyEnvelope(env);
          showToast(`Заказ обновлён: ${fmtInt(val)}`);
        }
      } catch (err) {
        showToast(err.message);
      }
    }

    function updateRowSumLive(rowNum, qty) {
      if (!state.report?.items) return;
      const it = state.report.items.find((x) => x.excelRow === rowNum);
      if (!it) return;
      const lineSum = calcLineSum(qty, it.purchasePrice);
      it.finalOrderQty = qty;
      it.orderCost = lineSum;

      const tbody = el('tableBody');
      const sumCell = tbody?.querySelector(`td[data-sum-row="${rowNum}"]`);
      if (sumCell) {
        sumCell.textContent = fmtMoney(lineSum);
        sumCell.style.fontWeight = lineSum > 0 ? '700' : '400';
      }
      const inp = tbody?.querySelector(`input[data-qty-row="${rowNum}"]`);
      if (inp) {
        inp.classList.toggle('has-order', qty > 0);
      }

      recomputeReportSummaries(state.report);
      populateFilterDropdowns(state.report);
      renderKPIs(state.report);
      renderTableFooter();
      renderSuppliersView(state.report);
    }

    async function commitQtyOverride(inp) {
      if (!inp || inp.dataset.dirty !== '1') return;
      clearTimeout(liveOverrideTimer);
      inp.dataset.dirty = '0';
      const rowNum = Number(inp.dataset.qtyRow);
      const val = parseQtyInput(inp.value);
      inp.value = fmtInt(val);
      state.selectedExcelRow = rowNum;
      await pushOverrideToServer(rowNum, val, false);
    }

    // Автоматическое удаление старого значения в поле «Заказ» при начале ввода новых данных
    el('tableBody').addEventListener('focusin', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      inp.dataset.origVal = inp.value;
      inp.dataset.origQty = String(parseQtyInput(inp.value));
      inp.dataset.freshEdit = '1';
      inp.dataset.dirty = '0';
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
      inp.dataset.dirty = '1';
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
        clearTimeout(liveOverrideTimer);
        const rowNum = Number(inp.dataset.qtyRow);
        const prevQty = Number(inp.dataset.origQty ?? 0);
        state.pendingOverrides.delete(rowNum);
        inp.value = inp.dataset.origVal ?? fmtInt(prevQty);
        inp.dataset.freshEdit = '1';
        inp.dataset.dirty = '0';
        updateRowSumLive(rowNum, prevQty);
        inp.blur();
        return;
      }
      if (inp.dataset.freshEdit === '1' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (/^\d$/.test(e.key)) {
          inp.value = '';
          inp.dataset.freshEdit = '0';
          inp.dataset.dirty = '1';
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          inp.value = '';
          inp.dataset.freshEdit = '0';
          inp.dataset.dirty = '1';
          const rowNum = Number(inp.dataset.qtyRow);
          state.pendingOverrides.set(rowNum, 0);
          updateRowSumLive(rowNum, 0);
          clearTimeout(liveOverrideTimer);
          liveOverrideTimer = setTimeout(() => {
            pushOverrideToServer(rowNum, 0, true);
          }, 280);
        }
      }
    });

    el('tableBody').addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      inp.dataset.freshEdit = '0';
      inp.dataset.dirty = '1';
      const digits = inp.value.replace(/[^\d]/g, '');
      const formatted = digits === '' ? '' : Number(digits).toLocaleString('ru-RU');
      if (inp.value !== formatted) inp.value = formatted;
      const rowNum = Number(inp.dataset.qtyRow);
      const val = parseQtyInput(formatted);
      state.pendingOverrides.set(rowNum, val);
      updateRowSumLive(rowNum, val);
      clearTimeout(liveOverrideTimer);
      liveOverrideTimer = setTimeout(() => {
        pushOverrideToServer(rowNum, val, true);
      }, 280);
    });

    el('tableBody').addEventListener('change', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      if (inp.dataset.freshEdit === '1') return;
      commitQtyOverride(inp);
    });

    el('tableBody').addEventListener('focusout', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      commitQtyOverride(inp);
    });

    el('btnClearOverrides').addEventListener('click', async () => {
      state.checkedSuppliers.clear();
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
        el('inpSearchSku').value = '';
        el('inpSearch').value = '';
        el('fltWarehouse').value = '';
        el('fltGroup').value = '';
        el('fltSupplier').value = '';
        el('fltABCXYZ').value = '';
        el('fltStatus').value = 'all';
        if (state.report) populateFilterDropdowns(state.report);
        recomputeFilteredList();
        if (state.report) renderKPIs(state.report);
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
      el('fltWarehouse').value = btn.dataset.filterWh || '';
      if (state.report) populateFilterDropdowns(state.report);
      el('fltSupplier').value = btn.dataset.filterSup;
      recomputeFilteredList();
      if (state.report) renderKPIs(state.report);
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

    el('btnFullscreen').addEventListener('click', async () => {
      const isAppFullWindow = Math.abs(window.outerWidth - screen.width) <= 2 && Math.abs(window.outerHeight - screen.height) <= 2;
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      } else if (isAppFullWindow && state.desktopMode) {
        const targetW = Math.round(screen.availWidth * 0.92);
        const targetH = Math.round(screen.availHeight * 0.9);
        window.resizeTo(targetW, targetH);
        window.moveTo(
          Math.max(0, Math.round((screen.availWidth - targetW) / 2)),
          Math.max(0, Math.round((screen.availHeight - targetH) / 2)),
        );
      } else if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen().catch(() => {
          window.moveTo(0, 0);
          window.resizeTo(screen.availWidth, screen.availHeight);
        });
      }
    });

    el('btnCloseApp').addEventListener('click', async () => {
      await fetch('api/shutdown', { method: 'POST', keepalive: true }).catch(() => {});
      window.close();
    });

    const topbarEl = document.querySelector('.topbar');
    const toolbarEl = document.querySelector('#view-table .toolbar');
    const ovToolbarEl = el('overstockToolbar');
    const syncStickyHeaderOffset = () => {
      const topbarH = topbarEl ? Math.round(topbarEl.getBoundingClientRect().height) : 39;
      const activeToolbar = state.activeTab === 'overstock' ? ovToolbarEl : toolbarEl;
      const toolbarH = activeToolbar ? Math.round(activeToolbar.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty('--sticky-head-top', `${topbarH}px`);
      document.documentElement.style.setProperty('--sticky-toolbar-top', `${topbarH}px`);
      const tableHeadTop = toolbarH > 0 ? topbarH + toolbarH + 5 : topbarH;
      document.documentElement.style.setProperty('--sticky-table-head-top', `${tableHeadTop}px`);
    };
    syncStickyHeaderOffset();
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => requestAnimationFrame(syncStickyHeaderOffset));
    });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(syncStickyHeaderOffset);
      if (topbarEl) ro.observe(topbarEl);
      if (toolbarEl) ro.observe(toolbarEl);
      if (ovToolbarEl) ro.observe(ovToolbarEl);
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

  function initColumnResizers() {
    const STORAGE_KEY = 'ostatki_v4_col_widths';
    let savedWidths = {};
    try {
      savedWidths = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (_) {
      savedWidths = {};
    }

    const persistWidths = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(savedWidths));
      } catch (_) {}
    };

    document.querySelectorAll('table.data-table').forEach((table) => {
      const tableId = table.id || 'dataTable';
      const headRow = table.querySelector('thead tr');
      if (!headRow) return;
      const ths = [...headRow.querySelectorAll('th')];
      if (ths.length === 0) return;

      let colgroup = table.querySelector('colgroup');
      if (!colgroup) {
        colgroup = document.createElement('colgroup');
        for (let i = 0; i < ths.length; i++) {
          colgroup.appendChild(document.createElement('col'));
        }
        table.insertBefore(colgroup, table.firstChild);
      }
      const cols = [...colgroup.querySelectorAll('col')];

      const stored = savedWidths[tableId];
      if (Array.isArray(stored) && stored.length === ths.length) {
        table.classList.add('table-manual-cols');
        stored.forEach((w, idx) => {
          if (w && w >= 42) {
            cols[idx].style.width = `${w}px`;
            ths[idx].style.width = `${w}px`;
          }
        });
      }

      ths.forEach((th, colIdx) => {
        if (th.querySelector('.col-resizer')) return;
        const handle = document.createElement('span');
        handle.className = 'col-resizer';
        handle.title = 'Потяните границу для настройки ширины столбца (двойной клик — сброс)';
        th.appendChild(handle);

        handle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        handle.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          delete savedWidths[tableId];
          persistWidths();
          table.classList.remove('table-manual-cols');
          table.style.width = '';
          cols.forEach((c) => { c.style.width = ''; });
          ths.forEach((h) => { h.style.width = ''; });
          showToast('Ширина столбцов восстановлена');
        });

        handle.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();

          // Фиксируем текущие ширины всех столбцов перед началом перетаскивания
          const initialWidths = ths.map((h) => Math.max(44, Math.round(h.getBoundingClientRect().width)));
          table.classList.add('table-manual-cols');
          initialWidths.forEach((w, idx) => {
            cols[idx].style.width = `${w}px`;
            ths[idx].style.width = `${w}px`;
          });

          const startX = e.clientX;
          const startWidth = initialWidths[colIdx];
          let currentWidths = [...initialWidths];

          handle.classList.add('resizing');
          document.body.classList.add('col-resize-active');

          const onMouseMove = (moveEv) => {
            const delta = moveEv.clientX - startX;
            const nextWidth = Math.max(44, Math.round(startWidth + delta));
            currentWidths[colIdx] = nextWidth;
            cols[colIdx].style.width = `${nextWidth}px`;
            ths[colIdx].style.width = `${nextWidth}px`;
            const totalW = currentWidths.reduce((a, b) => a + b, 0);
            table.style.width = `${totalW}px`;
          };

          const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            handle.classList.remove('resizing');
            document.body.classList.remove('col-resize-active');
            savedWidths[tableId] = currentWidths;
            persistWidths();
            state.justResizedColumn = true;
            setTimeout(() => { state.justResizedColumn = false; }, 180);
          };

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        });
      });
    });
  }

  async function bootstrap() {
    initColumnResizers();
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
