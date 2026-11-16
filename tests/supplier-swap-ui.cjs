// Батч-36: 1) кнопка «+» замены поставщика слева от имени, окно выбора не
// схлопывается при прокрутке списка; 2) «Загрузить заказ» отправляет файл
// в api/import/order и применяет результат к ведомости.
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.setInterval=()=>1;
const mk=(row,sku,name,stock)=>({excelRow:row,sku,name,warehouse:'Склад',group:'Группа',supplier:'Первый',sumSalesLast12M:5,closingStock:stock,monthlySales:[],salesSegment:2,autoOrderQty:0,finalOrderQty:0,purchasePrice:1,manualOverride:null});
const report={fileName:'Тест.xlsx',items:[mk(8,'X','Товар Икс',5),mk(9,'Y','Товар Игрек',3)],warehouses:[],groups:[],suppliers:[],periods:[],params:{}};
w.fetch=async(path,options={})=>{calls.push({path,body:options.body});if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};if(path==='api/import/order'){const env={report:{...report,items:[mk(8,'X','Товар Икс',5),mk(9,'Y','Товар Игрек',3)]}};env.report.items[0].finalOrderQty=25;return {ok:true,json:async()=>({state:env,importSummary:{applied:1,total:1}})};}return {ok:true,json:async()=>({report})};};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__s={state,applyEnvelope}; bootstrap();'));
const tick=()=>new Promise(r=>setTimeout(r,40));
(async()=>{try{
 await tick();const {state}=w.__s;
 // 1. Кнопка «+» — первый элемент в ячейке поставщика.
 const supCell=d.querySelector('#tableBody tr[data-row] .sup-cell');
 assert.ok(supCell.firstElementChild.classList.contains('sup-swap-btn'),'Кнопка «+» должна стоять слева от имени поставщика');
 // 2. Окно выбора: открывается, не схлопывается от прокрутки списка, закрывается от внешней.
 const btn=d.querySelector('[data-supswap-row="8"]');
 btn.click();await tick();
 const pop=d.getElementById('supplierSwapPopover');
 assert.ok(!pop.classList.contains('hidden'),'Окно выбора поставщика открылось');
 d.getElementById('supplierSwapList').dispatchEvent(new w.Event('scroll',{bubbles:true}));
 assert.ok(!pop.classList.contains('hidden'),'Прокрутка списка внутри окна НЕ закрывает окно');
 pop.dispatchEvent(new w.Event('scroll',{bubbles:true}));
 assert.ok(!pop.classList.contains('hidden'),'Прокрутка самого окна не закрывает его');
 d.getElementById('tableScrollContainer').dispatchEvent(new w.Event('scroll',{bubbles:true}));
 assert.ok(pop.classList.contains('hidden'),'Внешняя прокрутка закрывает окно');
 // 3. «Загрузить заказ».
 const imp=d.getElementById('btnImportOrder');
 assert.ok(imp,'Кнопка «Загрузить заказ» на верхней плашке');
 imp.click();
 const input=d.getElementById('orderImportInput');
 Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['x'],'заказ.xlsx')]});
 input.dispatchEvent(new w.Event('change'));await tick();
 const sent=calls.filter(c=>c.path==='api/import/order');
 assert.equal(sent.length,1,'Файл заказа отправлен на api/import/order');
 assert.ok(sent[0].body instanceof w.FormData,'Файл передаётся как multipart');
 assert.equal(state.report.items[0].finalOrderQty,25,'Ответ сервера применён к ведомости');
 console.log('SUPPLIER-SWAP-UI + ORDER-IMPORT: OK');process.exit(0);
}catch(e){console.error('FAIL:',e.message);process.exit(1);}})();
