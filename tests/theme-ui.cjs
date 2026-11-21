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
 // Б50: вторая пятёрка дизайнов (макеты №6–10) объявлена в CSS, старых тем нет.
 for(const t of ['islands','ribbon','console','excelbook','terminal']){
   assert.ok(css.includes(`[data-theme="${t}"]`),`тема ${t} в CSS`);
 }
 for(const t of ['classic','cabinet','saas','paper']){
   assert.ok(!css.includes(`[data-theme="${t}"]`),`старая тема ${t} удалена`);
 }
 assert.ok(css.includes('--btnbar-bg'),'единый цвет кнопок (btnbar-токены)');
 assert.ok(css.includes('.topbar-actions .btn.property-filter-active[aria-pressed="false"]'),'выключенные фильтры белеют');
 assert.ok(!css.includes('.btn.property-filter-active { background:#bde5c4'),'старое зелёное правило фильтров убрано');
 // Скелеты концептов (не перекраска): острова/лента/пульт/книга/терминал.
 assert.ok(css.includes('[data-theme="islands"] .topbar-actions .btn { border-radius: 99px'),'islands: кнопки-пилюли');
 assert.ok(css.includes('[data-theme="islands"] .table-container'),'islands: карточка таблицы');
 assert.ok(css.includes('[data-theme="ribbon"] .topbar-actions::after'),'ribbon: подписи групп команд');
 assert.ok(css.includes('[data-theme="ribbon"] #btnClearDatabase'),'ribbon: разрывы групп');
 assert.ok(css.includes('[data-theme="console"] .tabs-order-summary { order: -1'),'console: полоса показателей первой строкой');
 assert.ok(css.includes('[data-theme="console"] .budget-inline-card'),'console: акцентная плитка бюджета');
 assert.ok(css.includes('[data-theme="excelbook"] .tabs-bar {\n  position: fixed;'),'excelbook: вкладки-листы закреплены снизу');
 assert.ok(css.includes('[data-theme="excelbook"] .header-controls-strip::before'),'excelbook: строка fx');
 assert.ok(css.includes('[data-theme="terminal"] .data-table tbody tr:nth-child(even) td'),'terminal: зебра');
 assert.ok(css.includes('monospace'),'terminal: моноширинные цифры');
 // Вертикальных (боковых) панелей нет: темы не сдвигают workspace и не фиксируют панели по бокам.
 assert.ok(!/\[data-theme="[a-z]+"\] \.workspace \{[^}]*margin-(left|right)/.test(css),'нет боковых панелей (workspace без боковых отступов от тем)');
 assert.ok(!css.includes('grid-template-columns: 198px'),'нет левой колонки навигации');
 // Вертикальные границы столбцов — во всех вариантах.
 assert.ok(css.includes('.data-table td { border-right: 1px solid #d7e0e9; }'),'вертикальные границы ячеек');
 for(const t of ['islands','ribbon','console','excelbook','terminal']){
   assert.ok(css.includes(`[data-theme="${t}"] .data-table td { border-right: 1px solid #d7e0e9; }`)||css.includes('[data-theme="islands"] .data-table td, [data-theme="ribbon"] .data-table td,'),'границы заданы для всех тем');
 }
 // Рейтинг — только цифра в кружке, без текстовых подписей в ячейке.
 assert.ok(js.includes('<span class="seg-pill seg-${segNum}" data-rating-row="${it.excelRow}">${segNum}</span>'),'рейтинг: только цифра');
 assert.ok(!js.includes('seg-pill seg-${segNum}">${segNum} ·'),'рейтинг без слов');
 // Высота строк одинакова во всех вариантах: паддинги td темами не переопределяются.
 assert.ok(!/\[data-theme="[a-z]+"\][^{]*\.data-table[^{]*td[^{]*\{[^}]*padding/.test(css),'паддинги строк не зависят от темы');
 // Кнопки верхней панели — в одну линию.
 assert.ok(css.includes('.topbar-actions .btn { white-space: nowrap'),'кнопки в одну линию');
 // Приглушённые цвета рейтинга прежние (б47).
 assert.ok(css.includes('.seg-pill.seg-5 { background-color: #5fae77 !important'),'рейтинг приглушён');
 assert.match(css,/--bg: #f6f1e7;/);
 assert.match(css,/--primary: #b45309;/);
 console.log('THEME UI б50: 5 скелетов №6–10, без боковых панелей, рейтинг-цифра, сетка: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
