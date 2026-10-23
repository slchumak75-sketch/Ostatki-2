(() => {
  'use strict';

  const VIRTUAL_THRESHOLD = 400;
  const VIRTUAL_WINDOW = 180;
  const VIRTUAL_OVERSCAN = 55;
  const AUTOSAVE_INTERVAL_MS = 3 * 60 * 1000;
  const ruCollator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
  const activeControllers = new Set();
  let isClearingDatabase = false;
  let isClosingConfirmed = false;
  let isDownloadingFile = false;
  let vScrollRaf = null;

  const state = {
    colFilters: {},
    clientEpoch: 0,
    report: null,
    rowMap: new Map(),
    canSaveInPlace: false,
    desktopMode: false,
    sourceFileName: '',
    savedFileName: '',
    lastSavedAt: '',
    isSavingDb: false,
    hasUnsavedChanges: false,
    planStartDate: '',
    filteredItems: [],
    selectedExcelRow: null,
    sortKey: 'finalOrderQty',
    sortDir: 'desc',
    page: 1,
    pageSize: 100,
    activeTab: 'table',
    debounceTimer: null,
    searchDebounceTimer: null,
    pendingOverrides: new Map(),
    checkedSuppliers: new Set(),
    msFilters: {
      warehouse: new Set(),
      group: new Set(),
      sku: new Set(),
      nomenclature: new Set(),
      plus: new Set(),
      rating: new Set(),
      status: new Set(),
    },
    msOptions: {
      warehouse: [],
      group: [],
      sku: [],
      nomenclature: [],
      plus: [],
      rating: [],
      status: [],
    },
    msLimits: {
      warehouse: 500,
      group: 500,
      sku: 500,
      nomenclature: 500,
      plus: 500,
      rating: 500,
      status: 500,
    },
    searchNameLimit: 300,
    staryoMode: true,
    staryoRows: new Set(),
    sales12Only: false,
    unmarkedOnly: false,

    lastLoadedFile: null,
    justResizedColumn: false,
    rowHeightPx: 33,
    vStart: 0,
    vEnd: 0,
    overstockLimit: 500,
    ovSortKey: 'overstockValue',
    ovSortDir: 'desc',
    ovColWidths: null,
  };

  let nomenclatureProperties = {};
  const retiredGlobalPropertyKeys = new Set();
  let propertiesQueue = Promise.resolve();
  let propertiesDirty = false;
  let propertiesRevision = 0;
  function propertyKey(it) {
    const sku = String(it.sku || '').trim();
    return sku ? JSON.stringify(['sku', sku, String(it.warehouse || '').trim()]) : JSON.stringify(['name', String(it.group || '').trim(), String(it.name || '').trim(), String(it.warehouse || '').trim()]);
  }
  function applyNomenclatureProperties() {
    if (!state.report) return;
    // Однократный перенос старых общих отметок в отдельные свойства известных складов.
    const migrated = new Set();
    for (const it of state.report.items) {
      const parts = JSON.parse(propertyKey(it)); parts.pop();
      const oldKey = JSON.stringify(parts);
      if (Object.hasOwn(nomenclatureProperties, oldKey)) {
        const key = propertyKey(it);
        if (!Object.hasOwn(nomenclatureProperties, key)) nomenclatureProperties[key] = nomenclatureProperties[oldKey];
        migrated.add(oldKey);
      }
    }
    for (const key of migrated) { delete nomenclatureProperties[key]; retiredGlobalPropertyKeys.add(key); }
    if (migrated.size) { propertiesDirty = true; propertiesRevision += 1; }
    for (const it of state.report.items) {
      const key = propertyKey(it);
      if (!Object.hasOwn(nomenclatureProperties, key)) continue;
      if (nomenclatureProperties[key]) {
        state.staryoRows.add(it.excelRow);
        if (it._unmarkedAutoOrderQty === undefined) it._unmarkedAutoOrderQty = it.autoOrderQty;
        it.autoOrderQty = 0;
        if (it.manualOverride == null && !state.pendingOverrides.has(it.excelRow)) it.finalOrderQty = 0;
      } else {
        state.staryoRows.delete(it.excelRow);
        if (it._unmarkedAutoOrderQty !== undefined) {
          it.autoOrderQty = it._unmarkedAutoOrderQty;
          if (it.manualOverride == null && !state.pendingOverrides.has(it.excelRow)) it.finalOrderQty = it.autoOrderQty;
          delete it._unmarkedAutoOrderQty;
        }
      }
    }
  }
  function rememberNomenclatureProperties(items = state.report?.items || []) {
    if (!state.report) return;
    // Свойство относится только к товару на конкретном складе.
    for (const it of items) {
      const checked = state.staryoRows.has(it.excelRow);
      const key = propertyKey(it);
      if (checked !== Boolean(nomenclatureProperties[key])) nomenclatureProperties[key] = checked;
    }
    applyNomenclatureProperties();
    propertiesRevision += 1;
    propertiesDirty = true;
    state.hasUnsavedChanges = true;
  }
  function syncProperties(save = false) {
    const snapshot = {...nomenclatureProperties};
    const revision = propertiesRevision, epoch = state.clientEpoch;
    const request = propertiesQueue.catch(() => {}).then(() => apiPost('api/properties', {properties:snapshot,save,removeKeys:[...retiredGlobalPropertyKeys]}, {unabortable:true})).then(result => {
      if (result.state?.report && propertiesRevision === revision && state.clientEpoch === epoch) applyEnvelope(result.state);
      return result;
    });
    propertiesQueue = request;
    return request;
  }
  async function saveProperties(notify = true) {
    try {
      const revision = propertiesRevision;
      const res = await syncProperties(true);
      if (revision === propertiesRevision) propertiesDirty = false;
      if (notify) showToast(`Свойства сохранены: ${res.fileName}`);
      return true;
    } catch (err) {
      const message = err instanceof TypeError && /fetch|network|load failed/i.test(err.message)
        ? 'Нет связи с программой. Встроенный сервер недоступен; свойства не сохранены.'
        : err.message;
      showToast(`Ошибка сохранения свойств: ${message}`);
      return false;
    }
  }

  const el = (id) => document.getElementById(id);

  function abortActiveRequests() {
    for (const ctrl of activeControllers) {
      try { ctrl.abort(); } catch (_) {}
    }
    activeControllers.clear();
  }

  function indexReportItems(rep) {
    state.rowMap.clear();
    if (!rep?.items) return;
    const items = rep.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      state.rowMap.set(it.excelRow, it);
      const rawSku = String(it.sku || '');
      it._skuLC = rawSku.toLowerCase();
      it._startsWithPlus = rawSku.trimStart().startsWith('+');
      it._nameLC = String(it.name || '').toLowerCase();
      it._supNorm = it.supplier || '(Поставщик не указан)';
      if (it.isOverstock) {
        it._ovSearchLC = `${it.name || ''} ${rawSku} ${it.group || ''} ${it.supplier || ''} ${it.warehouse || ''}`.toLowerCase();
      }
    }
  }

  function normalizeSupName(raw) {
    const s = String(raw ?? '').trim();
    return s || '(Поставщик не указан)';
  }

  function isSupplierChecked(rawSup) {
    return state.checkedSuppliers.has(normalizeSupName(rawSup));
  }

  function syncSelectedSuppliersToServer() {
    return apiPost('api/selected-suppliers', {
      suppliers: [...state.checkedSuppliers],
    }).catch(() => {});
  }

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

  const MS_META = {
    warehouse: { labelId: 'lblMsWarehouse', listId: 'listMsWarehouse', menuId: 'menuMsWarehouse', defaultText: 'Все склады', prefix: 'Склады' },
    group: { labelId: 'lblMsGroup', listId: 'listMsGroup', menuId: 'menuMsGroup', defaultText: 'Все группы', prefix: 'Группы' },
    sku: { labelId: 'lblMsSku', listId: 'listMsSku', menuId: 'menuMsSku', defaultText: 'Артикул', prefix: 'Артикул' },
    nomenclature: { labelId: 'lblMsNomenclature', listId: 'listMsNomenclature', menuId: 'menuMsNomenclature', defaultText: 'Номенклатура', prefix: 'Номенклатура' },
    plus: { labelId: 'lblMsPlus', listId: 'listMsPlus', menuId: 'menuMsPlus', defaultText: '+', prefix: '+' },
    rating: { labelId: 'lblMsRating', listId: 'listMsRating', menuId: 'menuMsRating', defaultText: 'Рейтинг: Все', prefix: 'Рейтинг' },
    status: { labelId: 'lblMsStatus', listId: 'listMsStatus', menuId: 'menuMsStatus', defaultText: 'Показать все строки', prefix: 'Строки' },
  };

  function clearAllMultiSelectFilters() {
    state.colFilters = {};
    Object.values(state.msFilters).forEach((s) => s.clear());
    document.querySelectorAll('[data-ms-search]').forEach((inp) => { inp.value = ''; });
    if (el('fltWarehouse')) el('fltWarehouse').value = '';
    if (el('fltGroup')) el('fltGroup').value = '';
    if (el('fltABCXYZ')) el('fltABCXYZ').value = '';
    if (el('fltStatus')) el('fltStatus').value = 'all';
  }

  function hasActiveTableFilter() {
    return Boolean(
      Object.keys(state.colFilters).length > 0 ||
      state.sales12Only || state.unmarkedOnly ||
      el('inpSearch')?.value.trim() ||
      el('fltSupplier')?.value ||
      state.msFilters.warehouse.size > 0 ||
      state.msFilters.group.size > 0 ||
      state.msFilters.sku.size > 0 ||
      state.msFilters.nomenclature.size > 0 ||
      (state.msFilters.plus.size > 0 && state.msFilters.plus.size < 2) ||
      state.msFilters.rating.size > 0 ||
      state.msFilters.status.size > 0
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
      .sort((a, b) => ruCollator.compare(a.warehouse, b.warehouse));

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
        if (a.warehouse !== b.warehouse) return ruCollator.compare(a.warehouse, b.warehouse);
        return ruCollator.compare(a.supplier, b.supplier);
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
    const ctrl = new AbortController();
    activeControllers.add(ctrl);
    try {
      const res = await fetch(path, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Ошибка HTTP ${res.status}`);
      return data;
    } finally {
      activeControllers.delete(ctrl);
    }
  }

  async function apiPost(path, body, opts = {}) {
    const ctrl = new AbortController();
    if (!opts.unabortable) activeControllers.add(ctrl);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Ошибка HTTP ${res.status}`);
      return data;
    } finally {
      activeControllers.delete(ctrl);
    }
  }

  function resetTableColumnWidths(table) {
    if (!table) return;
    table.classList.remove('table-manual-cols');
    table.style.width = '';
    table.querySelector('colgroup')?.remove();
    table.querySelectorAll('thead th').forEach((h) => { h.style.width = ''; });
  }

  function readTableColumnWidths(table) {
    if (!table || !table.classList.contains('table-manual-cols')) return null;
    const cols = [...table.querySelectorAll(':scope > colgroup > col')];
    if (cols.length === 0) return null;
    const widths = cols.map((c) => c.style.width.endsWith('%') ? Math.round(parseFloat(c.style.width) * table.getBoundingClientRect().width / 100) : parseInt(c.style.width, 10)).filter((n) => Number.isFinite(n) && n > 0);
    return widths.length === cols.length ? widths : null;
  }

  // Нормализуем также ширины из старых баз: ни один colgroup не расширяет таблицу.
  function fitTableToViewport(table) {
    const cols = [...table.querySelectorAll(':scope > colgroup > col')];
    const widths = cols.map(col => parseFloat(col.style.width) || 1);
    const total = widths.reduce((sum, width) => sum + width, 0);
    cols.forEach((col, idx) => { col.style.width = `${widths[idx] * 100 / total}%`; });
    table.querySelectorAll('thead th').forEach(th => { th.style.width = ''; });
    table.style.width = '100%';
  }

  function applyTableColumnWidths(table, widths) {
    if (!table || !Array.isArray(widths) || widths.length === 0) return;
    const headRow = table.querySelector('thead tr');
    if (!headRow) return;
    const allThs = [...headRow.querySelectorAll('th')];
    const targetThs = table.id === 'itemsTable' && !state.staryoMode
      ? allThs.filter((h) => !h.classList.contains('plus-col'))
      : allThs;
    if (targetThs.length !== widths.length) return;
    table.querySelector(':scope > colgroup')?.remove();
    const colgroup = document.createElement('colgroup');
    widths.forEach((w, idx) => {
      const col = document.createElement('col');
      col.style.width = `${w}px`;
      colgroup.appendChild(col);
      targetThs[idx].style.width = `${w}px`;
    });
    table.insertBefore(colgroup, table.firstChild);
    table.classList.add('table-manual-cols');
    fitTableToViewport(table);
  }

  const COLUMN_WIDTHS_KEY = 'ostatki.savedColumnWidths.v1';
  let savedColumnWidths = {};
  function restoreSavedFields() {
    try {
      const saved = savedColumnWidths;
      for (const id of ['itemsTable','suppliersTable']) {
        const widths = saved[id];
        if (Array.isArray(widths) && widths.every(n => Number.isFinite(n) && n > 0)) applyTableColumnWidths(el(id), widths);
      }
    } catch (_) { /* Отсутствие настроек не мешает загрузке базы. */ }
  }
  async function saveFields() {
    try {
      const saved = {...savedColumnWidths};
      for (const id of ['itemsTable','suppliersTable']) {
        const table = el(id);
        if (!table) continue;
        const cols = [...table.querySelectorAll(':scope > colgroup > col')];
        const widths = cols.length ? cols.map(col => parseFloat(col.style.width)) : [...table.querySelectorAll('thead tr:first-child th')].map(th => th.getBoundingClientRect().width);
        if (widths.length && widths.every(n => Number.isFinite(n) && n > 0)) saved[id] = widths;
      }
      await apiPost('api/column-widths', {widths:saved});
      savedColumnWidths = saved;
      try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(saved)); } catch (_) {}
      state.hasUnsavedChanges = true;
      showToast('Ширина столбцов сохранена');
    } catch (err) { showToast(`Не удалось сохранить поля: ${err.message}`); }
  }

  function switchTabUI(tabName) {
    const nextTab = ['table', 'suppliers', 'overstock'].includes(tabName) ? tabName : 'table';
    state.activeTab = nextTab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === nextTab));
    document.querySelectorAll('.tab-view').forEach((v) => v.classList.toggle('active', v.id === `view-${nextTab}`));
  }

  function collectPendingOverridesSnapshot() {
    const out = {};
    for (const [rNum, qty] of state.pendingOverrides.entries()) {
      out[rNum] = qty;
    }
    const activeInp = document.activeElement?.matches?.('input[data-qty-row]') ? document.activeElement : null;
    if (activeInp && activeInp.dataset.dirty === '1') {
      const rNum = Number(activeInp.dataset.qtyRow);
      if (rNum > 0) {
        out[rNum] = parseQtyInput(activeInp.value);
      }
    }
    return out;
  }

  function collectUIState() {
    const whArr = [...state.msFilters.warehouse];
    const grpArr = [...state.msFilters.group];
    const skuArr = [...state.msFilters.sku];
    const nomArr = [...state.msFilters.nomenclature];
    const plusArr = [...state.msFilters.plus];
    const ratArr = [...state.msFilters.rating];
    const stArr = [...state.msFilters.status];
    return {
      colFilters: state.colFilters,
      staryoMode: Boolean(state.staryoMode),
      staryoRows: [...state.staryoRows].sort((a, b) => a - b),
      activeTab: state.activeTab || 'table',
      activePreset: document.querySelector('.preset-chip.active')?.dataset.preset || 'standard',
      paramsExpanded: !el('paramsBody')?.classList.contains('hidden'),
      selectedExcelRow: state.selectedExcelRow,
      sortKey: state.sortKey || 'finalOrderQty',
      sortDir: state.sortDir || 'desc',
      fltWarehouse: whArr.join(' + '),
      fltGroup: grpArr[0] || '',
      fltSupplier: el('fltSupplier')?.value || '',
      fltSupplierSearch: el('inpSupplierFilter')?.value || '',
      fltRating: ratArr[0] || '',
      fltStatus: stArr[0] || 'all',
      fltWarehouses: whArr,
      fltGroups: grpArr,
      fltSkus: skuArr,
      fltNomenclatures: nomArr,
      fltPlus: plusArr,
      fltRatings: ratArr,
      fltStatuses: stArr,
      searchSku: '',
      searchName: el('inpSearch')?.value || '',
      ovFltWarehouse: el('ovFltWarehouse')?.value || '',
      ovFltName: el('ovFltName')?.value || '',
      ovFltRating: el('ovFltRating')?.value || '',
      ovFltSupplier: el('ovFltSupplier')?.value || '',
      ovSearch: el('ovInpSearch')?.value || '',
      ovSortKey: state.ovSortKey || 'overstockValue',
      ovSortDir: state.ovSortDir || 'desc',
      overstockLimit: state.overstockLimit ?? 500,
      tableColWidths: readTableColumnWidths(el('itemsTable')),
      suppliersColWidths: readTableColumnWidths(el('suppliersTable')),
      ovColWidths: Array.isArray(state.ovColWidths) ? [...state.ovColWidths] : null,
      scrollY: Math.round(el('tableScrollContainer').scrollTop || 0),
    };
  }

  function resetUIToEmptyDatabase() {
    hideRatingChartPopover();
    state.report = null;
    state.rowMap.clear();
    state.canSaveInPlace = false;
    state.sourceFileName = '';
    state.savedFileName = '';
    state.lastSavedAt = '';
    state.hasUnsavedChanges = false;
    state.filteredItems = [];
    state.selectedExcelRow = null;
    state.sortKey = 'finalOrderQty';
    state.sortDir = 'desc';
    state.vStart = 0;
    state.vEnd = 0;
    state.overstockLimit = 500;
    state.ovSortKey = 'overstockValue';
    state.ovSortDir = 'desc';
    state.ovColWidths = null;
    state.pendingOverrides.clear();
    state.checkedSuppliers.clear();
    clearAllMultiSelectFilters();
    Object.keys(state.msOptions).forEach((k) => { state.msOptions[k] = []; });
    state.staryoRows.clear();
    state.staryoMode = true;
    state.sales12Only = false; state.unmarkedOnly = false; syncPropertyFilters();

    state.lastLoadedFile = null;

    if (el('itemsTable')) {
      resetTableColumnWidths(el('itemsTable'));
      el('itemsTable').classList.add('show-plus-col');
    }
    if (el('suppliersTable')) {
      resetTableColumnWidths(el('suppliersTable'));
    }
    if (el('staryoExportRows')) el('staryoExportRows').value = '';
    if (el('fileInput')) el('fileInput').value = '';
    if (el('savedDbFileInput')) el('savedDbFileInput').value = '';
    if (el('btnSaveInPlace')) el('btnSaveInPlace').classList.add('hidden');
    if (el('inpSearch')) el('inpSearch').value = '';
    if (el('ddSearchNameMenu')) el('ddSearchNameMenu').classList.add('hidden');
    if (el('inpSupplierFilter')) el('inpSupplierFilter').value = '';
    if (el('fltABCXYZ')) el('fltABCXYZ').value = '';
    if (el('fltStatus')) el('fltStatus').value = 'all';
    if (el('fltWarehouse')) el('fltWarehouse').innerHTML = '<option value="">Все склады</option>';
    if (el('fltGroup')) el('fltGroup').innerHTML = '<option value="">Все группы</option>';
    if (el('fltSupplier')) el('fltSupplier').innerHTML = '<option value="">Все поставщики</option>';
    if (el('supplierDropdownLabel')) el('supplierDropdownLabel').textContent = 'Все поставщики';
    if (el('supplierDropdownList')) el('supplierDropdownList').innerHTML = '';
    if (el('supplierDropdownMenu')) el('supplierDropdownMenu').classList.add('hidden');
    syncMultiSelectLabels();
    closeAllMultiSelectMenus();
    if (el('ovFltWarehouse')) el('ovFltWarehouse').innerHTML = '<option value="">Все склады</option>';
    if (el('ovFltName')) el('ovFltName').innerHTML = '<option value="">Вся номенклатура</option>';
    if (el('ovFltRating')) el('ovFltRating').value = '';
    if (el('ovFltSupplier')) el('ovFltSupplier').innerHTML = '<option value="">Все поставщики</option>';
    if (el('ovInpSearch')) el('ovInpSearch').value = '';
    if (el('btnResetOverstockFilters')) el('btnResetOverstockFilters').classList.add('hidden');
    switchTabUI('table');

    if (el('fileMetaLine')) el('fileMetaLine').textContent = 'База очищена • Нажмите «Загрузить новую базу» или «Загрузить сохраненную базу»';
    if (el('kpiOrderCost')) el('kpiOrderCost').textContent = '0,00 руб.';
    renderCurrentSupplier();
    if (el('cntTabTable')) el('cntTabTable').textContent = '0';
    if (el('cntTabSuppliers')) el('cntTabSuppliers').textContent = '0';
    if (el('cntTabOverstock')) el('cntTabOverstock').textContent = '0';
    if (el('paginationInfo')) el('paginationInfo').textContent = 'База очищена (0 строк)';
    if (el('tableBody')) {
      el('tableBody').innerHTML = '<tr><td colspan="15" style="text-align:center;padding:32px;color:var(--text-muted)">База данных очищена — нажмите «Загрузить новую базу», «Загрузить сохраненную базу» или перетащите файл Ведомости</td></tr>';
    }
    if (el('tableFoot')) el('tableFoot').innerHTML = '';
    if (el('warehousesContainer')) el('warehousesContainer').innerHTML = '';
    if (el('suppliersBody')) {
      el('suppliersBody').innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">База данных очищена</td></tr>';
    }
    if (el('suppliersFoot')) el('suppliersFoot').innerHTML = '';
    if (el('overstockContainer')) {
      el('overstockContainer').innerHTML = '<p class="muted" style="margin:0;padding:12px 0">База данных очищена — загрузите файл Ведомости (.xlsx) для анализа неликвидов.</p>';
    }
    el('tableScrollContainer').scrollTop = 0;
  }

  function applyEnvelope(env, opts = {}) {
    if (!env) return;
    state.canSaveInPlace = Boolean(env.canSaveInPlace);
    state.desktopMode = Boolean(env.desktopMode);
    state.sourceFileName = env.sourceFileName || '';
    state.savedFileName = env.savedFileName || '';
    state.lastSavedAt = env.lastSavedAt || '';
    state.report = env.report || null;

    el('btnSaveInPlace')?.classList.toggle('hidden', !state.canSaveInPlace);
    if (!state.report) {
      resetUIToEmptyDatabase();
      return;
    }

    indexReportItems(state.report);

    const shouldRestoreSaved = Boolean(opts.restoreSaved || (opts.initialBoot && env.savedFileName));

    if (opts.freshNewDb) {
      state.lastLoadedFile = state.report.fileName;
      state.overstockLimit = 500;
      state.ovSortKey = 'overstockValue';
      state.ovSortDir = 'desc';
      state.ovColWidths = null;
      state.sortKey = 'finalOrderQty';
      state.sortDir = 'desc';
      state.staryoMode = true;
      state.staryoRows.clear();
      state.sales12Only = false; state.unmarkedOnly = false; syncPropertyFilters();

      state.checkedSuppliers.clear();
      clearAllMultiSelectFilters();
      state.hasUnsavedChanges = true;
      resetTableColumnWidths(el('itemsTable'));
      resetTableColumnWidths(el('suppliersTable'));
      el('itemsTable')?.classList.add('show-plus-col');
      if (el('fltSupplier')) el('fltSupplier').value = '';
      if (el('inpSupplierFilter')) el('inpSupplierFilter').value = '';
      if (el('inpSearch')) el('inpSearch').value = '';
      if (el('ddSearchNameMenu')) el('ddSearchNameMenu').classList.add('hidden');
      if (el('ovFltWarehouse')) el('ovFltWarehouse').value = '';
      if (el('ovFltName')) el('ovFltName').value = '';
      if (el('ovFltRating')) el('ovFltRating').value = '';
      if (el('ovFltSupplier')) el('ovFltSupplier').value = '';
      if (el('ovInpSearch')) el('ovInpSearch').value = '';
      switchTabUI('table');
      syncSelectedSuppliersToServer();
    } else if (shouldRestoreSaved) {
      state.lastLoadedFile = state.report.fileName;
      state.pendingOverrides.clear();
      state.checkedSuppliers = new Set((env.selectedSuppliers || []).map(normalizeSupName));
      state.hasUnsavedChanges = false;
    } else if (state.lastLoadedFile !== state.report.fileName) {
      state.lastLoadedFile = state.report.fileName;
      state.overstockLimit = 500;
      state.checkedSuppliers.clear();
      clearAllMultiSelectFilters();
      state.staryoRows.clear();
      syncSelectedSuppliersToServer();
    }

    if (state.pendingOverrides.size > 0) {
      for (const [rNum, qty] of state.pendingOverrides.entries()) {
        const target = state.rowMap.get(rNum);
        if (target) {
          target.finalOrderQty = qty;
          target.manualOverride = qty;
        }
      }
    }
    recomputeReportSummaries(state.report);
    syncParamsControls(state.report);

    if (shouldRestoreSaved) {
      const ui = env.uiState || {};
      state.staryoMode = true;
      state.staryoRows = new Set((ui.staryoRows || []).map(Number).filter((n) => n > 0));
      state.sales12Only = false; state.unmarkedOnly = false; syncPropertyFilters();

      state.selectedExcelRow = ui.selectedExcelRow ?? null;
      state.sortKey = ui.sortKey || 'finalOrderQty';
      state.sortDir = ui.sortDir || 'desc';
      state.ovSortKey = ui.ovSortKey || 'overstockValue';
      state.ovSortDir = ui.ovSortDir || 'desc';
      state.overstockLimit = ui.overstockLimit ?? 500;
      state.ovColWidths = Array.isArray(ui.ovColWidths) && ui.ovColWidths.length > 0 ? [...ui.ovColWidths] : null;

      clearAllMultiSelectFilters();
      state.colFilters = {};
      resetTableColumnWidths(el('itemsTable'));
      resetTableColumnWidths(el('suppliersTable'));
      el('itemsTable')?.classList.toggle('show-plus-col', state.staryoMode);

      const activePreset = ui.activePreset || 'standard';
      document.querySelectorAll('.preset-chip').forEach((c) => {
        c.classList.toggle('active', c.dataset.preset === activePreset);
      });
      const paramsBody = el('paramsBody');
      const expanded = false;
      if (paramsBody) {
        paramsBody.classList.toggle('hidden', !expanded);
        el('paramsPanel').classList.toggle('hidden', !expanded);
        el('btnToggleAdvanced')?.setAttribute('aria-expanded', String(expanded));
        if (el('btnToggleAdvanced')) {
          el('btnToggleAdvanced').textContent = expanded ? 'Параметры ▾' : 'Параметры ▸';
        }
      }

      if (el('inpSupplierFilter')) el('inpSupplierFilter').value = '';
      if (el('fltSupplier')) el('fltSupplier').value = '';
      populateFilterDropdowns(state.report);
      if (el('fltSupplier')) el('fltSupplier').value = '';
      if (el('inpSearch')) el('inpSearch').value = '';
      populateFilterDropdowns(state.report);

      if (el('ovFltWarehouse')) el('ovFltWarehouse').value = '';
      if (el('ovFltSupplier')) el('ovFltSupplier').value = '';
      if (el('ovFltName')) el('ovFltName').value = '';
      renderOverstockView(state.report);
      if (el('ovFltWarehouse')) el('ovFltWarehouse').value = '';
      if (el('ovFltSupplier')) el('ovFltSupplier').value = '';
      renderOverstockView(state.report);
      if (el('ovFltName')) el('ovFltName').value = '';
      if (el('ovFltRating')) el('ovFltRating').value = '';
      if (el('ovInpSearch')) el('ovInpSearch').value = '';

      for (const it of state.report.items) {
        const key = propertyKey(it);
        if (!Object.hasOwn(nomenclatureProperties, key) && state.staryoRows.has(it.excelRow)) {
          nomenclatureProperties[key] = true;
          propertiesDirty = true;
          propertiesRevision += 1;
        }
      }
      applyNomenclatureProperties();
      switchTabUI(ui.activeTab || 'table');
      recomputeFilteredList();
      renderKPIs(state.report);
      if (state.selectedExcelRow == null && state.filteredItems.length > 0) {
        state.selectedExcelRow = state.filteredItems[0].excelRow;
      }
      renderTable();
      renderSuppliersView(state.report);
      renderOverstockView(state.report);
      applyTableColumnWidths(el('itemsTable'), ui.tableColWidths);
      applyTableColumnWidths(el('suppliersTable'), ui.suppliersColWidths);
      restoreSavedFields();

      const targetScroll = Number(ui.scrollY) || 0;
      requestAnimationFrame(() => {
        el('tableScrollContainer').scrollTop = targetScroll;
        if (state.filteredItems.length > VIRTUAL_THRESHOLD) {
          renderTableBodyWindow(true);
        }
      });
      return;
    }

    applyNomenclatureProperties();
    populateFilterDropdowns(state.report);
    recomputeFilteredList();
    renderKPIs(state.report);

    if (state.selectedExcelRow == null && state.filteredItems.length > 0) {
      state.selectedExcelRow = state.filteredItems[0].excelRow;
    }

    renderTable();
    renderSuppliersView(state.report);
    renderOverstockView(state.report);
    restoreSavedFields();
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

  function syncMultiSelectLabels() {
    for (const [key, meta] of Object.entries(MS_META)) {
      const selSet = state.msFilters[key];
      const lblEl = el(meta.labelId);
      const trigEl = document.querySelector(`[data-ms-trigger="${key}"]`);
      if (!lblEl) continue;

      if (key === 'plus' && (selSet.size === 0 || selSet.size >= 2)) {
        lblEl.textContent = meta.defaultText;
        trigEl?.classList.remove('has-active-ms');
        continue;
      }
      if (selSet.size === 0) {
        lblEl.textContent = meta.defaultText;
        trigEl?.classList.remove('has-active-ms');
        continue;
      }
      trigEl?.classList.add('has-active-ms');
      if (selSet.size === 1) {
        const onlyVal = [...selSet][0];
        const found = (state.msOptions[key] || []).find((o) => o.value === onlyVal);
        if (key === 'plus') {
          lblEl.textContent = onlyVal === 'checked' ? '+ : ✓' : '+ : пусто';
        } else {
          lblEl.textContent = found ? found.shortLabel || found.label : onlyVal;
        }
      } else {
        lblEl.textContent = `${meta.prefix}: ${selSet.size}`;
      }
    }
  }

  function closeAllMultiSelectMenus(exceptKey = null) {
    for (const [key, meta] of Object.entries(MS_META)) {
      if (key === exceptKey) continue;
      const menu = el(meta.menuId);
      const trig = document.querySelector(`[data-ms-trigger="${key}"]`);
      if (menu && !menu.classList.contains('hidden')) {
        menu.classList.add('hidden');
        trig?.setAttribute('aria-expanded', 'false');
      }
    }
    if (exceptKey !== 'searchName') {
      el('ddSearchNameMenu')?.classList.add('hidden');
    }
  }

  function renderMultiSelectMenu(key) {
    const meta = MS_META[key];
    if (!meta) return;
    const listEl = el(meta.listId);
    if (!listEl) return;

    const searchInp = document.querySelector(`[data-ms-search="${key}"]`);
    const q = (searchInp?.value || '').trim().toLowerCase();
    const opts = state.msOptions[key] || [];
    const selSet = state.msFilters[key];

    const filtered = q
      ? opts.filter((o) => o.searchLC.includes(q))
      : opts;

    const limit = state.msLimits[key] || 500;
    const visible = filtered.slice(0, limit);
    const remaining = filtered.length - visible.length;

    if (visible.length === 0) {
      listEl.innerHTML = '<div class="muted" style="padding:10px 8px;text-align:center">Ничего не найдено</div>';
      return;
    }

    const rowsHtml = visible.map((o) => {
      const checked = selSet.has(o.value);
      return `<div class="supplier-dd-row ${checked ? 'active-filter' : ''}">
        <label class="ms-dd-option-label" title="${esc(o.label)}">
          <input type="checkbox" class="supplier-dd-check" data-ms-check="${key}" value="${esc(o.value)}" ${checked ? 'checked' : ''} />
          <span class="ms-dd-option-text">${esc(o.label)}</span>
        </label>
      </div>`;
    }).join('');

    const moreHtml = remaining > 0
      ? `<div style="padding:6px 8px;text-align:center">
          <button type="button" class="btn btn-beige btn-xs" data-ms-more="${key}">Показать ещё (${fmtInt(remaining)})</button>
        </div>`
      : '';

    listEl.innerHTML = rowsHtml + moreHtml;
  }

  function renderSearchNameDropdown() {
    const menuEl = el('ddSearchNameMenu');
    const listEl = el('listSearchNameMatches');
    if (!menuEl || !listEl || !state.report) return;

    const q = (el('inpSearch')?.value || '').trim().toLowerCase();
    const opts = state.msOptions.nomenclature || [];
    const selSet = state.msFilters.nomenclature;

    const matches = q
      ? opts.filter((o) => o.searchLC.includes(q))
      : opts;

    const visible = matches.slice(0, state.searchNameLimit || 300);
    const remaining = matches.length - visible.length;

    if (visible.length === 0) {
      listEl.innerHTML = '<div class="muted" style="padding:10px 8px;text-align:center">Совпадений по номенклатуре не найдено</div>';
      return;
    }

    const rowsHtml = visible.map((o) => {
      const checked = selSet.has(o.value);
      return `<div class="supplier-dd-row ${checked ? 'active-filter' : ''}">
        <label class="ms-dd-option-label" title="${esc(o.label)}">
          <input type="checkbox" class="supplier-dd-check" data-search-name-check="1" value="${esc(o.value)}" ${checked ? 'checked' : ''} />
          <span class="ms-dd-option-text">${esc(o.label)}</span>
        </label>
      </div>`;
    }).join('');

    const moreHtml = remaining > 0
      ? `<div style="padding:6px 8px;text-align:center">
          <button type="button" class="btn btn-beige btn-xs" id="btnSearchNameMore">Показать ещё (${fmtInt(remaining)})</button>
        </div>`
      : '';

    listEl.innerHTML = rowsHtml + moreHtml;
  }

  function populateFilterDropdowns(rep) {
    const whSet = state.msFilters.warehouse;
    const grpSet = state.msFilters.group;
    const skuSet = state.msFilters.sku;

    state.msOptions.warehouse = (rep.warehouses || []).map((w) => {
      const label = `${w.warehouse} — ${fmtMoney(w.totalOrderCost)} р. (${w.orderItems}/${w.totalItems})`;
      return { value: w.warehouse, shortLabel: w.warehouse, label, searchLC: w.warehouse.toLowerCase() };
    });

    const grpAgg = new Map();
    for (const g of rep.groups || []) {
      grpAgg.set(g.group, { group: g.group, orderItemCount: 0 });
    }
    const skuAgg = new Map();
    const nomAgg = new Map();
    let plusCheckedTotal = 0;
    let plusUncheckedTotal = 0;
    const ratingCounts = [0, 0, 0, 0, 0, 0];
    let cntOrder = 0;
    let cntOutliers = 0;
    let cntOverstock = 0;
    let cntZero = 0;
    let cntManual = 0;

    for (let i = 0; i < rep.items.length; i++) {
      const it = rep.items[i];
      if (state.sales12Only && !(Number(it.sumSalesLast12M) > 0)) continue;
      if (state.unmarkedOnly && state.staryoRows.has(it.excelRow)) continue;
      if (whSet.size > 0 && !whSet.has(it.warehouse)) continue;

      if (it.finalOrderQty > 0) {
        const gEntry = grpAgg.get(it.group) || { group: it.group, orderItemCount: 0 };
        gEntry.orderItemCount += 1;
        grpAgg.set(it.group, gEntry);
      } else if (!grpAgg.has(it.group)) {
        grpAgg.set(it.group, { group: it.group, orderItemCount: 0 });
      }

      if (grpSet.size > 0 && !grpSet.has(it.group)) continue;

      const rawSku = String(it.sku || '').trim();
      if (rawSku) {
        let sEntry = skuAgg.get(rawSku);
        if (!sEntry) {
          sEntry = { sku: rawSku, orderItemCount: 0 };
          skuAgg.set(rawSku, sEntry);
        }
        if (it.finalOrderQty > 0) sEntry.orderItemCount += 1;
      }

      if (skuSet.size > 0 && !skuSet.has(rawSku)) continue;

      const rawName = String(it.name || '').trim();
      if (rawName) {
        let nEntry = nomAgg.get(rawName);
        if (!nEntry) {
          nEntry = { name: rawName, orderItemCount: 0 };
          nomAgg.set(rawName, nEntry);
        }
        if (it.finalOrderQty > 0) nEntry.orderItemCount += 1;
      }

      if (state.staryoRows.has(it.excelRow)) plusCheckedTotal += 1;
      else plusUncheckedTotal += 1;

      const seg = Math.min(5, Math.max(0, Number(it.salesSegment) || 0));
      ratingCounts[seg] += 1;
      if (it.finalOrderQty > 0) cntOrder += 1;
      if (it.outlierMonths > 0) cntOutliers += 1;
      if (it.isOverstock) cntOverstock += 1;
      if (it.closingStock <= 0) cntZero += 1;
      if (it.manualOverride != null) cntManual += 1;
    }

    state.msOptions.group = [...grpAgg.values()].map((g) => ({
      value: g.group,
      shortLabel: g.group,
      label: `${g.group} (к закупке: ${g.orderItemCount})`,
      searchLC: g.group.toLowerCase(),
    }));

    const skuList = [...skuAgg.values()].sort((a, b) => ruCollator.compare(a.sku, b.sku));
    state.msOptions.sku = skuList.map((s) => ({
      value: s.sku,
      shortLabel: s.sku,
      label: `${s.sku} (к закупке: ${s.orderItemCount})`,
      searchLC: s.sku.toLowerCase(),
    }));

    const nomList = [...nomAgg.values()].sort((a, b) => ruCollator.compare(a.name, b.name));
    state.msOptions.nomenclature = nomList.map((n) => ({
      value: n.name,
      shortLabel: n.name,
      label: `${n.name} (к закупке: ${n.orderItemCount})`,
      searchLC: n.name.toLowerCase(),
    }));

    state.msOptions.plus = [
      { value: 'checked', shortLabel: '+ : ✓', label: `Отмеченные галочкой «✓» (${fmtInt(plusCheckedTotal)})`, searchLC: 'отмеченные галочкой +' },
      { value: 'unchecked', shortLabel: '+ : пусто', label: `Без галочки (${fmtInt(plusUncheckedTotal)})`, searchLC: 'без галочки пустые' },
    ];

    state.msOptions.rating = [
      { value: '5', shortLabel: '5-Высокий', label: `5-Высокий (${fmtInt(ratingCounts[5])})`, searchLC: '5-высокий' },
      { value: '4', shortLabel: '4-Выше среднего', label: `4-Выше среднего (${fmtInt(ratingCounts[4])})`, searchLC: '4-выше среднего' },
      { value: '3', shortLabel: '3-Средний', label: `3-Средний (${fmtInt(ratingCounts[3])})`, searchLC: '3-средний' },
      { value: '2', shortLabel: '2-Ниже среднего', label: `2-Ниже среднего (${fmtInt(ratingCounts[2])})`, searchLC: '2-ниже среднего' },
      { value: '1', shortLabel: '1-Низкий', label: `1-Низкий (${fmtInt(ratingCounts[1])})`, searchLC: '1-низкий' },
      { value: '0', shortLabel: '0-Нет продаж', label: `0-Нет продаж (${fmtInt(ratingCounts[0])})`, searchLC: '0-нет продаж' },
    ];

    state.msOptions.status = [
      { value: 'order', shortLabel: 'Только Заказ > 0', label: `Только Заказ > 0 (${fmtInt(cntOrder)})`, searchLC: 'только заказ > 0' },
      { value: 'outliers', shortLabel: 'Подавленные выбросы', label: `⚡ Подавленные опт-выбросы (${fmtInt(cntOutliers)})`, searchLC: 'подавленные опт-выбросы' },
      { value: 'overstock', shortLabel: 'Неликвиды / избыток', label: `Неликвиды / избыток (${fmtInt(cntOverstock)})`, searchLC: 'неликвиды избыток' },
      { value: 'zero', shortLabel: 'Нулевой остаток', label: `Нулевой остаток (${fmtInt(cntZero)})`, searchLC: 'нулевой остаток' },
      { value: 'manual', shortLabel: 'Изменённые вручную', label: `Изменённые вручную (${fmtInt(cntManual)})`, searchLC: 'изменённые вручную' },
    ];

    if (el('fltWarehouse')) {
      el('fltWarehouse').value = whSet.size === 1 ? [...whSet][0] : '';
    }

    syncMultiSelectLabels();
    for (const [key, meta] of Object.entries(MS_META)) {
      if (!el(meta.menuId)?.classList.contains('hidden')) {
        renderMultiSelectMenu(key);
      }
    }
    if (!el('ddSearchNameMenu')?.classList.contains('hidden')) {
      renderSearchNameDropdown();
    }

    // Уникальные поставщики с учётом выбранных складов (поле «Все поставщики» остаётся без изменений)
    const supAgg = new Map();
    for (const s of rep.suppliers) {
      if (whSet.size > 0 && !whSet.has(s.warehouse)) continue;
      const prev = supAgg.get(s.supplier);
      if (!prev) {
        supAgg.set(s.supplier, { value: s.supplier, supplier: s.supplier, totalOrderCost: s.totalOrderCost, orderItems: s.orderItems });
      } else {
        prev.totalOrderCost = Math.round((prev.totalOrderCost + s.totalOrderCost) * 100) / 100;
        prev.orderItems += s.orderItems;
      }
    }
    const uniqueSuppliers = [...supAgg.values()].sort((a, b) => b.totalOrderCost - a.totalOrderCost || ruCollator.compare(a.supplier, b.supplier));

    const prevSup = el('fltSupplier')?.value || '';
    if (el('fltSupplier')) {
      el('fltSupplier').innerHTML = `<option value="">Все поставщики</option>` +
        uniqueSuppliers.map((s) => `<option value="${esc(s.supplier)}">${esc(s.supplier)} — ${fmtMoney(s.totalOrderCost)} р. (${s.orderItems})</option>`).join('');
      if ([...el('fltSupplier').options].some((o) => o.value === prevSup)) {
        el('fltSupplier').value = prevSup;
      }
    }

    renderSupplierDropdownMenu(rep, uniqueSuppliers);
  }

  function renderSupplierDropdownMenu(rep, uniqueSuppliers) {
    const activeSup = el('fltSupplier')?.value || '';
    const filterQuery = (el('inpSupplierFilter')?.value || '').trim().toLowerCase();

    let checkedCount = 0;
    let checkedSum = 0;
    for (const s of uniqueSuppliers) {
      if (isSupplierChecked(s.supplier)) {
        checkedCount += 1;
        checkedSum += Number(s.totalOrderCost) || 0;
      }
    }
    checkedSum = Math.round(checkedSum * 100) / 100;

    const labelEl = el('supplierDropdownLabel');
    if (labelEl) {
      if (activeSup) {
        const found = uniqueSuppliers.find((s) => s.supplier === activeSup);
        labelEl.textContent = found
          ? `${found.supplier} — ${fmtMoney(found.totalOrderCost)} р. (${found.orderItems})`
          : activeSup;
      } else if (checkedCount > 0) {
        labelEl.textContent = `Выбрано: ${checkedCount} пост. — ${fmtMoney(checkedSum)} р.`;
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
        Показать всех в таблице (${uniqueSuppliers.length})
      </button>
    </div>`;

    const rowsHtml = visibleSuppliers.map((s) => {
      const isChecked = isSupplierChecked(s.supplier);
      const isActive = activeSup === s.supplier;
      return `<div class="supplier-dd-row ${isActive ? 'active-filter' : ''}">
        <input type="checkbox" class="supplier-dd-check" data-sup-check="${esc(s.supplier)}" ${isChecked ? 'checked' : ''} title="Включить заказы поставщика в Бюджет закупки, статус «Готов к отправке» и выгрузку Excel" />
        <button type="button" class="supplier-dd-item-btn" data-sup-select="${esc(s.supplier)}" title="Фильтр таблицы по поставщику: ${esc(s.supplier)}">
          ${esc(s.supplier)}
        </button>
        <span class="supplier-dd-sum">${fmtMoney(s.totalOrderCost)} р. (${s.orderItems})</span>
      </div>`;
    }).join('');

    listEl.innerHTML = allRowHtml + rowsHtml;
  }

  function renderKPIs(rep) {
    const firstP = rep.periods[0]?.label || '';
    const lastP = rep.periods[rep.periods.length - 1]?.label || '';
    const savedSuffix = state.savedFileName
      ? ` • Сохранено: ${state.savedFileName}${state.lastSavedAt ? ` (${state.lastSavedAt.split(' ')[0]})` : ''}`
      : '';
    el('fileMetaLine').textContent =
      `Файл: ${rep.fileName} • Срез: ${rep.createdDate || 'н/д'} • Статистика: ${firstP} — ${lastP} (${rep.periods.length} мес.) • Позиций: ${fmtInt(rep.totalItems)} (к закупке: ${fmtInt(rep.orderItemsCount)} SKU / ${fmtInt(rep.totalOrderUnits)} ед.)${savedSuffix}`;

    // Бюджет зависит только от галочек поставщиков, не от видимости строк.
    const sourceItems = rep.items || [];

    let checkedBudget = 0;
    for (const it of sourceItems) {
      if (!isSupplierChecked(it.supplier)) continue;
      checkedBudget += calcLineSum(it.finalOrderQty, it.purchasePrice);
    }
    checkedBudget = Math.round(checkedBudget * 100) / 100;

    el('kpiOrderCost').textContent = `${fmtMoney(checkedBudget)} руб.`;
    renderCurrentSupplier();

    const readyRows = rep.suppliers.filter((s) => s.orderItems > 0 && isSupplierChecked(s.supplier));
    el('cntTabSuppliers').textContent = readyRows.length;
    el('cntTabOverstock').textContent = rep.overstockItemsCount;
  }

  function recomputeFilteredList() {
    if (!state.report) {
      state.filteredItems = [];
      return;
    }
    const qName = (el('inpSearch')?.value || '').trim().toLowerCase();
    const whSet = state.msFilters.warehouse;
    const grpSet = state.msFilters.group;
    const skuSet = state.msFilters.sku;
    const nomSet = state.msFilters.nomenclature;
    const plusSet = state.msFilters.plus;
    const ratSet = state.msFilters.rating;
    const stSet = state.msFilters.status;
    const sup = el('fltSupplier')?.value || '';

    let anyCheckedMatchesSearch = false;
    if (nomSet.size > 0 && qName) {
      for (const n of nomSet) {
        if (n.toLowerCase().includes(qName)) {
          anyCheckedMatchesSearch = true;
          break;
        }
      }
    }

    const src = state.report.items;
    const list = [];
    for (let i = 0; i < src.length; i++) {
      const it = src[i];
      if (state.sales12Only && !(Number(it.sumSalesLast12M) > 0)) continue;
      if (state.unmarkedOnly && state.staryoRows.has(it.excelRow)) continue;
      if (whSet.size > 0 && !whSet.has(it.warehouse)) continue;
      if (grpSet.size > 0 && !grpSet.has(it.group)) continue;
      if (skuSet.size > 0 && !skuSet.has(String(it.sku || '').trim())) continue;

      if (nomSet.size > 0) {
        const nameKey = String(it.name || '').trim();
        if (!qName || anyCheckedMatchesSearch) {
          if (!nomSet.has(nameKey)) continue;
        } else if (!nomSet.has(nameKey) && !(it._nameLC ?? String(it.name || '').toLowerCase()).includes(qName)) {
          continue;
        }
      } else if (qName && !(it._nameLC ?? String(it.name || '').toLowerCase()).includes(qName)) {
        continue;
      }

      if (plusSet.size === 1) {
        const hasPlus = state.staryoRows.has(it.excelRow);
        if (plusSet.has('checked') && !hasPlus) continue;
        if (plusSet.has('unchecked') && hasPlus) continue;
      }

      const itemSup = it._supNorm || it.supplier || '(Поставщик не указан)';
      if (sup && itemSup !== sup) continue;

      if (ratSet.size > 0 && !ratSet.has(String(it.salesSegment))) continue;

      if (stSet.size > 0) {
        const matchStatus =
          (stSet.has('order') && it.finalOrderQty > 0) ||
          (stSet.has('outliers') && it.outlierMonths > 0) ||
          (stSet.has('overstock') && it.isOverstock) ||
          (stSet.has('zero') && it.closingStock <= 0) ||
          (stSet.has('manual') && it.manualOverride != null);
        if (!matchStatus) continue;
      }

      if (!matchesExcelFilters(it)) continue;
      list.push(it);
    }

    const key = state.sortKey;
    const mult = state.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (key === '_staryoChecked') {
        const ca = state.staryoRows.has(a.excelRow) ? 1 : 0;
        const cb = state.staryoRows.has(b.excelRow) ? 1 : 0;
        if (ca !== cb) return (ca - cb) * mult;
        return a.excelRow - b.excelRow;
      }
      const va = a[key];
      const vb = b[key];
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va !== vb) return (va - vb) * mult;
        return a.excelRow - b.excelRow;
      }
      return ruCollator.compare(String(va ?? ''), String(vb ?? '')) * mult;
    });

    state.filteredItems = list;
    state.vStart = 0;
    state.vEnd = 0;
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

    const leadColspan = state.staryoMode ? 11 : 10;
    if (tfoot) {
      tfoot.innerHTML = `<tr>
        <td colspan="${leadColspan}" style="text-align:right;color:var(--text-muted)">Итого (к закупке: ${fmtInt(orderRows)} поз.):</td>
        <td class="num-col col-5digits" style="color:var(--primary)">${fmtInt(orderUnits)}</td>
        <td class="num-col"></td>
        <td class="num-col"></td>
        <td class="num-col">${fmtMoney(roundedOrderSum)}</td>
        <td>руб.</td>
      </tr>`;
    }
  }

  function buildTableRowHTML(it, index) {
    const isSelected = it.excelRow === state.selectedExcelRow;
    const isManual = it.manualOverride != null;
    const hasAutoOrder = it.autoOrderQty > 0;
    const hasPlus = state.staryoRows.has(it.excelRow);
    const segNum = Number(it.salesSegment) || 0;
    const surplusVal = Number(it.surplusStock) || 0;
    const surplusTitle = surplusVal > 0 || it.closingStock > 0
      ? ` title="Излишний запас: ${fmtInt(surplusVal)} шт. (остаток: ${fmtInt(it.closingStock)} шт., сезонная норма: ${fmtNum(it.targetStock, 2)} шт.)"`
      : '';
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
      <td class="row-number-cell">${index + 1}</td>
      <td class="wh-cell" title="${esc(it.warehouse)}">${esc(it.warehouse)}</td>
      <td class="grp-cell" title="${esc(it.group)}">${esc(it.group)}</td>
      <td class="sku-cell">${esc(it.sku)}</td>
      <td class="name-cell">${esc(it.name)}</td>
      <td class="unit-cell">шт.</td>
      <td class="num-col col-5digits"${surplusTitle}>${fmtInt(surplusVal)}</td>
      <td class="plus-cell"><input type="checkbox" class="plus-input${hasPlus ? ' has-plus' : ''}" ${hasPlus ? 'checked' : ''} data-plus-row="${it.excelRow}" title="Отметить галочкой для выгрузки «Старьё»" aria-label="Отметить галочкой" /></td>
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
  }

  function computeVirtualRange(total) {
    if (total <= VIRTUAL_THRESHOLD) {
      return { start: 0, end: total };
    }
    const tableEl = el('itemsTable');
    const rowH = Math.max(24, state.rowHeightPx || 33);
    let relScrollTop = 0;
    if (tableEl) {
      relScrollTop = el('tableScrollContainer').scrollTop;
    }
    const firstVisible = Math.floor(relScrollTop / rowH);
    const viewportRows = Math.ceil((el('tableScrollContainer').clientHeight || 900) / rowH);
    let start = Math.max(0, firstVisible - VIRTUAL_OVERSCAN);
    let end = Math.min(total, firstVisible + viewportRows + VIRTUAL_OVERSCAN);
    if (end - start < VIRTUAL_WINDOW) {
      end = Math.min(total, start + VIRTUAL_WINDOW);
      if (end - start < VIRTUAL_WINDOW) {
        start = Math.max(0, end - VIRTUAL_WINDOW);
      }
    }
    return { start, end };
  }

  function renderTableBodyWindow(force = true) {
    const tbody = el('tableBody');
    const slice = state.filteredItems;
    const total = slice.length;
    if (!tbody || total === 0) return;

    const activeEl = document.activeElement;
    const activeQtyRow = activeEl?.dataset?.qtyRow ? Number(activeEl.dataset.qtyRow) : null;
    const activeFresh = activeEl?.dataset?.freshEdit;
    const activeDirty = activeEl?.dataset?.dirty;
    const activeOrigQty = activeEl?.dataset?.origQty;
    const activeDraft = activeEl?.dataset?.qtyRow ? activeEl.value : null;

    if (total <= VIRTUAL_THRESHOLD) {
      state.vStart = 0;
      state.vEnd = total;
      tbody.innerHTML = slice.map(buildTableRowHTML).join('');
    } else {
      const { start, end } = computeVirtualRange(total);
      if (!force && start >= state.vStart && end <= state.vEnd) {
        return;
      }
      if (!force && Math.abs(start - state.vStart) < 20 && state.vEnd > 0) {
        return;
      }
      state.vStart = start;
      state.vEnd = end;

      const rowH = Math.max(24, state.rowHeightPx || 33);
      const topPx = Math.round(start * rowH);
      const bottomPx = Math.round((total - end) * rowH);

      const fullColspan = state.staryoMode ? 16 : 15;
      const parts = [];
      if (topPx > 0) {
        parts.push(`<tr class="virtual-spacer" aria-hidden="true"><td colspan="${fullColspan}" style="height:${topPx}px"></td></tr>`);
      }
      for (let i = start; i < end; i++) {
        parts.push(buildTableRowHTML(slice[i], i));
      }
      if (bottomPx > 0) {
        parts.push(`<tr class="virtual-spacer" aria-hidden="true"><td colspan="${fullColspan}" style="height:${bottomPx}px"></td></tr>`);
      }
      tbody.innerHTML = parts.join('');

      const sampleRow = tbody.querySelector('tr[data-row]');
      if (sampleRow) {
        const measured = sampleRow.getBoundingClientRect().height;
        if (measured >= 22 && measured <= 80 && Math.abs(measured - state.rowHeightPx) > 1.5) {
          state.rowHeightPx = measured;
        }
      }
    }

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
  }

  function renderTable() {
    const tbody = el('tableBody');
    const slice = state.filteredItems;
    const prevScrollY = el('tableScrollContainer').scrollTop;

    syncExcelHeaders();
    renderTableFooter();

    if (slice.length === 0) {
      const fullColspan = state.staryoMode ? 16 : 15;
      state.vStart = 0;
      state.vEnd = 0;
      tbody.innerHTML = `<tr><td colspan="${fullColspan}" style="text-align:center;padding:32px;color:var(--text-muted)">По заданным условиям фильтрации позиций не найдено</td></tr>`;
      return;
    }

    renderTableBodyWindow(true);

    el('tableScrollContainer').scrollTop = prevScrollY;
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
    const item = state.rowMap.get(excelRow) || state.report.items.find((x) => x.excelRow === excelRow);
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
    // Считаем сводки по складам строго по поставщикам с установленной галочкой
    const whCheckedStats = new Map();
    for (const w of rep.warehouses) {
      whCheckedStats.set(w.warehouse, { orderItems: 0, totalOrderQty: 0, totalOrderCost: 0, totalRetailVal: 0 });
    }
    for (const s of rep.suppliers) {
      if (!isSupplierChecked(s.supplier) || s.orderItems <= 0) continue;
      const ws = whCheckedStats.get(s.warehouse);
      if (ws) {
        ws.orderItems += Number(s.orderItems) || 0;
        ws.totalOrderQty += Number(s.totalOrderQty) || 0;
        ws.totalOrderCost = Math.round((ws.totalOrderCost + (Number(s.totalOrderCost) || 0)) * 100) / 100;
        ws.totalRetailVal = Math.round((ws.totalRetailVal + (Number(s.totalRetailVal) || 0)) * 100) / 100;
      }
    }

    el('warehousesContainer').innerHTML = rep.warehouses.map((w) => {
      const ws = whCheckedStats.get(w.warehouse) || { orderItems: 0, totalOrderQty: 0, totalOrderCost: 0, totalRetailVal: 0 };
      return `
      <div class="card-block">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <h3>${esc(w.warehouse)}</h3>
            <p class="muted" style="margin-bottom:8px">Всего: ${fmtInt(w.totalItems)} SKU • 0 остаток: ${fmtInt(w.zeroStockItems)} • Неликвидов: ${fmtInt(w.overstockItems)} (${fmtMoney(w.overstockCost)} р.)</p>
          </div>
          ${ws.orderItems > 0 ? `<a class="btn btn-secondary btn-sm" href="api/export/orders?warehouse=${encodeURIComponent(w.warehouse)}" style="text-decoration:none">
            Отчёт склада (.xlsx)
          </a>` : ''}
        </div>
        <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:4px">
          <div><span class="field-hint">Позиций к закупке</span><div style="font-size:18px;font-weight:700">${fmtInt(ws.orderItems)} SKU</div></div>
          <div><span class="field-hint">Единиц товара</span><div style="font-size:18px;font-weight:700;color:var(--primary)">${fmtInt(ws.totalOrderQty)} ед.</div></div>
          <div><span class="field-hint">Сумма закупки</span><div style="font-size:18px;font-weight:700">${fmtMoney(ws.totalOrderCost)} руб.</div></div>
          <div><span class="field-hint">Оценка в рознице</span><div style="font-size:18px;font-weight:700;color:var(--success)">${fmtMoney(ws.totalRetailVal)} руб.</div></div>
        </div>
      </div>
    `;
    }).join('');

    el('suppliersBody').innerHTML = rep.suppliers.map((s) => {
      const isChecked = isSupplierChecked(s.supplier);
      const isReadyToSend = isChecked && s.orderItems > 0;
      const orderQs = new URLSearchParams();
      if (s.warehouse) orderQs.set('warehouse', s.warehouse);
      if (s.supplier) orderQs.set('supplier', s.supplier);
      const orderHref = `api/export/supplier-order?${orderQs.toString()}`;
      const orderFileName = formatOrderFileName(s.warehouse, s.supplier);

      const statusBadge = !isChecked
        ? `<span class="badge" style="color:var(--text-muted)">Не отмечен</span>`
        : s.orderItems === 0
          ? `<span class="badge" style="color:var(--text-muted)">Нет потребности</span>`
          : `<span class="badge badge-green">Готов к отправке</span>`;

      return `<tr>
        <td class="wh-cell" title="${esc(s.warehouse)}">${esc(s.warehouse)}</td>
        <td>
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" class="supplier-dd-check" data-sup-row-check="${esc(s.supplier)}" ${isChecked ? 'checked' : ''} />
            <strong>${esc(s.supplier)}</strong>
          </label>
        </td>
        <td class="num-col">${fmtInt(s.totalItems)}</td>
        <td class="num-col">${fmtInt(s.orderItems)}</td>
        <td class="num-col" style="font-weight:700;color:var(--primary)">${fmtInt(s.totalOrderQty)}</td>
        <td class="num-col" style="font-weight:700">${fmtMoney(s.totalOrderCost)} руб.</td>
        <td class="num-col">${fmtMoney(s.totalRetailVal)} руб.</td>
        <td class="center-col">${statusBadge}</td>
        <td class="right-col" style="white-space:nowrap">
          <button class="btn btn-ghost btn-sm" data-filter-sup="${esc(s.supplier)}" data-filter-wh="${esc(s.warehouse || '')}">В таблице</button>
          ${isReadyToSend ? `<a class="btn btn-secondary btn-sm" href="${esc(orderHref)}" download="${esc(orderFileName)}" title="Скачать заказ: ${esc(orderFileName)}" style="text-decoration:none">Заказ .xlsx</a>` : ''}
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
      if (!isSupplierChecked(s.supplier)) continue;
      sumSupOrderSKU += Number(s.orderItems) || 0;
      sumSupOrderUnits += Number(s.totalOrderQty) || 0;
      sumSupOrderCost += Number(s.totalOrderCost) || 0;
      sumSupRetailVal += Number(s.totalRetailVal) || 0;
    }
    const supFoot = el('suppliersFoot');
    if (supFoot) {
      supFoot.innerHTML = `<tr>
        <td colspan="2" style="text-align:right;color:var(--text-muted)">Итого по отмеченным поставщикам:</td>
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
      .filter((it) => it.isOverstock && (!state.sales12Only || Number(it.sumSalesLast12M) > 0) && (!state.unmarkedOnly || !state.staryoRows.has(it.excelRow)))
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
      [...whAgg.values()].sort((a, b) => b.frozen - a.frozen || ruCollator.compare(a.warehouse, b.warehouse)),
      'Все склады',
      (w) => `${w.warehouse} (${w.count})`
    );
    setSelectOptions(
      el('ovFltSupplier'),
      [...supAgg.values()].sort((a, b) => b.frozen - a.frozen || ruCollator.compare(a.supplier, b.supplier)),
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
      if (nameCandidates.size >= 1500) break;
    }
    setSelectOptions(
      el('ovFltName'),
      [...nameCandidates].sort((a, b) => ruCollator.compare(a, b)),
      'Вся номенклатура'
    );

    const selName = el('ovFltName').value;
    const selRating = el('ovFltRating')?.value ?? '';
    const selRatingNum = selRating !== '' ? Number(selRating) : null;
    const searchQ = el('ovInpSearch').value.trim().toLowerCase();
    const hasActiveFilter = Boolean(selWh || selSup || selName || selRating !== '' || searchQ);
    el('btnResetOverstockFilters').classList.toggle('hidden', !hasActiveFilter);

    const over = allOver.filter((it) => {
      if (selWh && it.warehouse !== selWh) return false;
      const sName = it._supNorm || it.supplier || '(Поставщик не указан)';
      if (selSup && sName !== selSup) return false;
      if (selName && it.name !== selName) return false;
      if (selRating !== '' && it.salesSegment !== selRatingNum && String(it.salesSegment) !== selRating && it.salesSegmentLabel !== selRating) {
        return false;
      }
      if (searchQ) {
        const hay = it._ovSearchLC || `${it.name} ${it.sku} ${it.group} ${it.supplier} ${it.warehouse}`.toLowerCase();
        if (!hay.includes(searchQ)) return false;
      }
      return true;
    });

    const ovKey = state.ovSortKey || 'overstockValue';
    const ovMult = state.ovSortDir === 'asc' ? 1 : -1;
    over.sort((a, b) => {
      const va = a[ovKey];
      const vb = b[ovKey];
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va !== vb) return (va - vb) * ovMult;
        return a.excelRow - b.excelRow;
      }
      return ruCollator.compare(String(va ?? ''), String(vb ?? '')) * ovMult;
    });

    const filteredFrozen = over.reduce((acc, it) => acc + (Number(it.overstockValue) || 0), 0);
    const totalHint = hasActiveFilter
      ? ` (всего по базе: ${fmtInt(allOver.length)} поз. на ${fmtMoney(rep.overstockFrozenCost)} руб.)`
      : '';
    const visibleOver = state.overstockLimit > 0 ? over.slice(0, state.overstockLimit) : over;
    const remainingOver = over.length - visibleOver.length;

    const ovContainer = el('overstockContainer');
    ovContainer.innerHTML = `
      <h3>Радар замороженного капитала и неликвидов (&gt; 365 дней продаж или 0 продаж за 12 мес.)</h3>
      <p class="muted">Выявлено <strong>${fmtInt(over.length)} позиций</strong> со сверхнормативным запасом на сумму <strong style="color:var(--warn)">${fmtMoney(filteredFrozen)} руб.</strong>${totalHint} (в закупочных ценах сверх годовой потребности). Рекомендуется промо-выкладка, скидка или межскладской обмен.</p>
      <div class="table-scroll">
        <table class="data-table" id="overstockTable">
          <thead>
            <tr>
              <th data-ov-sort="warehouse" class="wh-col">Склад</th>
              <th data-ov-sort="group" class="grp-col">Группа</th>
              <th data-ov-sort="sku">Артикул</th>
              <th data-ov-sort="name" class="col-name">Номенклатура</th>
              <th data-ov-sort="salesSegment" class="seg-col" title="Рейтинг: 5-Высокий, 4-Выше среднего, 3-Средний, 2-Ниже среднего, 1-Низкий, 0-Нет продаж (продажи отсутствуют в течение 6 месяцев)">Рейтинг</th>
              <th data-ov-sort="supplier">Поставщик</th>
              <th data-ov-sort="sumSalesLast12M" class="num-col col-5digits">Продажи</th>
              <th data-ov-sort="closingStock" class="num-col col-5digits">Остаток</th>
              <th data-ov-sort="purchasePrice" class="num-col">Цена</th>
              <th data-ov-sort="retailPrice" class="num-col">Розница</th>
              <th data-ov-sort="overstockValue" class="num-col">Заморожено сверх года</th>
            </tr>
          </thead>
          <tbody>
            ${visibleOver.length === 0
              ? '<tr><td colspan="11" style="text-align:center;padding:24px;color:var(--text-muted)">По выбранным фильтрам позиций не найдено</td></tr>'
              : visibleOver.map((it) => {
                const segNum = Number(it.salesSegment) || 0;
                return `<tr data-jump-row="${it.excelRow}">
              <td class="wh-cell" title="${esc(it.warehouse)}">${esc(it.warehouse)}</td>
              <td class="grp-cell" title="${esc(it.group)}">${esc(it.group)}</td>
              <td class="sku-cell">${esc(it.sku)}</td>
              <td class="name-cell">${esc(it.name)}</td>
              <td class="seg-cell" data-rating-row="${it.excelRow}"><span class="seg-pill seg-${segNum}" data-rating-row="${it.excelRow}">${segNum}</span></td>
              <td class="sup-cell" title="${esc(it.supplier)}">${esc(it.supplier || '')}</td>
              <td class="num-col col-5digits">${fmtInt(it.sumSalesLast12M)}</td>
              <td class="num-col col-5digits">${fmtInt(it.closingStock)}</td>
              <td class="num-col">${fmtMoney(it.purchasePrice)}</td>
              <td class="num-col">${fmtRetail(it)}</td>
              <td class="num-col" style="color:var(--warn);font-weight:700">${fmtMoney(it.overstockValue)} руб.</td>
            </tr>`;
              }).join('')}
          </tbody>
        </table>
        ${remainingOver > 0 ? `<div style="margin-top:10px;display:flex;gap:8px;justify-content:center">
          <button type="button" class="btn btn-beige btn-sm" data-overstock-more="500">Показать ещё ${fmtInt(Math.min(500, remainingOver))} из ${fmtInt(remainingOver)}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-overstock-more="all">Показать все (${fmtInt(over.length)})</button>
        </div>` : ''}
      </div>
    `;

    initColumnResizers(ovContainer);
    const ovTable = el('overstockTable');
    if (ovTable && Array.isArray(state.ovColWidths)) {
      const ovThs = [...ovTable.querySelectorAll('thead tr th')];
      if (ovThs.length === state.ovColWidths.length) {
        const colgroup = document.createElement('colgroup');
        state.ovColWidths.forEach((w, idx) => {
          const col = document.createElement('col');
          col.style.width = `${w}px`;
          colgroup.appendChild(col);
          ovThs[idx].style.width = `${w}px`;
        });
        ovTable.insertBefore(colgroup, ovTable.firstChild);
        ovTable.classList.add('table-manual-cols');
        fitTableToViewport(ovTable);
      }
    }
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
    if (isClearingDatabase || !state.report) return;
    clearTimeout(state.debounceTimer);
    const reqEpoch = state.clientEpoch;
    state.debounceTimer = setTimeout(async () => {
      try {
        const env = await apiPost('api/params', collectParamsFromUI());
        if (reqEpoch !== state.clientEpoch) return;
        applyEnvelope(env);
      } catch (err) {
        if (err?.name === 'AbortError' || reqEpoch !== state.clientEpoch) return;
        showToast(err.message);
      }
    }, 110);
  }

  function fmtFileSize(bytes) {
    const b = Number(bytes) || 0;
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} МБ`;
    if (b >= 1024) return `${Math.round(b / 1024)} КБ`;
    return `${b} Б`;
  }

  async function saveDatabase(reason = 'manual') {
    if (!state.report || isClearingDatabase) {
      if (reason === 'manual') {
        showToast('Нет активной базы для сохранения');
      }
      return false;
    }
    if (state.isSavingDb) return false;
    state.isSavingDb = true;
    const btnSave = el('btnSaveDb');
    if (btnSave && reason === 'manual') btnSave.disabled = true;
    try {
      await syncProperties();
      const res = await apiPost('api/db/save', {
        reason,
        pendingOverrides: collectPendingOverridesSnapshot(),
        selectedSuppliers: [...state.checkedSuppliers],
        supplierSelectionActive: true,
        ui: collectUIState(),
      }, { unabortable: reason === 'close' });

      state.savedFileName = res.fileName || state.savedFileName;
      state.lastSavedAt = res.savedAt || state.lastSavedAt;
      state.hasUnsavedChanges = false;
      if (state.report) renderKPIs(state.report);

      if (reason === 'manual') {
        showToast(`База сохранена: «${res.fileName}»`);
      } else if (reason === 'autosave') {
        showToast(`Автосохранение базы: «${res.fileName}»`);
      }
      return true;
    } catch (err) {
      if (err?.name !== 'AbortError') {
        showToast(err.message || 'Ошибка сохранения базы');
      }
      return false;
    } finally {
      state.isSavingDb = false;
      if (btnSave) btnSave.disabled = false;
    }
  }

  async function openSavedDbModal() {
    const modal = el('savedDbModal');
    const listEl = el('savedDbList');
    const hintEl = el('savedDbFolderHint');
    if (!modal || !listEl) return;

    modal.classList.remove('hidden');
    listEl.innerHTML = '<div class="muted" style="padding:12px 4px">Поиск сохранённых баз…</div>';

    try {
      const res = await apiGet('api/db/list');
      const files = Array.isArray(res.files) ? res.files : [];
      if (hintEl && res.saveDir) {
        hintEl.textContent = `Папка автосохранения: ${res.saveDir}`;
      }
      if (files.length === 0) {
        listEl.innerHTML = '<div class="muted" style="padding:14px 4px">В папке пока нет сохранённых баз («Ведомость сохранена, дата.xlsx»). Вы можете выбрать любой сохранённый файл .xlsx с компьютера кнопкой выше.</div>';
        return;
      }
      listEl.innerHTML = files.map((f) => `
        <div class="v4-saved-db-item">
          <div class="v4-saved-db-info">
            <div class="v4-saved-db-name">${esc(f.fileName)}</div>
            <div class="v4-saved-db-meta">
              Сохранено: ${esc(f.savedAt || '—')}${f.warehouseLabel ? ` • Склад: ${esc(f.warehouseLabel)}` : ''} • Размер: ${fmtFileSize(f.sizeBytes)}
            </div>
          </div>
          <div class="v4-saved-db-btns">
            <button type="button" class="btn btn-beige btn-sm" data-load-saved="${esc(f.fileName)}">Загрузить</button>
            <a class="btn btn-secondary btn-sm" href="api/db/download?name=${encodeURIComponent(f.fileName)}" data-dl-saved="1">Скачать .xlsx</a>
          </div>
        </div>
      `).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="muted" style="padding:12px 4px;color:var(--danger)">${esc(err.message)}</div>`;
    }
  }

  function closeSavedDbModal() {
    el('savedDbModal')?.classList.add('hidden');
  }

  async function loadSavedDatabaseByName(fileName) {
    if (!fileName) return;
    const reqEpoch = ++state.clientEpoch;
    abortActiveRequests();
    closeSavedDbModal();
    showToast(`Загрузка сохранённой базы «${fileName}»…`);
    try {
      const env = await apiPost('api/db/load', { fileName });
      if (reqEpoch !== state.clientEpoch) return;
      applyEnvelope(env, { restoreSaved: true });
      showToast(`Сохранённая база восстановлена: «${fileName}»`);
    } catch (err) {
      if (err?.name === 'AbortError' || reqEpoch !== state.clientEpoch) return;
      showToast(err.message);
    }
  }

  async function uploadSavedDatabaseFile(file) {
    if (!file) return;
    const reqEpoch = ++state.clientEpoch;
    abortActiveRequests();
    closeSavedDbModal();
    const ctrl = new AbortController();
    activeControllers.add(ctrl);
    const fd = new FormData();
    fd.append('file', file);
    showToast(`Восстановление сохранённой базы «${file.name}»…`);
    try {
      const res = await fetch('api/db/upload', {
        method: 'POST',
        cache: 'no-store',
        body: fd,
        signal: ctrl.signal,
      });
      const env = await res.json();
      if (!res.ok) throw new Error(env.error || 'Ошибка загрузки сохранённой базы');
      if (reqEpoch !== state.clientEpoch) return;
      applyEnvelope(env, { restoreSaved: true });
      showToast(`Сохранённая база восстановлена: «${file.name}»`);
    } catch (err) {
      if (err?.name === 'AbortError' || reqEpoch !== state.clientEpoch) return;
      showToast(err.message);
    } finally {
      activeControllers.delete(ctrl);
    }
  }

  function openCloseConfirmModal() {
    const modal = el('closeConfirmModal');
    const sub = el('closeConfirmSub');
    if (!modal) return;
    if (sub) {
      if (state.report) {
        const wh = [...state.msFilters.warehouse].join(' + ') || state.report.warehouses?.map((w) => w.warehouse).join(' + ') || 'Все склады';
        sub.textContent = `Активная база: ${wh} (${state.report.fileName}). Свойства номенклатуры будут сохранены при выходе. Сохранить текущую базу?`;
      } else {
        sub.textContent = 'Свойства номенклатуры будут сохранены при выходе. Закрыть программу?';
      }
    }
    el('closeConfirmTitle').textContent = state.report ? 'Сохранить текущую базу?' : 'Закрыть программу?';
    modal.classList.remove('hidden');
  }

  function closeCloseConfirmModal() {
    el('closeConfirmModal')?.classList.add('hidden');
  }

  async function performFinalAppClose() {
    isClosingConfirmed = true;
    closeCloseConfirmModal();
    await fetch('api/shutdown', { method: 'POST', keepalive: true }).catch(() => {});
    try {
      window.close();
    } catch (_) {}
    setTimeout(() => {
      document.body.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font-family:inherit;padding:24px;text-align:center">
          <div style="background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;padding:28px 36px;max-width:440px;box-shadow:var(--shadow)">
            <h2 style="margin:0 0 8px;font-size:18px">Программа закрыта</h2>
            <p style="margin:0 0 18px;color:var(--text-muted);font-size:13px">Сеанс работы завершён. Вы можете закрыть вкладку или запустить программу снова.</p>
            <button type="button" class="btn btn-beige" onclick="window.location.reload()">Открыть программу снова</button>
          </div>
        </div>
      `;
    }, 180);
  }

  async function uploadExcelFile(file) {
    if (!file) return;
    const reqEpoch = ++state.clientEpoch;
    abortActiveRequests();
    const ctrl = new AbortController();
    activeControllers.add(ctrl);
    const fd = new FormData();
    fd.append('file', file);
    showToast(`Загрузка новой базы «${file.name}»…`);
    try {
      const res = await fetch('api/upload', {
        method: 'POST',
        cache: 'no-store',
        body: fd,
        signal: ctrl.signal,
      });
      const env = await res.json();
      if (!res.ok) throw new Error(env.error || 'Ошибка загрузки файла');
      if (reqEpoch !== state.clientEpoch) return;
      state.selectedExcelRow = null;
      state.page = 1;
      applyEnvelope(env, { freshNewDb: true });
      showToast(`Готово! Новая база загружена (${fmtInt(env.report.totalItems)} позиций)`);
    } catch (err) {
      if (err?.name === 'AbortError' || reqEpoch !== state.clientEpoch) return;
      showToast(err.message);
    } finally {
      activeControllers.delete(ctrl);
    }
  }

  function syncPropertyFilters() {
    for (const [id, active] of [['btnSales12', state.sales12Only], ['btnRelevant', state.unmarkedOnly]]) {
      el(id)?.classList.toggle('property-filter-active', active);
      el(id)?.setAttribute('aria-pressed', String(active));
    }
  }

  function bindEvents() {
    el('btnSaveFields').addEventListener('click', saveFields);
    function closeAdminNotice() {
      el('adminNoticeModal').classList.add('hidden');
      el('btnToggleAdvanced').focus();
    }
    el('btnAdminNoticeOk').addEventListener('click', closeAdminNotice);
    el('adminNoticeModal').addEventListener('click', e => {
      if (e.target === el('adminNoticeModal')) closeAdminNotice();
    });
    el('adminNoticeModal').addEventListener('keydown', e => {
      if (e.key === 'Tab') { e.preventDefault(); el('btnAdminNoticeOk').focus(); }
    });
    let paramsClicks = 0;
    for (const [id, field] of [['btnSales12','sales12Only'], ['btnRelevant','unmarkedOnly']]) {
      el(id).addEventListener('click', () => {
        state[field] = !state[field];
        syncPropertyFilters();
        refreshExcelTable();
        if (state.report) renderOverstockView(state.report);
      });
    }
    el('btnExportProperties').addEventListener('click', async () => {
      try {
        await syncProperties();
        const res = await fetch('api/properties/export');
        if (!res.ok) throw new Error(await res.text());
        const url = URL.createObjectURL(await res.blob());
        const link = document.createElement('a');
        link.href = url;
        const now = new Date();
        link.download = `Свойства Номенклатуры, ${now.toLocaleDateString('ru-RU')}, ${now.toLocaleTimeString('ru-RU').replaceAll(':','：')}.xlsx`;
        isDownloadingFile = true;
        link.click();
        setTimeout(() => { URL.revokeObjectURL(url); isDownloadingFile = false; },1500);
      } catch(err) { showToast(`Ошибка выгрузки свойств: ${err.message}`); }
    });
    el('btnImportProperties').addEventListener('click', () => el('propertiesFileInput').click());
    el('propertiesFileInput').addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await propertiesQueue.catch(() => {});
        const form = new FormData(); form.append('file',file);
        const res = await fetch('api/properties/import', {method:'POST',body:form});
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Не удалось прочитать Excel');
        nomenclatureProperties = data.properties || {};
        propertiesRevision += 1; propertiesDirty = true;
        if (data.state?.report) applyEnvelope(data.state);
        applyNomenclatureProperties();
        recomputeReportSummaries(state.report);
        refreshExcelTable();
        showToast('Свойства номенклатуры загружены');
      } catch(err) { showToast(`Ошибка загрузки свойств: ${err.message}`); }
      finally { e.target.value = ''; }
    });
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
        }
        scheduleRecalculate();
      });
    });

    let liveOverrideTimer = null;

    const btnClear = el('btnClearDatabase');
    let clearConfirmBusy = false;
    const clearModal = el('clearConfirmModal');
    function closeClearConfirm() {
      if (clearConfirmBusy) return;
      clearModal.classList.add('hidden');
      btnClear.focus();
    }
    btnClear.addEventListener('click', e => {
      e.preventDefault();
      if (clearConfirmBusy || isClearingDatabase) return;
      clearModal.classList.remove('hidden');
      el('btnClearSaveCancel').focus();
    });
    el('btnClearSaveCancel').addEventListener('click', closeClearConfirm);
    clearModal.addEventListener('click', e => {
      if (e.target === clearModal) closeClearConfirm();
    });
    clearModal.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeClearConfirm(); }
      if (e.key === 'Tab') {
        const buttons = [...clearModal.querySelectorAll('button:not(:disabled)')];
        if (!buttons.length) { e.preventDefault(); return; }
        const index = buttons.indexOf(document.activeElement);
        const next = (index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        e.preventDefault(); buttons[next].focus();
      }
    });
    async function confirmClearDatabase(save) {
      if (clearConfirmBusy) return;
      if (state.isSavingDb) { showToast('Дождитесь завершения сохранения базы'); return; }
      clearConfirmBusy = true;
      btnClear.disabled = true;
      clearModal.querySelectorAll('button').forEach(btn => { btn.disabled = true; });
      try {
        if (save) {
          if (!(await saveProperties(false))) return;
          if (state.report && !(await saveDatabase('manual'))) return;
        }
        isClearingDatabase = true;
        state.clientEpoch += 1;
        clearTimeout(state.debounceTimer);
        clearTimeout(state.searchDebounceTimer);
        clearTimeout(liveOverrideTimer);
        if (vScrollRaf) { cancelAnimationFrame(vScrollRaf); vScrollRaf = null; }
        abortActiveRequests();
        await apiPost(`api/clear?t=${Date.now()}`, {}, { unabortable: true });
        resetUIToEmptyDatabase();
        clearModal.classList.add('hidden');
        showToast('База данных очищена');
      } catch (err) {
        showToast(`Не удалось очистить базу: ${err.message}`);
      } finally {
        isClearingDatabase = false;
        clearConfirmBusy = false;
        btnClear.disabled = false;
        clearModal.querySelectorAll('button').forEach(btn => { btn.disabled = false; });
        if (!clearModal.classList.contains('hidden')) el('btnClearSaveCancel').focus();
        else btnClear.focus();
      }
    }
    el('btnClearSaveYes').addEventListener('click', () => confirmClearDatabase(true));
    el('btnClearSaveNo').addEventListener('click', () => confirmClearDatabase(false));

    ['ovFltWarehouse', 'ovFltName', 'ovFltRating', 'ovFltSupplier'].forEach((id) => {
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
      el('ovFltRating').value = '';
      el('ovFltSupplier').value = '';
      el('ovInpSearch').value = '';
      if (state.report) renderOverstockView(state.report);
    });

    // Всплывающий справа график продаж за 3 года и сортировка по столбцам во вкладке «Радар неликвидов»
    el('overstockContainer').addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-rating-row]');
      if (!target) {
        if (activePopoverRow !== null) hideRatingChartPopover();
        return;
      }
      showRatingChartPopover(target, Number(target.dataset.ratingRow));
    });

    el('overstockContainer').addEventListener('mouseleave', () => {
      hideRatingChartPopover();
    });

    el('overstockContainer').addEventListener('click', (e) => {
      const th = e.target.closest('thead th[data-ov-sort]');
      if (!th) return;
      if (state.justResizedColumn || e.target.closest('.col-resizer')) return;
      const key = th.dataset.ovSort;
      if (state.ovSortKey === key) {
        state.ovSortDir = state.ovSortDir === 'desc' ? 'asc' : 'desc';
      } else {
        state.ovSortKey = key;
        state.ovSortDir = typeof state.report?.items?.[0]?.[key] === 'number' ? 'desc' : 'asc';
      }
      if (state.report) renderOverstockView(state.report);
    });

    el('btnToggleAdvanced').addEventListener('click', () => {
      paramsClicks += 1;
      if (paramsClicks < 4) return;
      paramsClicks = 0;
      if (el('paramsPanel').classList.contains('hidden')) {
        // Native alert blocks JS heartbeats and can shut down the desktop server.
        el('adminNoticeModal').classList.remove('hidden');
        el('btnAdminNoticeOk').focus();
      }
      const body = el('paramsBody');
      const isHidden = body.classList.toggle('hidden');
      el('paramsPanel').classList.toggle('hidden', isHidden);
      if (state.report) state.hasUnsavedChanges = true;
      el('btnToggleAdvanced').setAttribute('aria-expanded', String(!isHidden));
      el('btnToggleAdvanced').textContent = isHidden ? 'Параметры ▸' : 'Параметры ▾';
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

    // Интерактивный поиск по номенклатуре по мере ввода каждого символа (мгновенно в таблице + выпадающий список с галочками)
    const runInteractiveNameSearch = (openMenu = true) => {
      state.page = 1;
      state.searchNameLimit = 300;
      recomputeFilteredList();
      if (state.report) renderKPIs(state.report);
      renderTable();
      if (openMenu && state.report) {
        closeAllMultiSelectMenus('searchName');
        el('supplierDropdownMenu')?.classList.add('hidden');
        const qVal = (el('inpSearch')?.value || '').trim();
        if (qVal.length > 0) {
          el('ddSearchNameMenu')?.classList.remove('hidden');
          renderSearchNameDropdown();
        } else {
          el('ddSearchNameMenu')?.classList.add('hidden');
        }
      }
    };

    el('inpSearch').addEventListener('click', e => e.stopPropagation());
    el('inpSearch').addEventListener('input', () => {
      runInteractiveNameSearch(false);
    });
    el('inpSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        el('ddSearchNameMenu')?.classList.add('hidden');
      }
    });
    el('btnSearchNameDropdown').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = el('ddSearchNameMenu');
      if (!menu) return;
      const isHidden = menu.classList.toggle('hidden');
      if (!isHidden) {
        closeAllMultiSelectMenus('searchName');
        el('supplierDropdownMenu')?.classList.add('hidden');
        if (state.report) renderSearchNameDropdown();
      }
    });
    el('ddSearchNameMenu').addEventListener('change', (e) => {
      const chk = e.target.closest('input[data-search-name-check]');
      if (!chk) return;
      if (chk.checked) {
        state.msFilters.nomenclature.add(chk.value);
      } else {
        state.msFilters.nomenclature.delete(chk.value);
      }
      chk.closest('.supplier-dd-row')?.classList.toggle('active-filter', chk.checked);
      syncMultiSelectLabels();
      recomputeFilteredList();
      if (state.report) renderKPIs(state.report);
      renderTable();
    });
    el('ddSearchNameMenu').addEventListener('click', (e) => {
      if (e.target.id === 'btnSearchNameMore') {
        state.searchNameLimit = (state.searchNameLimit || 300) + 500;
        renderSearchNameDropdown();
      }
    });
    el('btnSearchCheckAll').addEventListener('click', (e) => {
      e.stopPropagation();
      const q = (el('inpSearch')?.value || '').trim().toLowerCase();
      const opts = state.msOptions.nomenclature || [];
      for (const o of opts) {
        if (!q || o.searchLC.includes(q)) {
          state.msFilters.nomenclature.add(o.value);
        }
      }
      renderSearchNameDropdown();
      syncMultiSelectLabels();
      recomputeFilteredList();
      if (state.report) renderKPIs(state.report);
      renderTable();
    });
    el('btnSearchUncheckAll').addEventListener('click', (e) => {
      e.stopPropagation();
      state.msFilters.nomenclature.clear();
      if (el('inpSearch')) el('inpSearch').value = '';
      renderSearchNameDropdown();
      syncMultiSelectLabels();
      recomputeFilteredList();
      if (state.report) renderKPIs(state.report);
      renderTable();
    });

    // Обработчики всех выпадающих списков с галочками на горизонтальной плашке
    const applyAfterMultiSelectChange = (changedKey) => {
      state.page = 1;
      if (changedKey === 'plus' && state.msFilters.plus.has('checked') && !state.staryoMode) {
        state.staryoMode = true;
        const tableEl = el('itemsTable');
        if (tableEl) {
          resetTableColumnWidths(tableEl);
          tableEl.classList.add('show-plus-col');
        }
      }
      if (state.report) {
        populateFilterDropdowns(state.report);
      }
      recomputeFilteredList();
      if (state.report) renderKPIs(state.report);
      renderTable();
    };

    document.querySelectorAll('[data-ms-trigger]').forEach((trig) => {
      trig.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = trig.dataset.msTrigger;
        const meta = MS_META[key];
        const menu = meta ? el(meta.menuId) : null;
        if (!menu) return;
        const isHidden = menu.classList.toggle('hidden');
        trig.setAttribute('aria-expanded', String(!isHidden));
        if (!isHidden) {
          closeAllMultiSelectMenus(key);
          el('supplierDropdownMenu')?.classList.add('hidden');
          state.msLimits[key] = 500;
          if (state.report) populateFilterDropdowns(state.report);
          renderMultiSelectMenu(key);
          const sInp = menu.querySelector('[data-ms-search]');
          if (sInp) requestAnimationFrame(() => sInp.focus());
        }
      });
    });

    document.querySelectorAll('[data-ms-search]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.msSearch;
        state.msLimits[key] = 500;
        renderMultiSelectMenu(key);
      });
    });

    document.querySelectorAll('[data-ms-all]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.msAll;
        const q = (document.querySelector(`[data-ms-search="${key}"]`)?.value || '').trim().toLowerCase();
        for (const o of (state.msOptions[key] || [])) {
          if (!q || o.searchLC.includes(q)) {
            state.msFilters[key].add(o.value);
          }
        }
        applyAfterMultiSelectChange(key);
      });
    });

    document.querySelectorAll('[data-ms-none]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.msNone;
        const q = (document.querySelector(`[data-ms-search="${key}"]`)?.value || '').trim().toLowerCase();
        if (!q) {
          state.msFilters[key].clear();
        } else {
          for (const o of (state.msOptions[key] || [])) {
            if (o.searchLC.includes(q)) {
              state.msFilters[key].delete(o.value);
            }
          }
        }
        applyAfterMultiSelectChange(key);
      });
    });

    el('legacyFilterState')?.addEventListener('change', (e) => {
      const chk = e.target.closest('input[data-ms-check]');
      if (!chk) return;
      const key = chk.dataset.msCheck;
      if (chk.checked) {
        state.msFilters[key].add(chk.value);
      } else {
        state.msFilters[key].delete(chk.value);
      }
      applyAfterMultiSelectChange(key);
    });

    el('legacyFilterState')?.addEventListener('click', (e) => {
      const moreBtn = e.target.closest('[data-ms-more]');
      if (!moreBtn) return;
      e.stopPropagation();
      const key = moreBtn.dataset.msMore;
      state.msLimits[key] = (state.msLimits[key] || 500) + 500;
      renderMultiSelectMenu(key);
    });

    el('fltSupplier').addEventListener('change', () => {
      state.page = 1;
      if (state.report) {
        populateFilterDropdowns(state.report);
      }
      recomputeFilteredList();
      if (state.report) renderKPIs(state.report);
      renderTable();
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

    const refreshAfterSupplierCheckChange = () => {
      syncSelectedSuppliersToServer();
      if (!state.report) return;
      populateFilterDropdowns(state.report);
      renderKPIs(state.report);
      renderSuppliersView(state.report);
    };

    el('supplierDropdownList').addEventListener('change', (e) => {
      const chk = e.target.closest('input[data-sup-check]');
      if (!chk) return;
      const sup = normalizeSupName(chk.dataset.supCheck);
      if (chk.checked) {
        state.checkedSuppliers.add(sup);
      } else {
        state.checkedSuppliers.delete(sup);
      }
      refreshAfterSupplierCheckChange();
    });

    el('supplierDropdownList').addEventListener('click', (e) => {
      const selBtn = e.target.closest('[data-sup-select]');
      if (selBtn) {
        el('fltSupplier').value = selBtn.dataset.supSelect || '';
        el('fltSupplier').dispatchEvent(new Event('change'));
        closeSupplierDropdown();
      }
    });

    el('btnCheckAllSuppliers').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!state.report) return;
      const whSet = state.msFilters.warehouse;
      const q = (el('inpSupplierFilter')?.value || '').trim().toLowerCase();
      for (const s of state.report.suppliers) {
        if (whSet.size > 0 && !whSet.has(s.warehouse)) continue;
        if (q && !s.supplier.toLowerCase().includes(q)) continue;
        state.checkedSuppliers.add(normalizeSupName(s.supplier));
      }
      refreshAfterSupplierCheckChange();
    });

    el('btnUncheckAllSuppliers').addEventListener('click', (e) => {
      e.stopPropagation();
      const whSet = state.msFilters.warehouse;
      const q = (el('inpSupplierFilter')?.value || '').trim().toLowerCase();
      if (whSet.size === 0 && !q) {
        state.checkedSuppliers.clear();
      } else if (state.report) {
        for (const s of state.report.suppliers) {
          if (whSet.size > 0 && !whSet.has(s.warehouse)) continue;
          if (q && !s.supplier.toLowerCase().includes(q)) continue;
          state.checkedSuppliers.delete(normalizeSupName(s.supplier));
        }
      }
      refreshAfterSupplierCheckChange();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#supplierDropdown')) {
        closeSupplierDropdown();
        const dropdown = el('supplierDropdown');
        if (dropdown.classList.contains('budget-suppliers-popover')) {
          dropdown.classList.remove('budget-suppliers-popover');
          el('legacyFilterState').appendChild(dropdown);
        }
      }
      if (!e.target.closest('.ms-dropdown')) {
        for (const [key, meta] of Object.entries(MS_META)) {
          const menu = el(meta.menuId);
          const trig = document.querySelector(`[data-ms-trigger="${key}"]`);
          if (menu && !menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
            trig?.setAttribute('aria-expanded', 'false');
          }
        }
      }
      if (!e.target.closest('#searchNameCombo')) {
        el('ddSearchNameMenu')?.classList.add('hidden');
      }
    });

    document.querySelectorAll('#itemsTable thead th[data-sort]').forEach((th) => {
      th.addEventListener('click', (e) => {
        if (state.justResizedColumn || e.target.closest('.col-resizer, .th-filter-btn, input')) return;
        const key = th.dataset.sort;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        } else {
          state.sortKey = key;
          state.sortDir = (key === '_staryoChecked' || typeof state.report?.items?.[0]?.[key] === 'number') ? 'desc' : 'asc';
        }
        recomputeFilteredList();
        renderTable();
      });
    });

    el('tableBody').addEventListener('click', async (e) => {
      const plusCell = e.target.closest('td.plus-cell');
      if (plusCell) {
        const plusChk = plusCell.querySelector('input[data-plus-row]');
        if (plusChk && e.target !== plusChk) {
          plusChk.checked = !plusChk.checked;
          plusChk.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
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
        renderCurrentSupplier();
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

    const onVirtualScroll = () => {
      if (activePopoverRow !== null) hideRatingChartPopover();
      if (state.activeTab !== 'table' || state.filteredItems.length <= VIRTUAL_THRESHOLD) return;
      if (vScrollRaf) return;
      vScrollRaf = requestAnimationFrame(() => {
        vScrollRaf = null;
        renderTableBodyWindow(false);
      });
    };
    el('tableScrollContainer').addEventListener('scroll', onVirtualScroll, { passive: true });
    window.addEventListener('resize', onVirtualScroll, { passive: true });

    async function pushOverrideToServer(rowNum, val, silent = false) {
      if (isClearingDatabase || !state.report) return;
      const reqEpoch = state.clientEpoch;
      state.pendingOverrides.set(rowNum, val);
      try {
        const env = await apiPost('api/override', { excelRow: rowNum, value: val });
        if (reqEpoch !== state.clientEpoch) return;
        if (state.pendingOverrides.get(rowNum) === val) {
          state.pendingOverrides.delete(rowNum);
        }
        if (silent) {
          if (env.report) {
            state.report = env.report;
            indexReportItems(state.report);
            if (state.pendingOverrides.size > 0) {
              for (const [r, q] of state.pendingOverrides.entries()) {
                const t = state.rowMap.get(r);
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
        if (err?.name === 'AbortError' || reqEpoch !== state.clientEpoch) return;
        showToast(err.message);
      }
    }

    function updateRowSumLive(rowNum, qty) {
      if (!state.report?.items) return;
      const it = state.rowMap.get(rowNum) || state.report.items.find((x) => x.excelRow === rowNum);
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
      if (isClearingDatabase || !inp || inp.dataset.dirty !== '1') return;
      clearTimeout(liveOverrideTimer);
      inp.dataset.dirty = '0';
      const rowNum = Number(inp.dataset.qtyRow);
      const val = parseQtyInput(inp.value);
      inp.value = fmtInt(val);
      state.selectedExcelRow = rowNum;
      renderCurrentSupplier();
      const useFastSilent = (Number(state.report?.params?.budgetCap) || 0) <= 0;
      if (useFastSilent) {
        inp.classList.add('is-manual');
        const editor = inp.closest('.qty-editor');
        if (editor && !editor.querySelector('[data-reset]')) {
          const it = state.rowMap.get(rowNum);
          const autoQty = it ? it.autoOrderQty : 0;
          editor.insertAdjacentHTML('afterbegin', `<button class="reset-cell-btn" data-reset="${rowNum}" title="Вернуть авторасчёт (${fmtInt(autoQty)})">↺</button>`);
        }
        await pushOverrideToServer(rowNum, val, true);
        showToast(`Заказ обновлён: ${fmtInt(val)}`);
      } else {
        await pushOverrideToServer(rowNum, val, false);
      }
    }

    // Автоматическое удаление старого значения в поле «Заказ» при начале ввода новых данных
    el('tableBody').addEventListener('focusin', (e) => {
      const inp = e.target.closest('input[data-qty-row]');
      if (!inp) return;
      state.selectedExcelRow = Number(inp.dataset.qtyRow);
      renderCurrentSupplier();
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

    // Переход по клику на строку во вкладке неликвидов и подгрузка больших списков
    document.body.addEventListener('click', (e) => {
      const moreBtn = e.target.closest('[data-overstock-more]');
      if (moreBtn) {
        if (moreBtn.dataset.overstockMore === 'all') {
          state.overstockLimit = 0;
        } else {
          state.overstockLimit = (state.overstockLimit || 500) + Number(moreBtn.dataset.overstockMore || 500);
        }
        if (state.report) renderOverstockView(state.report);
        return;
      }

      const jumpRow = e.target.closest('tr[data-jump-row]');
      if (jumpRow) {
        if (state.justResizedColumn || e.target.closest('.col-resizer')) return;
        const rNum = Number(jumpRow.dataset.jumpRow);
        state.selectedExcelRow = rNum;
        clearAllMultiSelectFilters();
        el('inpSearch').value = '';
        el('fltSupplier').value = '';
        if (state.report) populateFilterDropdowns(state.report);
        recomputeFilteredList();
        if (state.report) renderKPIs(state.report);
        document.querySelector('.tab-btn[data-tab="table"]').click();
        const targetIdx = state.filteredItems.findIndex((x) => x.excelRow === rNum);
        renderTable();
        requestAnimationFrame(() => {
          if (targetIdx >= 0 && state.filteredItems.length > VIRTUAL_THRESHOLD) {
            const tableEl = el('itemsTable');
            const tableTop = 0;
            const rowH = Math.max(24, state.rowHeightPx || 33);
            const approxY = Math.max(0, tableTop + targetIdx * rowH - window.innerHeight * 0.35);
            el('tableScrollContainer').scrollTop = approxY;
            renderTableBodyWindow(true);
          }
          el('tableBody').querySelector(`tr[data-row="${rNum}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    });

    el('suppliersBody').addEventListener('change', (e) => {
      const chk = e.target.closest('input[data-sup-row-check]');
      if (!chk) return;
      const sup = normalizeSupName(chk.dataset.supRowCheck);
      if (chk.checked) {
        state.checkedSuppliers.add(sup);
      } else {
        state.checkedSuppliers.delete(sup);
      }
      refreshAfterSupplierCheckChange();
    });

    el('suppliersBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter-sup]');
      if (!btn) return;
      state.msFilters.warehouse.clear();
      if (btn.dataset.filterWh) state.msFilters.warehouse.add(btn.dataset.filterWh);
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

    el('btnLoadSavedDb').addEventListener('click', () => openSavedDbModal());
    el('btnCloseSavedDbModal').addEventListener('click', () => closeSavedDbModal());
    el('btnPickSavedDbFile').addEventListener('click', () => el('savedDbFileInput').click());
    el('savedDbFileInput').addEventListener('change', (e) => {
      uploadSavedDatabaseFile(e.target.files?.[0]);
      e.target.value = '';
    });
    el('savedDbModal').addEventListener('click', (e) => {
      if (e.target === el('savedDbModal')) closeSavedDbModal();
    });
    el('savedDbList').addEventListener('click', (e) => {
      const dlLink = e.target.closest('[data-dl-saved]');
      if (dlLink) {
        isDownloadingFile = true;
        setTimeout(() => { isDownloadingFile = false; }, 1500);
        return;
      }
      const loadBtn = e.target.closest('[data-load-saved]');
      if (loadBtn) {
        loadSavedDatabaseByName(loadBtn.dataset.loadSaved);
      }
    });

    el('btnSaveProperties').addEventListener('click', () => saveProperties());
    el('btnSaveDb').addEventListener('click', () => saveDatabase('manual'));

    // Обработка отметок галочкой в столбце «+»
    el('tableBody').addEventListener('change', (e) => {
      const plusChk = e.target.closest('input[data-plus-row]');
      if (!plusChk) return;
      const rowNum = Number(plusChk.dataset.plusRow);
      if (plusChk.checked) {
        plusChk.classList.add('has-plus');
        state.staryoRows.add(rowNum);
      } else {
        plusChk.classList.remove('has-plus');
        state.staryoRows.delete(rowNum);
      }
      rememberNomenclatureProperties([state.rowMap.get(rowNum)]);
      recomputeReportSummaries(state.report);
      renderKPIs(state.report);
      syncProperties().catch(err => showToast(err.message));
      if (state.report) populateFilterDropdowns(state.report);
      if (state.unmarkedOnly || state.msFilters.plus.size === 1 || Object.hasOwn(state.colFilters, 'plus')) {
        recomputeFilteredList();
        if (state.report) renderKPIs(state.report);
      }
      renderTable();
    });

    el('btnSaveInPlace').addEventListener('click', async () => {
      if (state.checkedSuppliers.size === 0) {
        showToast('Отметьте галочками поставщиков в списке «Все поставщики»');
        return;
      }
      try {
        await syncSelectedSuppliersToServer();
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

    el('btnFullscreen')?.addEventListener('click', async () => {
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

    el('btnCloseApp').addEventListener('click', () => {
      openCloseConfirmModal();
    });

    el('btnCloseSaveCancel').addEventListener('click', () => {
      closeCloseConfirmModal();
    });
    el('closeConfirmModal').addEventListener('click', (e) => {
      if (e.target === el('closeConfirmModal')) closeCloseConfirmModal();
    });
    el('btnCloseSaveYes').addEventListener('click', async () => {
      const yesBtn = el('btnCloseSaveYes');
      const noBtn = el('btnCloseSaveNo');
      if (yesBtn) yesBtn.disabled = true;
      if (noBtn) noBtn.disabled = true;
      if (!(await saveProperties(false))) {
        if (yesBtn) yesBtn.disabled = false;
        if (noBtn) noBtn.disabled = false;
        return;
      }
      if (state.report) {
        const ok = await saveDatabase('close');
        if (!ok) {
          if (yesBtn) yesBtn.disabled = false;
          if (noBtn) noBtn.disabled = false;
          return;
        }
      }
      await performFinalAppClose();
    });
    el('btnCloseSaveNo').addEventListener('click', async () => {
      if (!(await saveProperties(false))) return;
      await performFinalAppClose();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!el('adminNoticeModal').classList.contains('hidden')) {
          closeAdminNotice();
        } else if (!el('closeConfirmModal')?.classList.contains('hidden')) {
          closeCloseConfirmModal();
        } else if (!el('savedDbModal')?.classList.contains('hidden')) {
          closeSavedDbModal();
        }
      }
    });

    // Автоматическое автосохранение каждые 3 минуты поверх ранее сохранённых файлов
    setInterval(() => {
      if (state.report && !isClearingDatabase && !state.isSavingDb) {
        saveDatabase('autosave');
      }
    }, AUTOSAVE_INTERVAL_MS);

    window.addEventListener('pagehide', () => {
      if (!isClosingConfirmed && navigator.sendBeacon) {
        navigator.sendBeacon('api/properties', new Blob([JSON.stringify({properties:nomenclatureProperties,save:true,removeKeys:[...retiredGlobalPropertyKeys]})], {type:'application/json'}));
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (!isClosingConfirmed && !isDownloadingFile && (propertiesDirty || (state.report && state.hasUnsavedChanges))) {
        e.preventDefault();
        e.returnValue = 'Сохранить текущую базу?';
      }
    });

    document.addEventListener('click', (e) => {
      const exportLink = e.target.closest('a[href*="api/export/"], a[href*="api/db/download"]');
      if (exportLink) {
        isDownloadingFile = true;
        setTimeout(() => { isDownloadingFile = false; }, 1500);
        return;
      }
      if (state.report && e.target.closest('.tab-btn, .preset-chip, #btnSales12, #btnRelevant, #btnCheckAllSuppliers, #btnUncheckAllSuppliers, [data-ms-all], [data-ms-none], #btnSearchCheckAll, #btnSearchUncheckAll, [data-reset]')) {
        state.hasUnsavedChanges = true;
      }
    });
    document.addEventListener('change', (e) => {
      if (state.report && e.target.closest('main.workspace, #supplierDropdownMenu')) {
        state.hasUnsavedChanges = true;
      }
    });
    document.addEventListener('input', (e) => {
      if (state.report && e.target.closest('main.workspace, #supplierDropdownMenu')) {
        state.hasUnsavedChanges = true;
      }
    });

    const syncStickyHeaderOffset = () => {
      document.documentElement.style.setProperty('--sticky-head-top', '0px');
      document.documentElement.style.setProperty('--sticky-toolbar-top', '0px');
      document.documentElement.style.setProperty('--sticky-table-head-top', `${el('overstockToolbar').offsetHeight + 5}px`);
    };
    syncStickyHeaderOffset();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(syncStickyHeaderOffset);
      ro.observe(el('appHeaderShell'));
      ro.observe(el('overstockToolbar'));
    }
    bindExcelFilters();

    setInterval(() => {
      fetch('api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
    }, 3000);
    window.addEventListener('pagehide', () => {
      if (state.desktopMode && navigator.sendBeacon) {
        navigator.sendBeacon('api/shutdown', '{}');
      }
    });
  }

  function initColumnResizers(root = document) {
    if (root === document) {
      try {
        localStorage.removeItem('ostatki_v4_col_widths');
      } catch (_) {}
    }

    root.querySelectorAll('table.data-table').forEach((table) => {
      const headRow = table.querySelector('thead tr');
      if (!headRow) return;
      const ths = [...headRow.querySelectorAll('th')];
      if (ths.length === 0) return;

      const resetTableDefaultWidths = () => {
        table.classList.remove('table-manual-cols');
        table.style.width = '';
        table.querySelector('colgroup')?.remove();
        ths.forEach((h) => { h.style.width = ''; });
        if (table.id === 'overstockTable') {
          state.ovColWidths = null;
        }
      };

      ths.forEach((th) => {
        if (th.querySelector('.col-resizer')) return;
        const handle = document.createElement('span');
        handle.className = 'col-resizer';
        handle.title = 'Потяните границу для настройки ширины столбца (двойной клик — ширина по умолчанию)';
        th.appendChild(handle);

        handle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        handle.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          resetTableDefaultWidths();
          showToast('Восстановлена ширина столбцов по умолчанию');
        });

        handle.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();

          const visibleThs = ths.filter((h) => h.offsetParent !== null);
          const visIdx = visibleThs.indexOf(th);
          if (visIdx < 0) return;

          const initialWidths = visibleThs.map((h) => Math.max(24, Math.round(h.getBoundingClientRect().width)));
          let colgroup = table.querySelector('colgroup');
          if (!colgroup || colgroup.children.length !== visibleThs.length) {
            colgroup?.remove();
            colgroup = document.createElement('colgroup');
            for (let i = 0; i < visibleThs.length; i++) {
              colgroup.appendChild(document.createElement('col'));
            }
            table.insertBefore(colgroup, table.firstChild);
          }
          const cols = [...colgroup.querySelectorAll('col')];
          table.classList.add('table-manual-cols');
          initialWidths.forEach((w, idx) => {
            cols[idx].style.width = `${w}px`;
            visibleThs[idx].style.width = `${w}px`;
          });
          fitTableToViewport(table);

          const startX = e.clientX;
          const startWidth = initialWidths[visIdx];
          const currentWidths = [...initialWidths];
          if (table.id === 'overstockTable') {
            state.ovColWidths = [...currentWidths];
          }

          handle.classList.add('resizing');
          document.body.classList.add('col-resize-active');

          const onMouseMove = (moveEv) => {
            const delta = moveEv.clientX - startX;
            const adjacent = visIdx < visibleThs.length - 1 ? visIdx + 1 : visIdx - 1;
            if (adjacent < 0) return;
            const minWidth = Math.min(24, initialWidths[visIdx], initialWidths[adjacent]);
            const change = Math.max(minWidth - startWidth, Math.min(delta, initialWidths[adjacent] - minWidth));
            currentWidths[visIdx] = startWidth + change;
            currentWidths[adjacent] = initialWidths[adjacent] - change;
            currentWidths.forEach((width, idx) => { cols[idx].style.width = `${width}px`; });
            fitTableToViewport(table);
            if (table.id === 'overstockTable') {
              state.ovColWidths = [...currentWidths];
            }
          };

          const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            handle.classList.remove('resizing');
            document.body.classList.remove('col-resize-active');
            state.justResizedColumn = true;
            setTimeout(() => { state.justResizedColumn = false; }, 180);
          };

          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        });
      });
    });
  }

  function supplierOrderSum(supplier) {
    let sum = 0;
    for (const it of state.report?.items || []) {
      if (normalizeSupName(it.supplier) === supplier) sum += calcLineSum(it.finalOrderQty, it.purchasePrice);
    }
    return Math.round(sum * 100) / 100;
  }
  function renderCurrentSupplier() {
    const filtered = state.colFilters.supplier;
    const row = state.rowMap.get(state.selectedExcelRow);
    const supplier = filtered?.length === 1 ? filtered[0] : (el('fltSupplier')?.value || (row ? normalizeSupName(row.supplier) : ''));
    el('currentSupplierName').textContent = supplier || 'Поставщик не выбран';
    el('currentSupplierName').title = supplier;
    el('currentSupplierSum').textContent = `${fmtMoney(supplier ? supplierOrderSum(supplier) : 0)} руб.`;
  }
  function refreshSupplierSelection() {
    state.hasUnsavedChanges = true;
    syncSelectedSuppliersToServer();
    if(state.report) {renderKPIs(state.report);renderSuppliersView(state.report);populateFilterDropdowns(state.report);}
  }

  let excelMenu = null;
  const filterIcon = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14L10 8v5l-4 2V8z"/></svg>';
  const caretIcon = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M3 6h10l-5 5z"/></svg>';
  function excelValue(it, key) {
    if (key === 'plus') return state.staryoRows.has(it.excelRow) ? '✓' : '';
    if (key === 'unit') return 'шт.';
    if (key === 'supplier') return normalizeSupName(it.supplier);
    return String(it[key] ?? '');
  }
  function matchesExcelFilters(it, except = '') {
    return Object.entries(state.colFilters).every(([key, values]) => key === except || values.includes(excelValue(it, key)));
  }
  function syncExcelHeaders() {
    document.querySelectorAll('[data-filter-col]').forEach(btn => {
      const key = btn.dataset.filterCol;
      const active = Object.hasOwn(state.colFilters, key);
      btn.innerHTML = active ? filterIcon : caretIcon;
      btn.setAttribute('aria-expanded', String(excelMenu?.key === key));
      btn.closest('th').classList.toggle('is-col-filtered', active);
      btn.closest('th').classList.toggle('is-col-open', excelMenu?.key === key);
      const sortKey = btn.closest('th').dataset.sort;
      btn.closest('th').setAttribute('aria-sort', state.sortKey === sortKey ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    el('btnClearAllExcelFilters').classList.toggle('hidden', !hasActiveTableFilter());
  }
  function closeExcelFilter() {
    const anchor = excelMenu?.anchor;
    excelMenu = null;
    el('excelFilterPopover').classList.add('hidden');
    syncExcelHeaders();
    anchor?.focus({preventScroll:true});
  }
  function refreshExcelTable() {
    state.hasUnsavedChanges = true;
    recomputeFilteredList();
    if (state.report) { renderKPIs(state.report); populateFilterDropdowns(state.report); }
    renderTable();
    el('tableScrollContainer').scrollTop = 0;
  }
  function excelMatches() {
    const q = el('efSearchInput').value.trim().toLocaleLowerCase('ru');
    const matches = excelMenu.options.filter(o => o.label.toLocaleLowerCase('ru').includes(q));
    if (excelMenu.key === 'supplier' && excelMenu.sumSort) {
      // Один проход по базе: агрегируем все строки каждого поставщика.
      const sums = new Map();
      for (const it of state.report?.items || []) {
        const supplier = normalizeSupName(it.supplier);
        sums.set(supplier, (sums.get(supplier) || 0) + calcLineSum(it.finalOrderQty, it.purchasePrice));
      }
      const direction = excelMenu.sumSort === 'asc' ? 1 : -1;
      matches.sort((a, b) => direction * (Math.round((sums.get(a.value) || 0) * 100) - Math.round((sums.get(b.value) || 0) * 100)) || ruCollator.compare(a.label, b.label));
    }
    return matches;
  }
  function renderExcelOptions() {
    if (!excelMenu) return;
    const matches = excelMatches();
    const supplierMode = excelMenu.key === 'supplier';
    const selected = matches.filter(o => supplierMode ? isSupplierChecked(o.value) : excelMenu.draft.has(o.value)).length;
    el('efSelectAllChk').checked = matches.length > 0 && selected === matches.length;
    el('efSelectAllChk').indeterminate = selected > 0 && selected < matches.length;
    el('efSelectAllLabel').textContent = el('efSearchInput').value ? '(Выделить найденные)' : '(Выделить все)';
    const rows = matches.slice(0, excelMenu.limit);
    el('efOptionsList').innerHTML = supplierMode ? rows.map(o => `<div class="ef-opt-row"><input type="checkbox" class="supplier-dd-check" data-supplier-budget="${esc(o.value)}" ${isSupplierChecked(o.value) ? 'checked' : ''} aria-label="Включить ${esc(o.label)}"><button type="button" class="ef-supplier-name" data-supplier-current="${esc(o.value)}" title="Показать заказ поставщика">${esc(o.label)}</button><span class="ef-supplier-sum">${fmtMoney(supplierOrderSum(o.value))} р.</span></div>`).join('') : rows.map(o => `<div class="ef-opt-row"><label class="ms-dd-option-label" title="${esc(o.label)}"><input class="supplier-dd-check" type="checkbox" data-excel-value="${esc(o.value)}" ${excelMenu.draft.has(o.value) ? 'checked' : ''}><span class="ms-dd-option-text">${esc(o.label)}</span></label><span class="ef-opt-count">${o.count}</span><button type="button" class="ef-opt-only-btn" data-excel-only="${esc(o.value)}">Только</button></div>`).join('') || '<p class="muted" style="padding:12px">Ничего не найдено</p>';
    if (matches.length > rows.length) el('efOptionsList').insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-secondary btn-sm" id="efMore">Показать ещё</button>');
    el('efCountInfo').textContent = `Выбрано: ${selected} из ${matches.length}`;
  }
  function openExcelFilter(anchor) {
    if (!state.report) return;
    const key = anchor.dataset.filterCol;
    if (excelMenu?.key === key) { closeExcelFilter(); return; }
    const counts = new Map();
    for (const it of state.report.items) {
      if (state.sales12Only && !(Number(it.sumSalesLast12M) > 0)) continue;
      if (state.unmarkedOnly && state.staryoRows.has(it.excelRow)) continue;
      if (!matchesExcelFilters(it, key)) continue;
      const value = excelValue(it, key);
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    const options = [...counts].map(([value,count]) => ({value,count,label:value || '(Пустые)'})).sort((a,b) => ruCollator.compare(a.value,b.value));
    const current = state.colFilters[key];
    excelMenu = {key, anchor, options, limit:500, draft:new Set(current ?? options.map(o => o.value))};
    const title = anchor.closest('th').querySelector('.th-excel-title').textContent;
    el('efTitleText').textContent = title;
    el('efBtnOk').textContent = key === 'supplier' ? 'Готово' : 'ОК';
    el('efBtnCancel').classList.toggle('hidden', key === 'supplier');
    el('efClearColLabel').textContent = `Удалить фильтр с «${title}»`;
    el('efClearCol').disabled = !current && !(key === 'supplier' && el('fltSupplier').value);
    const numeric = typeof state.report.items[0]?.[key] === 'number';
    el('efSortAscLabel').textContent = numeric ? 'Сортировка по возрастанию' : 'Сортировка от А до Я';
    el('efSortDescLabel').textContent = numeric ? 'Сортировка по убыванию' : 'Сортировка от Я до А';
    el('efSearchInput').value = '';
    el('efAddToFilterWrap').classList.add('hidden');
    const context = el('efContextBar');
    context.classList.toggle('hidden', key !== 'supplier' && key !== 'plus');
    context.innerHTML = key === 'supplier'
      ? '<button type="button" class="ef-quick-chip" data-supplier-sum-sort="desc" aria-pressed="false">Сумма заказа ↓</button><button type="button" class="ef-quick-chip" data-supplier-sum-sort="asc" aria-pressed="false">Сумма заказа ↑</button>'
      : key === 'plus' ? '<button type="button" class="ef-menu-cmd" id="efFillAllPlus">Заполнить всё</button><button type="button" class="ef-menu-cmd" id="efClearAllPlus">Отменить</button>' : '';
    const pop = el('excelFilterPopover');
    pop.classList.toggle('ef-wide', key === 'name' || key === 'supplier');
    pop.classList.remove('hidden');
    renderExcelOptions();
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8,Math.min(r.right-pop.offsetWidth,window.innerWidth-pop.offsetWidth-8))}px`;
    pop.style.top = `${Math.max(8,Math.min(r.bottom+5,window.innerHeight-pop.offsetHeight-8))}px`;
    syncExcelHeaders();
    el('efSearchInput').focus();
  }
  function bindExcelFilters() {
    document.querySelectorAll('[data-filter-col]').forEach(btn => btn.addEventListener('click', e => {e.stopPropagation();openExcelFilter(btn);}));
    el('efContextBar').addEventListener('click', e => {
      if (e.target.closest('#efFillAllPlus, #efClearAllPlus') && excelMenu?.key === 'plus') {
        // Берём всю текущую выборку, а не только отрисованные виртуальные строки.
        const clear = Boolean(e.target.closest('#efClearAllPlus'));
        if (clear) {
          excelMenu.clearClicks = (excelMenu.clearClicks || 0) + 1;
          if (excelMenu.clearClicks < 4) return;
          excelMenu.clearClicks = 0;
        }
        for (const it of state.filteredItems) {
          if (clear) state.staryoRows.delete(it.excelRow);
          else state.staryoRows.add(it.excelRow);
        }
        rememberNomenclatureProperties(state.filteredItems);
        syncProperties().catch(err => showToast(err.message));
        closeExcelFilter();
        refreshExcelTable();
        return;
      }

      const button = e.target.closest('[data-supplier-sum-sort]');
      if (!button || excelMenu?.key !== 'supplier') return;
      excelMenu.sumSort = button.dataset.supplierSumSort;
      excelMenu.limit = 500;
      el('efContextBar').querySelectorAll('[data-supplier-sum-sort]').forEach(btn => {
        const active = btn === button;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
      renderExcelOptions();
    });
    ['efCloseBtn','efBtnCancel'].forEach(id => el(id).addEventListener('click',closeExcelFilter));
    el('efSearchInput').addEventListener('input', () => {
      excelMenu.limit = 500;
      renderExcelOptions();
    });
    el('efSelectAllChk').addEventListener('change', e => {
      if (excelMenu.key === 'supplier') {
        for (const o of excelMatches()) { if(e.target.checked) state.checkedSuppliers.add(o.value); else state.checkedSuppliers.delete(o.value); }
        refreshSupplierSelection(); renderExcelOptions(); return;
      }
      for (const o of excelMatches()) { if(e.target.checked) excelMenu.draft.add(o.value); else excelMenu.draft.delete(o.value); }
      renderExcelOptions();
    });
    el('efOptionsList').addEventListener('change', e => {
      if (e.target.matches('[data-supplier-budget]')) {
        const sup = e.target.dataset.supplierBudget;
        if(e.target.checked) state.checkedSuppliers.add(sup); else state.checkedSuppliers.delete(sup);
        refreshSupplierSelection(); renderExcelOptions(); return;
      }
      if (!e.target.matches('[data-excel-value]')) return;
      if(e.target.checked) excelMenu.draft.add(e.target.dataset.excelValue); else excelMenu.draft.delete(e.target.dataset.excelValue);
      renderExcelOptions();
    });
    el('efOptionsList').addEventListener('click', e => {
      if(e.target.hasAttribute('data-supplier-current')) {
        state.colFilters.supplier = [e.target.dataset.supplierCurrent];
        el('fltSupplier').value = '';
        closeExcelFilter(); refreshExcelTable(); return;
      }
      if(e.target.id === 'efMore') {excelMenu.limit += 500;renderExcelOptions();}
      if(e.target.hasAttribute('data-excel-only')) {excelMenu.draft = new Set([e.target.dataset.excelOnly]);el('efBtnOk').click();}
    });
    el('efBtnOk').addEventListener('click', () => {
      if(!excelMenu) return;
      if(excelMenu.key === 'supplier') {closeExcelFilter();return;}
      const {key,draft,options} = excelMenu;
      const q = el('efSearchInput').value.trim();
      const values = q ? excelMatches().filter(o => draft.has(o.value)).map(o => o.value) : [...draft];
      if(!q && options.every(o => draft.has(o.value)) && draft.size === options.length) delete state.colFilters[key];
      else state.colFilters[key] = values;
      closeExcelFilter();refreshExcelTable();
    });
    el('efClearCol').addEventListener('click', () => {if(excelMenu.key === 'supplier') el('fltSupplier').value = ''; delete state.colFilters[excelMenu.key];closeExcelFilter();refreshExcelTable();});
    for(const [id,dir] of [['efSortAsc','asc'],['efSortDesc','desc']]) el(id).addEventListener('click', () => {
      state.sortKey = excelMenu.anchor.closest('th').dataset.sort;state.sortDir=dir;closeExcelFilter();refreshExcelTable();
    });
    el('btnClearAllExcelFilters').addEventListener('click', () => {
      clearAllMultiSelectFilters();el('inpSearch').value='';el('fltSupplier').value='';state.sales12Only=false;state.unmarkedOnly=false;syncPropertyFilters();refreshExcelTable();
    });
    document.addEventListener('click', e => {
      if(excelMenu && !e.target.closest('#excelFilterPopover, [data-filter-col]')) closeExcelFilter();

    });
    document.addEventListener('keydown', e => {
      if(excelMenu && e.key === 'Escape') {e.stopPropagation();closeExcelFilter();}
      if(excelMenu && e.key === 'Enter' && e.target === el('efSearchInput')) el('efBtnOk').click();
    });
    for(const [id,checked] of [['btnSupTabCheckAll',true],['btnSupTabUncheckAll',false]]) el(id).addEventListener('click', () => {
      state.checkedSuppliers = checked ? new Set(state.report?.suppliers.map(s=>normalizeSupName(s.supplier)) || []) : new Set();
      syncSelectedSuppliersToServer();
      if(state.report) {renderSuppliersView(state.report);populateFilterDropdowns(state.report);renderKPIs(state.report);}
    });
    syncExcelHeaders();
  }

  async function bootstrap() {
    initColumnResizers();
    bindEvents();
    try {
      const properties = await apiGet('api/properties');
      nomenclatureProperties = properties.properties || {};
      if (properties.directory) {
        el('propertiesStorageHint').title = `Папка свойств: ${properties.directory}`;
      }
      const fields = await apiGet('api/column-widths');
      savedColumnWidths = fields.widths || {};
      const env = await apiGet('api/state');
      applyEnvelope(env, { initialBoot: true });
      if (state.report && Object.keys(nomenclatureProperties).length) syncProperties().catch(err => showToast(err.message));
    } catch (err) {
      el('fileMetaLine').textContent = 'Откройте или перетащите файл Ведомости (.xlsx) для начала работы';
      showToast(err.message);
    }
  }

  bootstrap();
})();
