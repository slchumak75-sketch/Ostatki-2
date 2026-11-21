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
 assert.ok(css.includes('.topbar-actions .btn.property-filter-active[aria-pressed="false"]'),'выключенные фильтры белеют');
 assert.ok(css.includes('.topbar-actions #btnFillOrder'),'единый цвет: автозаказ не выделяется');
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
 console.log('THEME UI б52: только «Острова+», соответствие макету №6, кнопки одного цвета: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
