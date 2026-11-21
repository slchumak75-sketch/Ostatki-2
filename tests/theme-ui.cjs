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
 // Все пять дизайнов объявлены в CSS.
 for(const t of ['classic','cabinet','saas','paper','terminal']){
   assert.ok(css.includes(`[data-theme="${t}"]`),`тема ${t} в CSS`);
 }
 assert.ok(css.includes('--btnbar-bg'),'единый цвет кнопок (btnbar-токены)');
 assert.ok(css.includes('.topbar-actions .btn.property-filter-active[aria-pressed="false"]'),'выключенные фильтры белеют');
 assert.ok(!css.includes('.btn.property-filter-active { background:#bde5c4'),'старое зелёное правило фильтров убрано');
 assert.ok(css.includes('[data-theme="classic"] .btn { border-radius: 8px'),'classic: мягкие скругления');
 assert.ok(css.includes('[data-theme="cabinet"] .data-table td { border-right'),'cabinet: сетка таблицы');
 assert.ok(css.includes('[data-theme="saas"] .toolbar'),'\n'+'saas: плавающая панель' && css.includes('[data-theme="saas"] .table-container'),'saas: карточка таблицы');
 assert.ok(css.includes('[data-theme="paper"] .toolbar { background: transparent'),'paper: прозрачная панель');
 assert.ok(css.includes('[data-theme="paper"] .topbar-actions { border-bottom: 1px dotted'),'paper: точечный разделитель');
 assert.ok(css.includes('[data-theme="terminal"] .data-table tbody tr:nth-child(even) td'),'terminal: зебра');
 assert.ok(css.includes('monospace'),'terminal: моноширинные цифры');
 // Высота строк одинакова во всех вариантах: паддинги td темами не переопределяются.
 assert.ok(!/\[data-theme="[a-z]+"\] \.data-table tbody td \{ padding/.test(css),'паддинги строк не зависят от темы');
 // Кнопки верхней панели — в одну линию.
 assert.ok(css.includes('.topbar-actions .btn { white-space: nowrap'),'кнопки в одну линию');
 // Приглушённые цвета рейтинга прежние (б47).
 assert.ok(css.includes('.seg-pill.seg-5 { background-color: #5fae77 !important'),'рейтинг приглушён');
 assert.match(css,/--bg: #f6f1e7;/);
 assert.match(css,/--primary: #b45309;/);
 console.log('THEME UI б48: 5 дизайнов, одинаковые строки, кнопки в линию: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
