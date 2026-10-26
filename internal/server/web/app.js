(() => {
  'use strict';

  const VIRTUAL_THRESHOLD = 400;
  const VIRTUAL_WINDOW = 180;
  const VIRTUAL_OVERSCAN = 55;
  const VIRTUAL_ROW_HEIGHT = 24;
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
    stockByProduct: new Map(),
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
    filledOrderScopes: new Set(),
    highlightedOrderRows: new Set(),
    orderTransferRows: new Set(),
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
    staryoMode: false,
    staryoRows: new Set(),
    sales12Only: true,
    unmarkedOnly: true,
    comparison: null,

    lastLoadedFile: null,
    justResizedColumn: false,
    vStart: 0,
    vEnd: 0,
    overstockLimit: 500,
    ovSortKey: 'overstockValue',
    ovSortDir: 'desc',
    ovColWidths: null,
  };

  let referenceDate='',referenceName='',dialogBusy=false,workRevision=0;
  function renderSafetyStatus(){
    const target=el('safetyStatus');if(!target)return;
    const stamp=state.lastSavedAt ? (/^\d{2}\.\d{2}\.\d{4}/.test(state.lastSavedAt)?state.lastSavedAt:new Date(state.lastSavedAt).toLocaleString('ru-RU')) : 'ещё не сохранено';
    target.textContent=`Эталон: ${referenceName || 'не загружен'}${referenceDate?' • '+new Date(referenceDate).toLocaleString('ru-RU'):''} | Ведомость: ${state.report?.fileName || 'не загружена'} | Сохранение: ${state.isSavingDb?'запись…':stamp}${state.report && state.hasUnsavedChanges?' • Есть несохранённые изменения':''}`;
  }
  function safetyDialog(title,lines,fields='') {
    if(dialogBusy)return Promise.resolve(false);
    dialogBusy=true;const box=el('safetyDialog'),before=document.activeElement;
    el('safetyDialogTitle').textContent=title;el('safetyDialogText').textContent=lines;
    el('safetyDialogFields').innerHTML=fields;box.classList.remove('hidden');el('safetyDialogNo').focus();
    return new Promise(resolve=>{
      const finish=value=>{box.classList.add('hidden');dialogBusy=false;el('safetyDialogYes').onclick=null;el('safetyDialogNo').onclick=null;box.removeEventListener('keydown',key);before?.focus();resolve(value);};
      const key=e=>{if(e.key==='Escape'){e.stopPropagation();finish(false);}if(e.key==='Tab'){const controls=[...box.querySelectorAll('button,input,select')].filter(x=>!x.disabled);if(e.shiftKey&&document.activeElement===controls[0]){e.preventDefault();controls.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===controls.at(-1)){e.preventDefault();controls[0].focus();}}};
      box.addEventListener('keydown',key);el('safetyDialogYes').onclick=()=>finish(true);el('safetyDialogNo').onclick=()=>finish(false);
    });
  }
  async function inspectWorkbook(file,fileName){
    let response;
    if(file){const form=new FormData();form.append('file',file);response=await fetch('api/workbook/check',{method:'POST',body:form});}
    else response=await fetch('api/workbook/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileName})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Не удалось проверить ведомость');
    if(!Number.isFinite(data.items))throw new Error('Сервер не вернул результат проверки');
    return safetyDialog('Проверка ведомости перед загрузкой',`Файл: ${data.fileName}\nПериод: ${data.first} — ${data.last}\nПозиций: ${data.items}\nСклады: ${(data.warehouses||[]).join(', ')}\nПовторяющихся строк: ${data.duplicates}\nБез положительной цены: ${data.noPrices}\n\nНовая номенклатура при сравнении будет показана с отдельным пояснением.\nПродолжить загрузку? Текущая ведомость будет заменена.`);
  }
  async function downloadSafetyFile(path,name){
    const res=await fetch(path);if(!res.ok){const data=await res.json();throw new Error(data.error||'Ошибка выгрузки');}
    const url=URL.createObjectURL(await res.blob()),a=document.createElement('a');a.href=url;a.download=name;isDownloadingFile=true;document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>{URL.revokeObjectURL(url);isDownloadingFile=false;},1500);
  }
  let referenceApprovedDay = null;
  function localCalendarDay() {
    const now=new Date();return `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
  }
  function canLoadWorkbook() {return etalonLoaded && referenceApprovedDay===localCalendarDay();}
  function syncWorkbookGate() {
    if(referenceApprovedDay!==null && referenceApprovedDay!==localCalendarDay())referenceApprovedDay=null;
    const ready=canLoadWorkbook();
    for(const id of ['btnUpload','btnLoadSavedDb']){
      const button=el(id);button.disabled=!ready;
      button.classList.toggle('workbook-ready',ready);button.classList.toggle('workbook-locked',!ready);
      button.setAttribute('aria-disabled',String(!ready));
      button.title=ready?'Эталон загружен в этом запуске сегодня. Можно загрузить ведомость.':'Сначала загрузите эталон заново в этом запуске и за текущую дату.';
    }
    return ready;
  }
  function approveReferenceLoad(){referenceApprovedDay=localCalendarDay();syncWorkbookGate();}
  let etalonLoaded = false;
  function updateEtalon(data) {
    etalonLoaded = Boolean(data.etalonLoaded);
    referenceDate=etalonLoaded?(data.etalonSavedAt || data.savedAt || referenceDate):'';referenceName=etalonLoaded?(data.etalonFileName || data.fileName || referenceName):'';renderSafetyStatus();
    syncWorkbookGate();
    if(state.report){refreshExcelTable();renderOverstockView(state.report);}
  }
  let nomenclatureProperties = {};
  let nomenclatureRecords = {};
  function captureNomenclatureRecords() {
    for (const it of state.report?.items || []) {
      const key=propertyKey(it);
      nomenclatureRecords[key]={warehouse:it.warehouse||'',sku:it.sku||'',name:it.name||'',group:it.group||'',checked:Boolean(nomenclatureProperties[key]),rating:Number(it.salesSegment)||0,stock:Number(it.closingStock)||0};
    }
    for (const [key,record] of Object.entries(nomenclatureRecords)) {
      if (Object.hasOwn(nomenclatureProperties,key)) record.checked=Boolean(nomenclatureProperties[key]);
    }
    return nomenclatureRecords;
  }
  async function downloadNomenclature(path,name) {
    if(state.desktopMode) {
      await apiPost(path,{}, {unabortable:true});
      return;
    }
    const res=await fetch(path,{cache:'no-store'});
    if (!res.ok) throw new Error(await res.text());
    const disposition=res.headers?.get('Content-Disposition') || '';
    const fileName=disposition.match(/filename\*=UTF-8''([^;]+)/i);
    name=name || (fileName ? decodeURIComponent(fileName[1]) : `Эталон, ${new Date().toLocaleDateString('ru-RU')}.xlsx`);
    const url=URL.createObjectURL(await res.blob());
    const link=document.createElement('a');link.href=url;link.download=name;
    isDownloadingFile=true;document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>{URL.revokeObjectURL(url);isDownloadingFile=false;},1500);
  }
  const retiredGlobalPropertyKeys = new Set();
  let propertiesQueue = Promise.resolve();
  let acknowledgedProperties = {};
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
          if (it.manualOverride == null && !state.pendingOverrides.has(it.excelRow)) it.finalOrderQty = 0;
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
  let propertyRowOrder = null;
  function keepPropertyRowsStable(update) {
    const previous = propertyRowOrder;
    const scroll = el('tableScrollContainer').scrollTop;
    propertyRowOrder = new Map(state.filteredItems.map((it, index) => [it.excelRow, index]));
    try { return update(); }
    finally {
      propertyRowOrder = previous;
      el('tableScrollContainer').scrollTop = scroll;
    }
  }

  function storageStatus(id,name,savedAt) {
    const date=new Date(savedAt);
    const stamp=savedAt && !Number.isNaN(date.getTime()) ? date.toLocaleString('ru-RU',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : 'дата сохранения неизвестна';
    el(id).textContent=name ? `${String(name).split(/[\\/]/).pop()} • ${stamp}` : 'Ещё не сохранено';
    el(id).removeAttribute('title');
  }
  let comparisonGeneration=0;
  function exitComparison(refresh=false) {
    comparisonGeneration+=1;
    const wasActive=Boolean(state.comparison);
    if(wasActive)hideRatingChartPopover();
    state.comparison=null;
    el('comparisonHint')?.classList.add('hidden');
    el('btnCompareEtalon')?.setAttribute('aria-pressed','false');
    el('btnCompareEtalon')?.classList.remove('property-filter-active');
    if(refresh && wasActive && state.report) {refreshExcelTable();renderOverstockView(state.report);}
  }
  function comparisonItem(it) {
    const row=state.comparison?.get(it.excelRow);
    if(!row)return null;
    // The server compares against frozen reference checkmarks, not live properties.
    return row.matches ? {...it,salesSegment:row.currentRating} : null;
  }

  function syncProperties(save = false) {
    const snapshot = {...nomenclatureProperties};
    const revision = propertiesRevision, epoch = state.clientEpoch;
    el('propertiesStorageHint').textContent = 'Свойства: запись на диск…';
    const request = propertiesQueue.catch(() => {}).then(async () => {
      const changes = {};
      for (const [key,value] of Object.entries(snapshot)) {
        if (acknowledgedProperties[key] !== value) changes[key] = value;
      }
      const result = await apiPost('api/properties', {properties:changes,save,persist:true,removeKeys:[...retiredGlobalPropertyKeys]}, {unabortable:true});
      if (result.persisted) acknowledgedProperties = snapshot;
      return result;
    }).then(result => {
      if (result.state?.report && propertiesRevision === revision && state.clientEpoch === epoch) keepPropertyRowsStable(() => applyEnvelope(result.state));
      if (result.persisted && propertiesRevision === revision) {
        propertiesDirty = false;
        storageStatus('propertiesStorageHint',result.lastFileName || result.fileName || 'properties.json',result.savedAt);
        el('propertiesStorageHint').classList.remove('properties-save-error');
      }
      return result;
    }).catch(err => {
      el('propertiesStorageHint').textContent = `Свойства НЕ сохранены: ${err.message}. Не закрывайте программу.`;
      el('propertiesStorageHint').classList.add('properties-save-error');
      propertiesDirty = true;
      throw err;
    });
    propertiesQueue = request;
    return request;
  }
  async function saveProperties(notify = true) {
    try {
      const revision = propertiesRevision;
      const res = await syncProperties(true);
      if (revision === propertiesRevision) propertiesDirty = false;
      if (notify) showToast(el('propertiesStorageHint').textContent);
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

  function stockProductKey(it) {
    const sku=String(it.sku||'').trim();
    return sku ? JSON.stringify(['sku',sku]) : JSON.stringify(['name',String(it.group||'').trim(),String(it.name||'').trim()]);
  }
  function indexReportItems(rep) {
    hideWarehouseStock();
    state.stockByProduct.clear();
    state.rowMap.clear();
    if (!rep?.items) return;
    const items = rep.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      state.rowMap.set(it.excelRow, it);
      const product=stockProductKey(it), warehouse=it.warehouse||'';
      if(!state.stockByProduct.has(product))state.stockByProduct.set(product,new Map());
      const stocks=state.stockByProduct.get(product);
      stocks.set(warehouse,(stocks.get(warehouse)||0)+(Number(it.closingStock)||0));
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

    function orderScope() {
      if (!state.report || state.activeTab!=='table' || state.comparison) throw new Error('Откройте обычную ведомость и выберите поставщика и склад');
      const warehouses=activeWarehouseSet() || new Set(state.report.items.map(it=>it.warehouse||''));
      let suppliers=new Set(state.report.items.map(it=>normalizeSupName(it.supplier)));
      const supplier=el('fltSupplier')?.value;
      if(supplier) suppliers=new Set([...suppliers].filter(s=>s===supplier));
      if(Object.hasOwn(state.colFilters,'supplier'))suppliers=new Set([...suppliers].filter(s=>state.colFilters.supplier.includes(s)));
      if(warehouses.size!==1 || suppliers.size!==1)throw new Error('Выберите одного поставщика и один склад в фильтрах ведомости');
      return {warehouse:[...warehouses][0],supplier:[...suppliers][0]};
    }
  function orderScopeKey(scope){return JSON.stringify([scope.supplier,scope.warehouse]);}
  function scopeItems(scope){return (state.report?.items||[]).filter(it=>(it.warehouse||'')===scope.warehouse && normalizeSupName(it.supplier)===scope.supplier);}
  function renderOrderActionButtons(){
    let filled=false,highlighted=false;
    try{const scope=orderScope();filled=state.filledOrderScopes.has(orderScopeKey(scope));highlighted=scopeItems(scope).some(it=>state.highlightedOrderRows.has(it.excelRow));}catch(_){}
    for(const [id,active] of [['btnFillOrder',filled],['btnHighlightOrder',highlighted]]){const button=el(id);button.setAttribute('aria-pressed',String(active));button.classList.toggle('btn-active-toggle',active);}
  }

  function normalizeSupName(raw) {
    const s = String(raw ?? '').trim();
    return s || '(Поставщик не указан)';
  }

  function isSupplierChecked(rawSup) {
    return state.checkedSuppliers.has(normalizeSupName(rawSup));
  }

  function activeWarehouseSet() {
    if(state.activeTab==='overstock') {
      const warehouse=el('ovFltWarehouse')?.value || '';
      return warehouse ? new Set([warehouse]) : null;
    }
    let selected=state.msFilters.warehouse.size ? new Set(state.msFilters.warehouse) : null;
    if(Object.hasOwn(state.colFilters,'warehouse')){
      const excel=new Set(state.colFilters.warehouse);
      selected=selected ? new Set([...selected].filter(w=>excel.has(w))) : excel;
    }
    return selected;
  }
  function warehouseIsActive(warehouse){const selected=activeWarehouseSet();return selected===null || selected.has(warehouse||'');}

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
    t.setAttribute('role','status');
    t.title = 'Нажмите, чтобы закрыть уведомление';
    t.onclick = () => t.classList.add('hidden');
    if (!/ошиб|не сохран|не удалось|нет связи/i.test(msg)) toastTimer = setTimeout(() => t.classList.add('hidden'), 8000);
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

  // Нормализуем также ширины из старых ведомостей: ни один colgroup не расширяет таблицу.
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
    if(table.id==='itemsTable') {
      const plusIndex=allThs.findIndex(h=>h.classList.contains('plus-col'));
      if(!state.staryoMode && widths.length===allThs.length)widths=widths.filter((_,i)=>i!==plusIndex);
      else if(state.staryoMode && widths.length===allThs.length-1){widths=[...widths];widths.splice(plusIndex,0,32);}
    }
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
    } catch (_) { /* Отсутствие настроек не мешает загрузке ведомости. */ }
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
    const nextTab = ['table', 'suppliers', 'overstock', 'charts', 'liquidity'].includes(tabName) ? tabName : 'table';
    state.activeTab = nextTab;
    if(nextTab === 'charts') window.SalesCharts?.update(state.report);
    if(nextTab === 'liquidity') window.LiquidityAnalysis?.update(state.report);
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
      filledOrderScopes: [...state.filledOrderScopes],
      orderTransferRows: [...state.orderTransferRows],
      highlightedOrderRows: [...state.highlightedOrderRows],
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
    exitComparison();
    hideRatingChartPopover();
    captureNomenclatureRecords();
    hideWarehouseStock();
    state.stockByProduct.clear();
    state.report = null;
    state.overstockExportRows = [];
    window.LiquidityAnalysis?.update(null);
    window.SalesCharts?.update(null);
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
    state.filledOrderScopes.clear();
    state.highlightedOrderRows.clear();
    state.orderTransferRows.clear();
    state.checkedSuppliers.clear();
    clearAllMultiSelectFilters();
    Object.keys(state.msOptions).forEach((k) => { state.msOptions[k] = []; });
    state.staryoRows.clear();
    state.staryoMode = !state.unmarkedOnly;
    state.sales12Only = true; state.unmarkedOnly = true; syncPropertyFilters();

    state.lastLoadedFile = null;

    if (el('itemsTable')) {
      resetTableColumnWidths(el('itemsTable'));
      el('itemsTable').classList.toggle('show-plus-col',!state.unmarkedOnly);
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

    renderSafetyStatus();
    if (el('fileMetaLine')) el('fileMetaLine').textContent = 'Ведомость очищена • Нажмите «Загрузить новую ведомость» или «Загрузить сохраненную ведомость»';
    if (el('kpiOrderCost')) el('kpiOrderCost').textContent = '0,00 руб.';
    renderCurrentSupplier();
    if (el('cntTabTable')) el('cntTabTable').textContent = '0';
    if (el('cntTabSuppliers')) el('cntTabSuppliers').textContent = '0';
    if (el('cntTabOverstock')) el('cntTabOverstock').textContent = '0';
    if (el('paginationInfo')) el('paginationInfo').textContent = 'Ведомость очищена (0 строк)';
    if (el('tableBody')) {
      el('tableBody').innerHTML = '<tr><td colspan="15" style="text-align:center;padding:32px;color:var(--text-muted)">Ведомость данных очищена — нажмите «Загрузить новую ведомость», «Загрузить сохраненную ведомость» или перетащите файл Ведомости</td></tr>';
    }
    if (el('tableFoot')) el('tableFoot').innerHTML = '';
    if (el('warehousesContainer')) el('warehousesContainer').innerHTML = '';
    if (el('suppliersBody')) {
      el('suppliersBody').innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-muted)">Ведомость данных очищена</td></tr>';
    }
    if (el('suppliersFoot')) el('suppliersFoot').innerHTML = '';
    if (el('overstockContainer')) {
      el('overstockContainer').innerHTML = '<p class="muted" style="margin:0;padding:12px 0">Ведомость данных очищена — загрузите файл Ведомости (.xlsx) для анализа неликвидов.</p>';
    }
    el('tableScrollContainer').scrollTop = 0;
  }

  function applyEnvelope(env, opts = {}) {
 captureNomenclatureRecords();
    if (!env) return;
    if(opts.freshNewDb || opts.restoreSaved || !env.report || (state.report && state.report.fileName!==env.report.fileName))exitComparison();
    state.canSaveInPlace = Boolean(env.canSaveInPlace);
    state.desktopMode = Boolean(env.desktopMode);
    state.sourceFileName = env.sourceFileName || '';
    state.savedFileName = env.savedFileName || '';
    state.lastSavedAt = env.lastSavedAt || '';
    state.report = env.report || null;
    window.SalesCharts?.update(state.report);
    window.LiquidityAnalysis?.update(state.report);

    el('btnSaveInPlace')?.classList.toggle('hidden', !state.canSaveInPlace);
    if (!state.report) {
      resetUIToEmptyDatabase();
      return;
    }

    indexReportItems(state.report);

    const shouldRestoreSaved = Boolean(opts.restoreSaved || (opts.initialBoot && env.savedFileName));

    if (opts.freshNewDb) {
      state.filledOrderScopes.clear();
      state.highlightedOrderRows.clear();
      state.orderTransferRows.clear();
      state.lastLoadedFile = state.report.fileName;
      state.overstockLimit = 500;
      state.ovSortKey = 'overstockValue';
      state.ovSortDir = 'desc';
      state.ovColWidths = null;
      state.sortKey = 'finalOrderQty';
      state.sortDir = 'desc';
      state.staryoMode = !state.unmarkedOnly;
      state.staryoRows.clear();
      state.sales12Only = true; state.unmarkedOnly = true; syncPropertyFilters();

      state.checkedSuppliers.clear();
      clearAllMultiSelectFilters();
      state.hasUnsavedChanges = true;
      resetTableColumnWidths(el('itemsTable'));
      resetTableColumnWidths(el('suppliersTable'));
      el('itemsTable')?.classList.toggle('show-plus-col',!state.unmarkedOnly);
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
      state.filledOrderScopes.clear();
      state.highlightedOrderRows.clear();
      state.orderTransferRows.clear();
      state.lastLoadedFile = state.report.fileName;
      state.pendingOverrides.clear();
      state.checkedSuppliers = new Set((env.selectedSuppliers || []).map(normalizeSupName));
      state.hasUnsavedChanges = false;
    } else if (state.lastLoadedFile !== state.report.fileName) {
      state.filledOrderScopes.clear();
      state.highlightedOrderRows.clear();
      state.orderTransferRows.clear();
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
      state.filledOrderScopes = new Set((ui.filledOrderScopes || []).filter(s=>typeof s==='string'));
      state.orderTransferRows = new Set((ui.orderTransferRows || []).map(Number).filter(n=>state.rowMap.has(n)));
      state.highlightedOrderRows = new Set((ui.highlightedOrderRows || []).map(Number).filter(n=>state.rowMap.has(n)));
      state.staryoMode = !state.unmarkedOnly;
      state.staryoRows = new Set((ui.staryoRows || []).map(Number).filter((n) => n > 0));
      state.sales12Only = true; state.unmarkedOnly = true; syncPropertyFilters();

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
    renderSafetyStatus();
    const firstP = rep.periods[0]?.label || '';
    const lastP = rep.periods[rep.periods.length - 1]?.label || '';
    const savedSuffix = state.savedFileName
      ? ` • Сохранено: ${state.savedFileName}${state.lastSavedAt ? ` (${state.lastSavedAt.split(' ')[0]})` : ''}`
      : '';
    el('fileMetaLine').textContent =
      `Файл: ${rep.fileName} • Срез: ${rep.createdDate || 'н/д'} • Статистика: ${firstP} — ${lastP} (${rep.periods.length} мес.) • Позиций: ${fmtInt(rep.totalItems)} (к закупке: ${fmtInt(rep.orderItemsCount)} SKU / ${fmtInt(rep.totalOrderUnits)} ед.)${savedSuffix}`;

    // Бюджет зависит от активного склада и галочек поставщиков, не от прочих фильтров.
    const sourceItems = rep.items || [];

    let checkedBudget = 0;
    for (const it of sourceItems) {
      if (!warehouseIsActive(it.warehouse) || !isSupplierChecked(it.supplier)) continue;
      checkedBudget += calcLineSum(it.finalOrderQty, it.purchasePrice);
    }
    checkedBudget = Math.round(checkedBudget * 100) / 100;

    el('kpiOrderCost').textContent = `${fmtMoney(checkedBudget)} руб.`;
    renderCurrentSupplier();
    renderOrderActionButtons();

    const readyRows = rep.suppliers.filter((s) => s.orderItems > 0 && warehouseIsActive(s.warehouse) && isSupplierChecked(s.supplier));
    el('cntTabSuppliers').textContent = readyRows.length;
    el('cntTabOverstock').textContent = rep.overstockItemsCount;
    renderSuppliersView(rep);
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
      if(state.comparison) {const match=comparisonItem(it);if(match)list.push(match);continue;}
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
          (stSet.has('order') && (it.finalOrderQty > 0 || state.highlightedOrderRows.has(it.excelRow))) ||
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
      if (propertyRowOrder) {
        const aRank = propertyRowOrder.get(a.excelRow) ?? Number.MAX_SAFE_INTEGER;
        const bRank = propertyRowOrder.get(b.excelRow) ?? Number.MAX_SAFE_INTEGER;
        if (aRank !== bRank) return aRank - bRank;
      }
      if (key === '_staryoChecked') {
        const ca = state.staryoRows.has(a.excelRow) ? 1 : 0;
        const cb = state.staryoRows.has(b.excelRow) ? 1 : 0;
        if (ca !== cb) return (ca - cb) * mult;
        return a.excelRow - b.excelRow;
      }
      if(key==='finalOrderQty' && state.highlightedOrderRows.size){
        const aOrder=Number(a.finalOrderQty)>0 || state.highlightedOrderRows.has(a.excelRow);
        const bOrder=Number(b.finalOrderQty)>0 || state.highlightedOrderRows.has(b.excelRow);
        if(aOrder!==bOrder)return aOrder?-1:1;
      }
      const va = a[key];
      const vb = b[key];
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va !== vb) return (va - vb) * mult;
        return a.excelRow - b.excelRow;
      }
      return ruCollator.compare(String(va ?? ''), String(vb ?? '')) * mult;
    });

    if(state.comparison) el('comparisonHint').textContent=`Сравнение с эталоном: ${list.length} позиций. Новая номенклатура ИЛИ галочка в эталоне + рост остатка ИЛИ рейтинг 1–5 → 0. Обычные фильтры временно не применяются. Для выхода нажмите любую вкладку.`;
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
      state.highlightedOrderRows.has(it.excelRow) ? 'order-highlighted' : '',
    ].filter(Boolean).join(' ');

    return `<tr data-row="${it.excelRow}" class="${rowCls}">
      <td class="row-number-cell">${index + 1}</td>
      <td class="wh-cell" title="${esc(it.warehouse)}">${esc(it.warehouse)}</td>
      <td class="grp-cell" title="${esc(it.group)}">${esc(it.group)}</td>
      <td class="sku-cell">${esc(it.sku)}</td>
      <td class="name-cell" data-stock-row="${it.excelRow}" tabindex="0" aria-describedby="warehouseStockPopover">${esc(it.name)}${state.comparison?.get(it.excelRow)?.reason?`<div class="comparison-reason">${esc(state.comparison.get(it.excelRow).reason)}</div>`:''}</td>
      <td class="unit-cell">шт.</td>
      <td class="num-col col-5digits"${surplusTitle}>${fmtInt(surplusVal)}</td>
      <td class="plus-cell"><input type="checkbox" class="plus-input${hasPlus ? ' has-plus' : ''}" ${hasPlus ? 'checked' : ''} data-plus-row="${it.excelRow}" title="Отметить галочкой для выгрузки «Старьё»" aria-label="Отметить галочкой" /></td>
      <td class="seg-cell" data-rating-row="${it.excelRow}"><span class="seg-pill seg-${segNum}" data-rating-row="${it.excelRow}">${segNum}</span></td>
      <td class="num-col col-5digits">${fmtInt(it.sumSalesLast12M)}</td>
      <td class="num-col col-5digits">${fmtInt(it.closingStock)}</td>
      <td class="num-col col-5digits order-cell" onclick="event.stopPropagation()">
        <div class="qty-editor">
          <input type="text" inputmode="numeric" autocomplete="off" class="${qtyCls}" value="${state.orderTransferRows.has(it.excelRow)?'пер':Number(it.finalOrderQty)===0?'':fmtInt(it.finalOrderQty)}" data-qty-row="${it.excelRow}" />
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
    const rowH = VIRTUAL_ROW_HEIGHT;
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

    const scrollContainer = el('tableScrollContainer');
    const scrollBeforeRender = scrollContainer.scrollTop;
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
      // Repaint whenever the requested range extends outside the rendered one.
      // A small upward movement can expose missing rows, especially at scrollTop=0.
      state.vStart = start;
      state.vEnd = end;

      const rowH = VIRTUAL_ROW_HEIGHT;
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
    }

    if (activeQtyRow != null) {
      const nextInp = tbody.querySelector(`input[data-qty-row="${activeQtyRow}"]`);
      if (nextInp) {
        if (force) nextInp.focus({ preventScroll: true });
        if (activeOrigQty != null) nextInp.dataset.origQty = activeOrigQty;
        if (activeDirty === '1') nextInp.dataset.dirty = '1';
        if (activeFresh === '0' && activeDraft !== null) {
          nextInp.value = activeDraft;
          nextInp.dataset.freshEdit = '0';
          nextInp.setSelectionRange(nextInp.value.length, nextInp.value.length);
        } else if (force) {
          nextInp.select();
        }
      }
    }
    if (scrollContainer.scrollTop !== scrollBeforeRender) scrollContainer.scrollTop = scrollBeforeRender;
  }

  // Property acknowledgements must not rebuild tbody: native scroll anchoring and
  // virtual row-height measurements can otherwise move the viewport after layout.
  function patchVisiblePropertyRows() {
    const rows = [...el('tableBody').querySelectorAll('tr[data-row]')];
    if (!rows.length) return false;
    const indices = new Map(state.filteredItems.map((it, index) => [it.excelRow, index]));
    const start = indices.get(Number(rows[0].dataset.row));
    if (start == null || rows.some((row, i) => indices.get(Number(row.dataset.row)) !== start + i)) return false;
    if (state.filteredItems.length <= VIRTUAL_THRESHOLD && rows.length !== state.filteredItems.length) return false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], item = state.filteredItems[start + i];
      const template = document.createElement('tbody');
      template.innerHTML = buildTableRowHTML(item, start + i);
      const updated = template.firstElementChild;
      row.className = updated.className;
      [...row.cells].forEach((cell, index) => {
        const next = updated.cells[index];
        if (cell.classList.contains('plus-cell')) {
          const checkbox = cell.querySelector('[data-plus-row]');
          const replacement = next.querySelector('[data-plus-row]');
          checkbox.checked = replacement.checked;
          checkbox.className = replacement.className;
        } else if (cell.classList.contains('order-cell')) {
          const input = cell.querySelector('[data-qty-row]');
          const replacement = next.querySelector('[data-qty-row]');
          if (document.activeElement !== input || input.dataset.dirty !== '1') input.value = replacement.value;
          input.className = replacement.className;
        } else if (cell.innerHTML !== next.innerHTML) {
          cell.innerHTML = next.innerHTML;
        }
      });
    }
    state.vStart = start;
    state.vEnd = start + rows.length;
    return true;
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

    if (!propertyRowOrder || !patchVisiblePropertyRows()) renderTableBodyWindow(true);

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

    const segNum = Number(state.comparison?.get(it.excelRow)?.currentRating ?? it.salesSegment) || 0;
    const firstLbl = slicePeriods[0]?.label || '';
    const lastLbl = slicePeriods[slicePeriods.length - 1]?.label || '';
    const skuPart = it.sku ? ` • Арт. ${esc(it.sku)}` : '';

    return `
      <div class="rcp-header">
        <div class="rcp-title-wrap">
          <span class="seg-pill seg-${segNum}">${segNum}</span>
          <span class="rcp-item-name">${esc(it.name)}${skuPart}</span>
        </div>
        <span class="rcp-period-tag" title="График продаж за 3 года (${esc(firstLbl)} — ${esc(lastLbl)})">3 года: ${esc(String(slicePeriods[0]?.month||'').padStart(2,'0'))}.${esc(slicePeriods[0]?.year||'')}–${esc(String(slicePeriods[n-1]?.month||'').padStart(2,'0'))}.${esc(slicePeriods[n-1]?.year||'')}</span>
      </div>
      <div class="rcp-summary">
        <span>Всего: <strong>${fmtInt(total3Y)} шт.</strong></span>
        <span><i class="rcp-dot" style="background:#93c5fd"></i>1-й: <strong>${fmtInt(y1Sum)} шт.</strong></span>
        <span><i class="rcp-dot" style="background:#3b82f6"></i>2-й: <strong>${fmtInt(y2Sum)} шт.</strong></span>
        <span><i class="rcp-dot" style="background:#10b981"></i>12 мес.: <strong>${fmtInt(y3Sum)} шт.</strong></span>
        <span>Ост.: <strong>${fmtInt(it.closingStock)} шт.</strong></span>
      </div>
      <svg class="rcp-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${gridSVG}
        ${yearLinesSVG}
        ${barsSVG}
        ${emptyNotice}
      </svg>
    `;
  }

  function hideWarehouseStock(){
    const pop=el('warehouseStockPopover');
    if(pop){pop.classList.add('hidden');pop.setAttribute('aria-hidden','true');}
  }
  function showWarehouseStock(anchor){
    const it=state.rowMap.get(Number(anchor.dataset.stockRow));
    if(!it)return;
    const stocks=state.stockByProduct.get(stockProductKey(it)) || new Map();
    const others=[...stocks].filter(([warehouse])=>warehouse!==(it.warehouse||''));
    const pop=el('warehouseStockPopover');
    pop.innerHTML=`<strong>Остатки на других складах</strong><div>${esc(it.name)}</div>`+
      (others.length ? `<table>${others.map(([warehouse,qty])=>`<tr><td>${esc(warehouse||'(Склад не указан)')}</td><td>${fmtNum(qty,2)} шт.</td></tr>`).join('')}</table>` : '<p>На других складах номенклатура не найдена</p>');
    pop.classList.remove('hidden');pop.setAttribute('aria-hidden','false');
    const rect=anchor.getBoundingClientRect(), width=pop.offsetWidth||320, height=pop.offsetHeight||100;
    pop.style.left=`${Math.max(8,Math.min(rect.left,window.innerWidth-width-8))}px`;
    pop.style.top=`${Math.max(8,Math.min(rect.bottom+6,window.innerHeight-height-8))}px`;
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

    // Prefer above the rating, centred horizontally; clamp to the viewport.
    const width=Math.min(548,Math.max(1,window.innerWidth-16));
    pop.style.width=`${width}px`;
    const centerX=rect.left+rect.width/2;
    const left=Math.max(8,Math.min(centerX-width/2,window.innerWidth-width-8));
    pop.style.left=`${left}px`;
    const popH=pop.offsetHeight||220;
    const above=rect.top-popH-10;
    const below=above<8;
    const top=below ? Math.max(8,Math.min(rect.bottom+10,window.innerHeight-popH-8)) : above;
    pop.style.top=`${top}px`;
    pop.classList.toggle('rcp-below',below);
    pop.style.setProperty('--arrow-left',`${Math.max(12,Math.min(centerX-left,width-12))}px`);
    pop.setAttribute('aria-hidden','false');
  }

  function hideRatingChartPopover() {
    const pop = el('ratingChartPopover');
    if (!pop) return;
    pop.classList.add('hidden');
    pop.setAttribute('aria-hidden','true');
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

    el('warehousesContainer').innerHTML = rep.warehouses.filter(w=>warehouseIsActive(w.warehouse)).map((w) => {
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

    el('suppliersBody').innerHTML = rep.suppliers.filter(s=>warehouseIsActive(s.warehouse)).map((s) => {
      const isChecked = isSupplierChecked(s.supplier);
      const isReadyToSend = isChecked && s.orderItems > 0;
      const orderQs = new URLSearchParams();
      orderQs.set('warehouse', s.warehouse||'');
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
          <button class="btn btn-ghost btn-sm" data-filter-sup="${esc(s.supplier)}" data-filter-wh="${esc(s.warehouse || '')}">Предварительный просмотр</button>
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
      if(!warehouseIsActive(s.warehouse))continue;
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

    state.overstockExportRows = over.map(it=>it.excelRow);
    const filteredFrozen = over.reduce((acc, it) => acc + (Number(it.overstockValue) || 0), 0);
    const totalHint = hasActiveFilter
      ? ` (всего по ведомости: ${fmtInt(allOver.length)} поз. на ${fmtMoney(rep.overstockFrozenCost)} руб.)`
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
              <td class="name-cell" data-stock-row="${it.excelRow}" tabindex="0" aria-describedby="warehouseStockPopover">${esc(it.name)}</td>
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
        showToast('Нет активной ведомости для сохранения');
      }
      return false;
    }
    if (state.isSavingDb) return false;
    const savingRevision=workRevision,savingEpoch=state.clientEpoch;
    state.isSavingDb = true;renderSafetyStatus();
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

      if(savingEpoch!==state.clientEpoch)return false;
      state.savedFileName = res.fileName || state.savedFileName;
      state.lastSavedAt = res.savedAt || state.lastSavedAt;
      state.hasUnsavedChanges = workRevision!==savingRevision || state.clientEpoch!==savingEpoch;
      if (state.report) renderKPIs(state.report);

      if (reason === 'manual') {
        showToast(`Ведомость сохранена: «${res.fileName}»`);
      } else if (reason === 'autosave') {
        showToast(`Автосохранение ведомости: «${res.fileName}»`);
      }
      return true;
    } catch (err) {
      if (err?.name !== 'AbortError') {
        showToast(err.message || 'Ошибка сохранения ведомости');
      }
      return false;
    } finally {
      state.isSavingDb = false;renderSafetyStatus();
      if (btnSave) btnSave.disabled = false;
    }
  }

  async function openSavedDbModal() {
    if(!syncWorkbookGate()){showToast('Сначала загрузите эталон заново за текущую дату');return;}
    const modal = el('savedDbModal');
    const listEl = el('savedDbList');
    const hintEl = el('savedDbFolderHint');
    if (!modal || !listEl) return;

    modal.classList.remove('hidden');
    listEl.innerHTML = '<div class="muted" style="padding:12px 4px">Поиск сохранённых ведомостей…</div>';

    try {
      const res = await apiGet('api/db/list');
      const files = Array.isArray(res.files) ? res.files : [];
      if (hintEl && res.saveDir) {
        hintEl.textContent = `Папка автосохранения: ${res.saveDir}`;
      }
      if (files.length === 0) {
        listEl.innerHTML = '<div class="muted" style="padding:14px 4px">В папке пока нет сохранённых ведомостей («Ведомость сохранена, дата.xlsx»). Вы можете выбрать любой сохранённый файл .xlsx с компьютера кнопкой выше.</div>';
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
    if(!syncWorkbookGate()){showToast('Сначала загрузите эталон заново за текущую дату');return;}
    if (!fileName) return;
    try {if(!await inspectWorkbook(null,fileName))return;}catch(err){showToast(err.message);return;}
    if(!syncWorkbookGate()){showToast('Дата изменилась. Загрузите эталон заново.');return;}
    const reqEpoch = ++state.clientEpoch;
    abortActiveRequests();
    closeSavedDbModal();
    showToast(`Загрузка сохранённой ведомости «${fileName}»…`);
    try {
      const env = await apiPost('api/db/load', { fileName });
      if (reqEpoch !== state.clientEpoch) return;
      applyEnvelope(env, { restoreSaved: true });
      showToast(`Сохранённая ведомость восстановлена: «${fileName}»`);
    } catch (err) {
      if (err?.name === 'AbortError' || reqEpoch !== state.clientEpoch) return;
      showToast(err.message);
    }
  }

  async function uploadSavedDatabaseFile(file) {
    if(!syncWorkbookGate()){showToast('Сначала загрузите эталон заново за текущую дату');return;}
    if (!file) return;
    try {if(!await inspectWorkbook(file))return;}catch(err){showToast(err.message);return;}
    if(!syncWorkbookGate()){showToast('Дата изменилась. Загрузите эталон заново.');return;}
    const reqEpoch = ++state.clientEpoch;
    abortActiveRequests();
    closeSavedDbModal();
    const ctrl = new AbortController();
    activeControllers.add(ctrl);
    const fd = new FormData();
    fd.append('file', file);
    showToast(`Восстановление сохранённой ведомости «${file.name}»…`);
    try {
      const res = await fetch('api/db/upload', {
        method: 'POST',
        cache: 'no-store',
        body: fd,
        signal: ctrl.signal,
      });
      const env = await res.json();
      if (!res.ok) throw new Error(env.error || 'Ошибка загрузки сохранённой ведомости');
      if (reqEpoch !== state.clientEpoch) return;
      applyEnvelope(env, { restoreSaved: true });
      showToast(`Сохранённая ведомость восстановлена: «${file.name}»`);
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
        sub.textContent = `Активная ведомость: ${wh} (${state.report.fileName}). Свойства номенклатуры будут сохранены при выходе. Сохранить текущую ведомость?`;
      } else {
        sub.textContent = 'Свойства номенклатуры будут сохранены при выходе. Закрыть программу?';
      }
    }
    el('closeConfirmTitle').textContent = state.report ? 'Сохранить текущую ведомость?' : 'Закрыть программу?';
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
    if(!syncWorkbookGate()){showToast('Сначала загрузите эталон заново за текущую дату');return;}
    if (!file) return;
    try {if(!await inspectWorkbook(file))return;}catch(err){showToast(err.message);return;}
    if(!syncWorkbookGate()){showToast('Дата изменилась. Загрузите эталон заново.');return;}
    const reqEpoch = ++state.clientEpoch;
    abortActiveRequests();
    const ctrl = new AbortController();
    activeControllers.add(ctrl);
    const fd = new FormData();
    fd.append('file', file);
    showToast(`Загрузка новой ведомости «${file.name}»…`);
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
      showToast(`Готово! Новая ведомость загружена (${fmtInt(env.report.totalItems)} позиций)`);
    } catch (err) {
      if (err?.name === 'AbortError' || reqEpoch !== state.clientEpoch) return;
      showToast(err.message);
    } finally {
      activeControllers.delete(ctrl);
    }
  }

  function syncPropertyFilters() {
    state.staryoMode = !state.unmarkedOnly;
    const table=el('itemsTable');
    if(table && table.classList.contains('show-plus-col')!==state.staryoMode){
      resetTableColumnWidths(table);
      table.classList.toggle('show-plus-col',state.staryoMode);
      applyTableColumnWidths(table,savedColumnWidths.itemsTable);
    }

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
    const filterClicks={sales12Only:0,unmarkedOnly:0};
    syncPropertyFilters();
    for (const [id, field] of [['btnSales12','sales12Only'], ['btnRelevant','unmarkedOnly']]) {
      el(id).addEventListener('click', () => {
        if(state[field] && ++filterClicks[field]<4)return;
        filterClicks[field]=0;
        state[field] = !state[field];
        syncPropertyFilters();
        refreshExcelTable();
        if (state.report) renderOverstockView(state.report);
      });
    }
    el('btnCompareEtalon').addEventListener('click',async()=>{
      const button=el('btnCompareEtalon');button.disabled=true;
      const generation=++comparisonGeneration,epoch=state.clientEpoch;
      try {
        if(!state.report)throw new Error('Сначала загрузите текущую ведомость');
        await syncProperties();
        const data=await apiGet('api/etalon/compare');
        if(generation!==comparisonGeneration || epoch!==state.clientEpoch)return;
        state.comparison=new Map((data.rows||[]).map(row=>[Number(row.excelRow),row]));
        closeExcelFilter();hideRatingChartPopover();switchTabUI('table');
        button.setAttribute('aria-pressed','true');button.classList.add('property-filter-active');el('comparisonHint').classList.remove('hidden');
        refreshExcelTable();
      } catch(err) {if(generation===comparisonGeneration)showToast(`Ошибка сравнения: ${err.message}`);}
      finally {button.disabled=false;}
    });
    el('btnReferenceHistory').addEventListener('click',async()=>{
      try {
        const data=await apiGet('api/etalon/history');if(!data.entries?.length){showToast('История эталонов пока пуста');return;}
        const preview=await apiGet('api/etalon/preview');
        const fields=`<label>Версия: <select id="historyChoice">${data.entries.map(e=>`<option value="${esc(e.id)}">${esc(e.savedAt||e.id)} • ${esc(e.source||'источник неизвестен')} • ${e.items} поз.</option>`).join('')}</select></label>`;
        if(!await safetyDialog('Восстановить предыдущий эталон?','Будет заменён только эталон. Текущая ведомость и рабочие отметки не изменятся. Действующий эталон останется в истории.',fields))return;
        const result=await apiPost('api/etalon/history',{id:el('historyChoice').value,token:preview.token});updateEtalon(result);exitComparison(true);storageStatus('etalonStorageHint',result.fileName,result.savedAt);showToast('Эталон восстановлен');
      }catch(err){showToast(err.message);}
    });
    el('btnCompareExport').addEventListener('click',async()=>{try{await downloadSafetyFile('api/etalon/compare/export','Сравнение с эталоном.xlsx');}catch(err){showToast(err.message);}});
    el('btnFullBackup').addEventListener('click',async()=>{try{await syncProperties();await downloadSafetyFile('api/backup/full','Ostatki2-backup.zip');}catch(err){showToast(err.message);}});
    el('btnFullRestore').addEventListener('click',()=>el('fullRestoreInput').click());
    el('fullRestoreInput').addEventListener('change',async e=>{
      const file=e.target.files?.[0];if(!file)return;
      try {
        await propertiesQueue.catch(()=>{});
        const preview=await apiGet('api/etalon/preview');
        const fields=[['etalon.json','Эталон'],['properties.json','Рабочие отметки'],['settings.json','Параметры расчёта'],['column-widths.json','Ширины столбцов']].map(([id,title])=>`<label style="display:block"><input type="checkbox" data-restore-part="${id}"> ${title}</label>`).join('');
        if(!await safetyDialog('Восстановление из резервной копии',`Файл: ${file.name}\nВыберите разделы. Выбранные данные будут заменены. Ведомость не входит в этот архив. Перед восстановлением рекомендуется скачать текущую резервную копию.`,fields))return;
        const selected=[...el('safetyDialogFields').querySelectorAll('input:checked')].map(c=>c.dataset.restorePart);if(!selected.length){showToast('Ни один раздел не выбран');return;}
        const form=new FormData();form.append('file',file);form.append('selected',JSON.stringify(selected));form.append('token',preview.token);
        const response=await fetch('api/backup/restore',{method:'POST',body:form});const result=await response.json();if(!response.ok)throw new Error(result.error||'Ошибка восстановления');
        const props=await apiGet('api/properties');nomenclatureProperties=props.properties||{};nomenclatureRecords=props.nomenclature||{};acknowledgedProperties={...nomenclatureProperties};propertiesRevision++;propertiesDirty=false;updateEtalon(props);if(selected.includes('etalon.json')&&etalonLoaded)approveReferenceLoad();
        const widths=await apiGet('api/column-widths');savedColumnWidths=widths.widths||{};exitComparison();applyEnvelope(await apiGet('api/state'));applyNomenclatureProperties();if(state.report)state.hasUnsavedChanges=true;refreshExcelTable();renderSafetyStatus();showToast('Выбранные разделы восстановлены');
      }catch(err){showToast(err.message);}finally{e.target.value='';}
    });
    el('btnBackupEtalon').addEventListener('click',async()=>{
      try {
        if(state.desktopMode) {
          try {await apiPost('api/etalon/backup',{}, {unabortable:true});showToast('JSON-копия эталона сохранена: Загрузки / Эталон');return;}
          catch(err){showToast(`Не удалось сохранить в папку Эталон: ${err.message}. Пробуем скачивание через браузер.`);}
        }
        const res=await fetch('api/etalon/backup');
        if(!res.ok){const data=await res.json();throw new Error(data.error||'Не удалось получить эталон');}
        const url=URL.createObjectURL(await res.blob()),link=document.createElement('a');
        link.href=url;link.download='Эталон, резервная копия.json';
        isDownloadingFile=true;document.body.appendChild(link);link.click();link.remove();
        setTimeout(()=>{URL.revokeObjectURL(url);isDownloadingFile=false;},1500);
        showToast('JSON-копия сохранённого эталона выгружена');
      }
      catch(err){showToast(`Ошибка резервной копии: ${err.message}`);}
    });
    el('btnSaveEtalon').addEventListener('click', async () => {
      const epoch=state.clientEpoch;
      const button=el('btnSaveEtalon');button.disabled=true;
      try {
        await syncProperties();
        const preview=await apiGet('api/etalon/preview');
        if(!await safetyDialog('Заменить действующий эталон?',`Действующий эталон: ${preview.source||'источник неизвестен'} • ${preview.savedAt||'не сохранён'}\nНовый источник: ${preview.newSource}\nПозиций: ${preview.total}\nИзменится галочек: ${preview.marks}\nОстатков: ${preview.stocks}\nРейтингов: ${preview.ratings}\nДобавится новых строк: ${preview.added}\n\nПредыдущий эталон останется в истории (до 10 версий).`))return;
        const result=await apiPost('api/etalon/save-confirmed',{token:preview.token}, {unabortable:true});
        if(epoch===state.clientEpoch && result.state) keepPropertyRowsStable(()=>applyEnvelope(result.state));
        updateEtalon(result);
        exitComparison(true);
        storageStatus('etalonStorageHint',result.fileName,result.savedAt);
        showToast(el('etalonStorageHint').textContent);
      } catch(err) {showToast(`Ошибка сохранения эталона: ${err.message}`);}
      finally {button.disabled=false;}
    });
    el('btnExportEtalon').addEventListener('click',async()=>{
      const button=el('btnExportEtalon');button.disabled=true;
      try {
        // Export the stored snapshot only; never save/refresh it implicitly.
        await downloadNomenclature('api/etalon/export');
        showToast('Сохранённый эталон выгружен. Рейтинг и остаток не изменены.');
      } catch(err) {showToast(`Ошибка выгрузки эталона: ${err.message}`);}
      finally {button.disabled=false;}
    });
    el('btnLoadEtalon').addEventListener('click',()=>el('etalonFileInput').click());
    el('etalonFileInput').addEventListener('change',async e=>{
      const file=e.target.files?.[0];if(!file)return;
      const epoch=state.clientEpoch;
      const button=el('btnLoadEtalon');button.disabled=true;
      try {
        await syncProperties();
        if(etalonLoaded && !await safetyDialog('Заменить эталон из файла?',`Текущий эталон: ${referenceName}\nНовый файл: ${file.name}\nРабочие галочки будут применены из загруженного эталона. Предыдущий эталон останется в истории.`))return;
        const form=new FormData();form.append('file',file);
        const res=await fetch('api/etalon/import',{method:'POST',body:form});
        const data=await res.json();if(!res.ok)throw new Error(data.error||'Не удалось загрузить эталон');
        updateEtalon(data);
        if(etalonLoaded)approveReferenceLoad();
        nomenclatureProperties=data.properties||{};
        nomenclatureRecords=data.nomenclature||{};
        acknowledgedProperties={...nomenclatureProperties};propertiesRevision+=1;propertiesDirty=false;
        exitComparison();
        if(epoch===state.clientEpoch && data.state)applyEnvelope(data.state);
        applyNomenclatureProperties();
        storageStatus('etalonStorageHint',data.fileName || file.name,data.savedAt);
        showToast('Эталон загружен в программу. Рейтинг и остаток эталона сохранены; рабочие остатки 1С не изменены.');
      } catch(err) {showToast(`Ошибка загрузки эталона: ${err.message}`);}
      finally {e.target.value='';button.disabled=false;}
    });
    el('btnExportRadar').addEventListener('click',async()=>{
      const button=el('btnExportRadar');button.disabled=true;
      try {
        if(!state.report)throw new Error('Сначала загрузите ведомость');
        renderOverstockView(state.report);
        const excelRows=state.overstockExportRows||[];
        if(!excelRows.length)throw new Error('В текущей выборке радара нет позиций');
        const res=await fetch('api/export/radar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({excelRows})});
        if(!res.ok){const data=await res.json();throw new Error(data.error||'Не удалось выгрузить радар');}
        const url=URL.createObjectURL(await res.blob()),link=document.createElement('a');
        const disposition=res.headers?.get('Content-Disposition')||'';
        const match=disposition.match(/filename\*=UTF-8''([^;]+)/i);
        link.href=url;link.download=match?decodeURIComponent(match[1]):`Радар неликвидов, ${new Date().toLocaleDateString('ru-RU')}.xlsx`;
        isDownloadingFile=true;document.body.appendChild(link);link.click();link.remove();
        setTimeout(()=>{URL.revokeObjectURL(url);isDownloadingFile=false;},1500);
        showToast(`Радар выгружен: ${excelRows.length} позиций`);
      }catch(err){showToast(`Ошибка выгрузки радара: ${err.message}`);}
      finally{button.disabled=false;}
    });
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        exitComparison(true);
        state.activeTab = btn.dataset.tab;
        if(state.report)renderKPIs(state.report);
        if(state.activeTab === 'charts') window.SalesCharts?.update(state.report);
        if(state.activeTab === 'liquidity') window.LiquidityAnalysis?.update(state.report);
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
      if (state.isSavingDb) { showToast('Дождитесь завершения сохранения ведомости'); return; }
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
        showToast('Ведомость данных очищена');
      } catch (err) {
        showToast(`Не удалось очистить ведомость: ${err.message}`);
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
        if (state.report) {renderOverstockView(state.report);renderKPIs(state.report);}
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

    document.addEventListener('mouseover',e=>{
      const anchor=e.target.closest('[data-stock-row]');
      if(anchor && !anchor.contains(e.relatedTarget))showWarehouseStock(anchor);
    });
    document.addEventListener('mouseout',e=>{
      const anchor=e.target.closest('[data-stock-row]');
      if(anchor && !anchor.contains(e.relatedTarget))hideWarehouseStock();
    });
    document.addEventListener('focusin',e=>{const anchor=e.target.closest('[data-stock-row]');if(anchor)showWarehouseStock(anchor);});
    document.addEventListener('focusout',e=>{if(e.target.closest('[data-stock-row]'))hideWarehouseStock();});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')hideWarehouseStock();});
    document.addEventListener('scroll',hideWarehouseStock,true);
    window.addEventListener('resize',hideWarehouseStock);

    document.addEventListener('click',e=>{const anchor=e.target.closest('[data-rating-row]');if(anchor)showRatingChartPopover(anchor,Number(anchor.dataset.ratingRow));});
    document.addEventListener('scroll',hideRatingChartPopover,true);
    window.addEventListener('resize',hideRatingChartPopover);
    // Всплывающий над рейтингом график продаж за 3 года и сортировка по столбцам во вкладке «Радар неликвидов»
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
      const opening = el('paramsPanel').classList.contains('hidden');
      if (opening && ++paramsClicks < 4) return;
      paramsClicks = 0;
      if (opening) {
        // Native alert blocks JS heartbeats and can shut down the desktop server.
        el('adminNoticeModal').classList.remove('hidden');
        el('btnAdminNoticeOk').focus();
      }
      const body = el('paramsBody');
      const isHidden = !opening;
      body.classList.toggle('hidden', isHidden);
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

    function highlightOrder(scope) {
      for(const it of state.report.items){
        if((it.warehouse||'')!==scope.warehouse || normalizeSupName(it.supplier)!==scope.supplier)continue;
        if(Number(it.autoOrderQty)>0 && !state.staryoRows.has(it.excelRow) && !state.orderTransferRows.has(it.excelRow))state.highlightedOrderRows.add(it.excelRow);else state.highlightedOrderRows.delete(it.excelRow);
      }
      state.sortKey='finalOrderQty';state.sortDir='desc';
      refreshExcelTable();
    }
    el('btnHighlightOrder').addEventListener('click',()=>{
      try {const scope=orderScope();const rows=scopeItems(scope);if(rows.some(it=>state.highlightedOrderRows.has(it.excelRow))){for(const it of rows)state.highlightedOrderRows.delete(it.excelRow);refreshExcelTable();showToast('Подсветка заказа снята');}else{highlightOrder(scope);showToast('Рекомендации заказа подсвечены');}}catch(err){showToast(err.message);}
    });
    el('btnFillOrder').addEventListener('click',async()=>{
      const button=el('btnFillOrder');
      try {
        const scope=orderScope();
        // A just-blurred quantity may still be in flight. Do not overwrite it.
        if(state.pendingOverrides.size || document.querySelector('input[data-qty-row][data-dirty="1"]'))throw new Error('Дождитесь сохранения введённого количества и повторите');
        button.disabled=true;
        const epoch=state.clientEpoch;
        const key=orderScopeKey(scope),cancel=state.filledOrderScopes.has(key);
        const env=await apiPost('api/orders/fill',{...scope,cancel});
        if(epoch!==state.clientEpoch)return;
        for(const it of state.report.items)if((it.warehouse||'')===scope.warehouse && normalizeSupName(it.supplier)===scope.supplier && !state.staryoRows.has(it.excelRow))state.orderTransferRows.delete(it.excelRow);
        if(cancel)state.filledOrderScopes.delete(key);else state.filledOrderScopes.add(key);
        applyEnvelope(env);refreshExcelTable();
        showToast(cancel?'Заказ выбранного поставщика и склада отменён':'Заказ рассчитан для выбранного поставщика и склада');
      }catch(err){showToast(err.message);}finally{button.disabled=false;}
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
          fitFloatingMenu(menu,trig);
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
        fitFloatingMenu(menu,el('btnSupplierDropdown'));
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
      const tr = e.target.closest('tr[data-row]');
      if (tr) {
        state.selectedExcelRow = Number(tr.dataset.row);
        el('tableBody').querySelector('tr.selected-row')?.classList.remove('selected-row');
        tr.classList.add('selected-row');
        renderCurrentSupplier();
      }
    });

    // Всплывающий над рейтингом график продаж за последние 3 года при наведении курсора на цифру рейтинга
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
      state.highlightedOrderRows.delete(rowNum);
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
        inp.classList.remove('order-highlighted');
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
      inp.value = state.orderTransferRows.has(rowNum)?'пер':val===0?'':fmtInt(val);
      state.selectedExcelRow = rowNum;
      renderCurrentSupplier();
      const useFastSilent = (Number(state.report?.params?.budgetCap) || 0) <= 0;
      if (useFastSilent) {
        state.highlightedOrderRows.delete(rowNum);
        inp.classList.remove('order-highlighted');
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
        inp.value = inp.dataset.origVal ?? (prevQty===0?'':fmtInt(prevQty));
        inp.dataset.freshEdit = '1';
        inp.dataset.dirty = '0';
        if(inp.value==='пер')state.orderTransferRows.add(rowNum);else state.orderTransferRows.delete(rowNum);
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
          state.orderTransferRows.delete(rowNum);
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
      const transfer=inp.value.includes('*') || inp.value.trim().toLowerCase()==='пер';
      const row=Number(inp.dataset.qtyRow);
      if(transfer)state.orderTransferRows.add(row);else state.orderTransferRows.delete(row);
      const formatted = transfer?'пер':digits === '' || Number(digits)===0 ? '' : Number(digits).toLocaleString('ru-RU');
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
            const rowH = VIRTUAL_ROW_HEIGHT;
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
      const supplier=btn.dataset.filterSup,warehouse=btn.dataset.filterWh||'';
      const items=(state.report?.items||[]).filter(it=>normalizeSupName(it.supplier)===normalizeSupName(supplier) && (it.warehouse||'')===warehouse && Number(it.finalOrderQty)>0);
      el('orderPreviewTitle').textContent=`Предварительный просмотр: ${supplier} • ${warehouse||'Склад не указан'}`;
      el('orderPreviewBody').innerHTML=items.map(it=>`<tr><td>${esc(it.sku)}</td><td>${esc(it.name)}</td><td>шт.</td><td>${fmtInt(it.sumSalesLast12M)}</td><td>${fmtInt(it.closingStock)}</td><td>${fmtInt(it.finalOrderQty)}</td></tr>`).join('') || '<tr><td colspan="6">В заказе нет позиций</td></tr>';
      el('orderPreviewTotal').textContent=`Позиций: ${items.length} • Заказ: ${fmtInt(items.reduce((sum,it)=>sum+Number(it.finalOrderQty),0))} шт. • Сумма: ${fmtMoney(items.reduce((sum,it)=>sum+calcLineSum(it.finalOrderQty,it.purchasePrice),0))} руб.`;
      const modal=el('orderPreviewModal');modal.classList.remove('hidden');modal._returnFocus=btn;el('btnCloseOrderPreview').focus();
    });

    const closeOrderPreview=()=>{const modal=el('orderPreviewModal');modal.classList.add('hidden');modal._returnFocus?.focus();};
    el('btnCloseOrderPreview').addEventListener('click',closeOrderPreview);
    el('orderPreviewModal').addEventListener('click',e=>{if(e.target===el('orderPreviewModal'))closeOrderPreview();});
    el('orderPreviewModal').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeOrderPreview();}if(e.key==='Tab'){e.preventDefault();el('btnCloseOrderPreview').focus();}});

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
      keepPropertyRowsStable(() => {
        rememberNomenclatureProperties([state.rowMap.get(rowNum)]);
        recomputeReportSummaries(state.report);
        renderKPIs(state.report);
        syncProperties().catch(err => showToast(err.message));
        if (state.report) populateFilterDropdowns(state.report);
        if (state.comparison || state.unmarkedOnly || state.msFilters.plus.size === 1 || Object.hasOwn(state.colFilters, 'plus')) {
          keepPropertyRowsStable(recomputeFilteredList);
          if (state.report) renderKPIs(state.report);
        }
        renderTable();
      });
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
        const changes = {};
        for (const [key,value] of Object.entries(nomenclatureProperties)) {
          if (acknowledgedProperties[key] !== value) changes[key] = value;
        }
        // Keep the last-chance request small: browsers limit keepalive/beacon bodies.
        navigator.sendBeacon('api/properties', new Blob([JSON.stringify({properties:changes,save:true,removeKeys:[...retiredGlobalPropertyKeys]})], {type:'application/json'}));
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (!isClosingConfirmed && !isDownloadingFile && (propertiesDirty || (state.report && state.hasUnsavedChanges))) {
        e.preventDefault();
        e.returnValue = 'Сохранить текущую ведомость?';
      }
    });

    document.addEventListener('click', (e) => {
      const exportLink = e.target.closest('a[href*="api/export/"], a[href*="api/db/download"]');
      if (exportLink) {
        isDownloadingFile = true;
        setTimeout(() => { isDownloadingFile = false; }, 1500);
        return;
      }
      if (state.report && e.target.closest('.tab-btn, .preset-chip, #btnSales12, #btnRelevant, #btnCheckAllSuppliers, #btnUncheckAllSuppliers, [data-ms-all], [data-ms-none], #btnSearchCheckAll, #btnSearchUncheckAll')) {
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
    };
    syncStickyHeaderOffset();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(syncStickyHeaderOffset);
      ro.observe(el('appHeaderShell'));
      ro.observe(el('overstockToolbar'));
    }
    bindExcelFilters();

    const heartbeat = () => {
      fetch('api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
    };
    heartbeat();
    setInterval(heartbeat, 3000);
    window.addEventListener('pageshow', heartbeat);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) heartbeat(); });
    // Reload/navigation is a detach hint, never an immediate shutdown. A fresh
    // heartbeat cancels it; BFCache pages remain resumable without a detach hint.
    window.addEventListener('pagehide', event => {
      if (state.desktopMode && !isClosingConfirmed && !event.persisted && navigator.sendBeacon) {
        navigator.sendBeacon('api/client-detach', '{}');
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
      if (warehouseIsActive(it.warehouse) && normalizeSupName(it.supplier) === supplier) sum += calcLineSum(it.finalOrderQty, it.purchasePrice);
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

  // Reserve space even when an auto-hidden Windows taskbar overlays the viewport.
  const floatingMenuAnchors = new Map();
  function fitFloatingMenu(pop,anchor) {
    if(!pop || !anchor || pop.classList.contains('hidden'))return;
    floatingMenuAnchors.set(pop,anchor);
    const viewport=window.visualViewport;
    const topEdge=(viewport?.offsetTop||0)+8;
    const bottomEdge=(viewport?.offsetTop||0)+(viewport?.height||window.innerHeight)-64;
    const leftEdge=(viewport?.offsetLeft||0)+8;
    const rightEdge=(viewport?.offsetLeft||0)+(viewport?.width||window.innerWidth)-8;
    pop.style.position='fixed';pop.style.right='auto';
    pop.style.maxHeight=`${Math.max(1,bottomEdge-topEdge)}px`;
    pop.style.maxWidth=`${Math.max(1,rightEdge-leftEdge)}px`;
    const r=anchor.getBoundingClientRect();
    const height=pop.getBoundingClientRect().height||pop.offsetHeight;
    const width=pop.getBoundingClientRect().width||pop.offsetWidth;
    pop.style.left=`${Math.max(leftEdge,Math.min(r.right-width,rightEdge-width))}px`;
    pop.style.top=`${Math.max(topEdge,Math.min(r.bottom+5,bottomEdge-height))}px`;
  }
  function repositionFloatingMenus(){
    for(const [pop,anchor] of floatingMenuAnchors)fitFloatingMenu(pop,anchor);
  }
  let excelMenu = null;
  const filterIcon = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14L10 8v5l-4 2V8z"/></svg>';
  const caretIcon = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M3 6h10l-5 5z"/></svg>';
  function excelValue(it, key) {
    if(key==='finalOrderQty' && state.orderTransferRows.has(it.excelRow))return 'пер';
    if(key==='finalOrderQty' && !Number(it.finalOrderQty) && state.highlightedOrderRows.has(it.excelRow))return 'Рекомендовано';
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
      // Один проход по ведомости: агрегируем все строки каждого поставщика.
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
    const selected = matches.filter(o => excelMenu.draft.has(o.value)).length;
    el('efSelectAllChk').checked = matches.length > 0 && selected === matches.length;
    el('efSelectAllChk').indeterminate = selected > 0 && selected < matches.length;
    el('efSelectAllLabel').textContent = el('efSearchInput').value ? '(Выделить найденные)' : '(Выделить все)';
    const rows = matches.slice(0, excelMenu.limit);
    el('efOptionsList').innerHTML = supplierMode ? rows.map(o => `<div class="ef-opt-row"><input type="checkbox" class="supplier-dd-check" data-excel-value="${esc(o.value)}" ${excelMenu.draft.has(o.value) ? 'checked' : ''} aria-label="Показать в таблице: ${esc(o.label)}" title="Показать поставщика в таблице"><button type="button" class="ef-supplier-name" data-supplier-current="${esc(o.value)}" title="Показать только этого поставщика">${esc(o.label)}</button><span class="ef-supplier-sum">${fmtMoney(supplierOrderSum(o.value))} р.</span><input type="checkbox" class="supplier-dd-check" data-supplier-budget="${esc(o.value)}" ${isSupplierChecked(o.value) ? 'checked' : ''} aria-label="Включить в бюджет закупки: ${esc(o.label)}" title="Включить в бюджет закупки, готовность и выгрузку Excel"></div>`).join('') : rows.map(o => `<div class="ef-opt-row"><label class="ms-dd-option-label" title="${esc(o.label)}"><input class="supplier-dd-check" type="checkbox" data-excel-value="${esc(o.value)}" ${excelMenu.draft.has(o.value) ? 'checked' : ''}><span class="ms-dd-option-text">${esc(o.label)}</span></label><span class="ef-opt-count">${o.count}</span><button type="button" class="ef-opt-only-btn" data-excel-only="${esc(o.value)}">Только</button></div>`).join('') || '<p class="muted" style="padding:12px">Ничего не найдено</p>';
    if (matches.length > rows.length) el('efOptionsList').insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-secondary btn-sm" id="efMore">Показать ещё</button>');
    el('efCountInfo').textContent = `Выбрано: ${selected} из ${matches.length}`;
  }
  function openExcelFilter(anchor) {
    if (!state.report) return;
    if(state.comparison){showToast('Для обычных фильтров выйдите из сравнения нажатием вкладки');return;}
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
    excelMenu = {key, anchor, options, limit:500, draft:new Set(current ?? (key === 'supplier' && el('fltSupplier').value ? [el('fltSupplier').value] : options.map(o => o.value)))};
    const title = anchor.closest('th').querySelector('.th-excel-title').textContent;
    el('efTitleText').textContent = title;
    el('efBtnOk').textContent = 'ОК';
    el('efBtnCancel').classList.remove('hidden');
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
      ? '<span class="ef-supplier-help">Слева — показ в таблице · Справа — бюджет закупки</span><button type="button" class="ef-quick-chip" data-supplier-sum-sort="desc" aria-pressed="false">Сумма заказа ↓</button><button type="button" class="ef-quick-chip" data-supplier-sum-sort="asc" aria-pressed="false">Сумма заказа ↑</button>'
      : key === 'plus' ? '<button type="button" class="ef-menu-cmd" id="efFillAllPlus">Заполнить всё</button><button type="button" class="ef-menu-cmd" id="efClearAllPlus">Отменить</button>' : '';
    const pop = el('excelFilterPopover');
    pop.classList.toggle('ef-wide', key === 'name' || key === 'supplier');
    pop.classList.remove('hidden');
    renderExcelOptions();
    fitFloatingMenu(pop,anchor);
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
        keepPropertyRowsStable(refreshExcelTable);
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
      const {key,draft,options} = excelMenu;
      if(key === 'supplier') el('fltSupplier').value = '';
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
      clearAllMultiSelectFilters();el('inpSearch').value='';el('fltSupplier').value='';syncPropertyFilters();refreshExcelTable();
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
    document.addEventListener('input',()=>{workRevision++;setTimeout(renderSafetyStatus,0);});
    document.addEventListener('change',()=>{workRevision++;setTimeout(renderSafetyStatus,0);});
    syncExcelHeaders();
  }

  async function bootstrap() {
    el('itemsTable').style.setProperty('--item-row-height', `${VIRTUAL_ROW_HEIGHT}px`);
    initColumnResizers();
    bindEvents();
    window.addEventListener('resize',repositionFloatingMenus,{passive:true});
    window.visualViewport?.addEventListener('resize',repositionFloatingMenus,{passive:true});
    window.visualViewport?.addEventListener('scroll',repositionFloatingMenus,{passive:true});
    syncWorkbookGate();
    setInterval(syncWorkbookGate,1000);
    window.addEventListener('focus',syncWorkbookGate);
    document.addEventListener('visibilitychange',syncWorkbookGate);
    try {
      const properties = await apiGet('api/properties');
      updateEtalon(properties);
      nomenclatureProperties = properties.properties || {};
      nomenclatureRecords = properties.nomenclature || {};
      if (properties.etalonLoaded) storageStatus('etalonStorageHint',properties.etalonFileName,properties.etalonSavedAt);
      storageStatus('propertiesStorageHint',properties.lastFileName,properties.savedAt);
      acknowledgedProperties = {...nomenclatureProperties};
      const fields = await apiGet('api/column-widths');
      savedColumnWidths = fields.widths || {};
      const env = await apiGet('api/state');
      applyEnvelope(env, { initialBoot: true });
      if (state.report) syncProperties().catch(err => showToast(err.message));
    } catch (err) {
      el('fileMetaLine').textContent = 'Откройте или перетащите файл Ведомости (.xlsx) для начала работы';
      showToast(err.message);
    }
  }

  bootstrap();
})();
