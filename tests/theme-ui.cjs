const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const items=[{excelRow:8,sku:'001',name:'Товар один',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:10,sumSalesLast12M:5,salesSegment:2,purchasePrice:1,monthlySales:[],autoOrderQty:7,finalOrderQty:7}];
w.fetch=async()=>({ok:true,json:async()=>({report:{items,fileName:'Т.xlsx',periods:[],warehouses:[],suppliers:[],groups:[],params:{},totalItems:items.length},savedFileName:'',lastSavedAt:''})});
w.scrollTo=()=>{};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const css=fs.readFileSync('internal/server/web/styles.css','utf8');
const js=fs.readFileSync('internal/server/web/app.js','utf8');
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 // Б48: дизайн вшит в сборку — селектора темы нет, статический index.html без data-theme.
 assert.equal(d.getElementById('themeSelect'),null,'themeSelect удалён');
 assert.equal(d.querySelector('body').getAttribute('data-theme'),null,'в статическом index.html нет data-theme');
 assert.ok(!js.includes('THEME_KEY'),'app.js без переключателя тем');
 // Б52: дизайн один — «Острова+» (islands, макет №6); остальных тем нет.
 assert.ok(css.includes('[data-theme="islands"]'),'тема islands в CSS');
 for(const t of ['classic','cabinet','saas','paper','ribbon','console','excelbook','terminal']){
   assert.ok(!css.includes(`[data-theme="${t}"]`),`тема ${t} удалена (батч-52: только islands)`);
 }
 // Все кнопки верхней плашки — одного цвета, выключенные фильтры белеют.
 assert.ok(css.includes('--btnbar-bg'),'единый цвет кнопок (btnbar-токены)');
 assert.ok(css.includes('.topbar-actions #btnSales12[aria-pressed="false"]'),'выключенные фильтры белеют (б55)');
 assert.ok(css.includes('.topbar-actions #btnHighlightOrder'),'единый цвет кнопок плашки');
 assert.ok(!css.includes('#fde047'),'жёлтых кнопок нет');
 assert.ok(!css.includes('#btnUpload.workbook-ready, #btnLoadSavedDb.workbook-ready {background:#bde5c4'),'зелёных кнопок загрузки нет');
 // Скелет «Островов»: пилюли, карточки, сегмент-вкладки.
 assert.ok(css.includes('[data-theme="islands"] .topbar-actions .btn { border-radius: 99px'),'islands: кнопки-пилюли');
 assert.ok(css.includes('[data-theme="islands"] .table-container'),'islands: карточка таблицы');
 assert.ok(css.includes('[data-theme="islands"] .tabs-bar-left { background: #dfe8f0; border-radius: 99px;'),'islands: сегмент-вкладки');
 // Соответствие макету №6 (батч-52).
 assert.ok(css.includes('[data-theme="islands"] .order-cell { background: transparent; }'),'без заливки вокруг поля заказа');
 assert.ok(css.includes('[data-theme="islands"] .data-table thead th.order-col-head'),'шапка заказа без подложки');
 assert.ok(css.includes('#itemsTable td.wh-cell.wh-mir { background:#e4f0e7; }'),'Мир: цвет как в макете');
 assert.ok(css.includes('#itemsTable td.wh-cell.wh-korelichi { background:#f5ead6; }'),'Кореличи: цвет как в макете');
 assert.ok(!css.includes('background-color: #dc2626;'),'красных «птичек» нет');
 assert.ok(css.includes('background-color: #4c6e8b;'),'«птички» кабинетного цвета');
 assert.ok(css.includes('[data-theme="islands"] #itemsTable td.grp-cell { font-size: 8px;'),'группа мелким в две строки');
 // Вертикальные границы столбцов.
 assert.ok(css.includes('[data-theme="islands"] .data-table td { border-right: 1px solid #d7e0e9; }'),'вертикальные границы ячеек');
 // Рейтинг — только цифра в кружке.
 assert.ok(js.includes('<span class="seg-pill seg-${segNum}" data-rating-row="${it.excelRow}">${segNum}</span>'),'рейтинг: только цифра');
 // Высота строк одинакова: паддинги td темой не переопределяются.
 assert.ok(!/\[data-theme="[a-z]+"\][^{]*\.data-table[^{]*td[^{]*\{[^}]*padding/.test(css),'паддинги строк не зависят от темы');
 assert.ok(css.includes('.topbar-actions .btn { white-space: nowrap'),'кнопки в одну линию');
 assert.ok(css.includes('.seg-pill.seg-5 { background-color: #5fae77 !important'),'рейтинг приглушён');
 assert.match(css,/--bg: #f6f1e7;/);
 assert.match(css,/--primary: #b45309;/);
 // Б53: шапка «Заказ» + дата, без бейджей; плашка вкладок одной высоты/шрифта.
 assert.equal(d.querySelector('.brand-title-row h1').textContent,'Заказ','название — Заказ');
 assert.ok(d.getElementById('brandCurrentDate'),'текущая дата в шапке');
 assert.ok(!d.querySelector('.badge-v2') && !d.querySelector('.badge-accent'),'бейджи сборки/рейтинга убраны');
 assert.ok(d.getElementById('brandCurrentDate').textContent.length>=8,'дата проставлена JS');
 assert.ok(css.includes('[data-theme="islands"] .tabs-bar .tab-btn,'),'плашка: единая высота элементов');
 assert.ok(css.includes('[data-theme="islands"] #btnClearAllExcelFilters'),'плашка: очистить фильтры в общем правиле');
 assert.ok(css.includes('.brand-date'),'стиль даты');
 // Б55: нет «Сделать автозаказ» и «+»; есть «Подсказка»; умолчания 20/5; цифры без обводки;
 // отжатые кнопки белые; тост на чёрном фоне не показывается.
 const html=fs.readFileSync('internal/server/web/index.html','utf8');
 assert.equal(d.getElementById('btnFillOrder'),null,'«Сделать автозаказ» убрана');
 assert.equal(d.getElementById('orderHintBadge'),null,'«+» убран');
 assert.equal(d.getElementById('btnOrderHint').textContent,'Подсказка','кнопка «Подсказка» вместо «+»');
 assert.ok(html.includes('id="inpHorizon" min="1" max="365" step="1" value="20"'),'покрытие по умолчанию 20 дней');
 assert.ok(html.includes('id="inpSafety" min="0" max="200" step="1" value="5"'),'базовый запас по умолчанию 5%');
 assert.ok(css.includes('#btnSales12[aria-pressed="false"]'),'отжатая «Продажи 12 мес.» — белая');
 assert.ok(css.includes('#btnRelevant[aria-pressed="false"]'),'отжатая «Актуально» — белая');
 assert.ok(css.includes('[data-theme="islands"] .topbar-actions #btnToggleAdvanced[aria-expanded="false"] { background: var(--btnbar-bg) !important;'),'Б59: отжатые «Параметры» — серые, как остальные кнопки');
 assert.equal(d.title,'Заказ — Вариант 7.26 • Управление закупками • Рейтинг • SBA','Б59/63: заголовок окна — «Заказ» + индекс релиза');
 assert.equal(d.getElementById('brandVersion').textContent,'Вариант 7.26','Б64: индекс сборки виден в шапке');
 assert.ok(css.includes('.tab-counter { background: transparent !important; border: none !important;'),'Б59: цифры счётчиков вкладок без обводки и на вкладке «Заказ»');
 assert.ok(d.querySelector('[data-sim-step="1"]')&&d.querySelector('[data-sim-step="-1"]'),'Б59: у «Совпадение, %» явные стрелки вверх/вниз');
 assert.ok(css.includes('.sim-step { border: none; background: transparent;'),'Б59: стрелки без обводки');
 assert.ok(css.includes('[data-theme="islands"] .budget-inline-card { border-left: 1px solid var(--border-strong); }'),'Б59: «Бюджет закупки» без полумесяца слева');
 assert.ok(css.includes('[data-theme="islands"] #btnClearAllExcelFilters { border-radius: 99px;'),'Б59: «Очистить фильтры таблицы» в общем формате кнопок');
 assert.ok(css.includes('.stock-mode-switch > #btnStockSearchMode { height: 27px;'),'Б59: «Другой склад» в общем формате кнопок');
 assert.ok(css.includes('input[type="number"]::-webkit-inner-spin-button'),'стрелки числовых полей убраны');
 assert.ok(css.includes('.qty-input,')&&css.includes('border-color: transparent; background: transparent;'),'цифры без обводки');
 assert.match(css,/\.toast \{[^}]*display: none/s,'тост на чёрном фоне не показывается');
 // Б56: фокус без синей обводки; у «Совпадение, %» стрелки возвращены; одна текущая строка.
 assert.ok(css.includes('input[type="number"]:focus,'),'фокус числовых полей без обводки');
 assert.ok(css.includes('#stockSimilarityPercent::-webkit-inner-spin-button { -webkit-appearance: inner-spin-button;'),'стрелки «Совпадение, %» возвращены');
 assert.ok(js.includes("querySelectorAll('tr.selected-row')"),'подсветка строки только одна — текущая');
 // Б59: стрелки «Совпадение, %» реально меняют значение на ±1.
 d.querySelector('[data-sim-step="1"]').click();assert.equal(d.getElementById('stockSimilarityPercent').value,'81','стрелка вверх: 80 -> 81');
 d.querySelector('[data-sim-step="-1"]').click();assert.equal(d.getElementById('stockSimilarityPercent').value,'80','стрелка вниз: 81 -> 80');
 assert.ok(css.includes('.v4-modal-actions { flex-wrap: wrap; }'),'Б60: кнопки диалогов переносятся внутри окна');
 assert.ok(css.includes('.preview-qty-input'),'Б60: поле количества в предпросмотре');
 assert.ok(css.includes('.sim-step { width: 24px; padding: 0 6px; font-size: 10px; }'),'Б61: стрелки «Совпадение» в два раза шире');
 assert.ok(html.includes('id="stockSimilarityPercent" type="text" inputmode="numeric"'),'Б62: поле «Совпадение» текстовое — нативное «облако» невозможно');
 assert.ok(css.includes('.sim-step { -webkit-appearance: none; appearance: none; background: none !important;'),'Б62: у стрелок нет подложки-«облака»');
 // Б65: элемент перерисован с нуля — стрелки-треугольники чистым CSS.
 assert.equal(d.querySelectorAll('.sim-step').length,0,'Б65: старых стрелок-кнопок/символов нет');
 assert.equal(d.querySelectorAll('.sim-arrow').length,2,'Б65: две CSS-стрелки');
 assert.ok([...d.querySelectorAll('.sim-arrow')].every(el=>el.tagName==='I'),'Б65: стрелки — элементы <i> без подложки');
 assert.ok(css.includes('.sim-arrow-up { border-bottom: 10px solid var(--text-muted); }'),'Б65: стрелка вверх — CSS-треугольник');
 assert.ok(css.includes('.sim-arrow-down { border-top: 10px solid var(--text-muted); }'),'Б65: стрелка вниз — CSS-треугольник');
 console.log('THEME UI б55: «Заказ»+дата, «Подсказка», умолчания 20/5, цифры без обводки, только «Острова+»: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
