// Батч-35: отметки «+» снимаются автоматически, если остаток позиции вырос
// по сравнению с остатком на момент отметки; новый товар отметок не наследует;
// отметки по номерам строк восстанавливаются только для той же ведомости.
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.setInterval=(cb,ms)=>1;w.scrollTo=()=>{};
const mk=(row,sku,name,stock)=>({excelRow:row,sku,name,warehouse:'Склад',group:'Группа',supplier:'Поставщик',sumSalesLast12M:5,closingStock:stock,monthlySales:[],salesSegment:2,autoOrderQty:0,finalOrderQty:0,purchasePrice:1,manualOverride:null});
const reportA={fileName:'A.xlsx',items:[mk(8,'X','Товар Икс',5),mk(9,'Y','Товар Игрек',3),mk(10,'Z','Товар Зет',2)],warehouses:[],groups:[],suppliers:[],periods:[],params:{}};
w.fetch=async(path,options={})=>{calls.push({path,body:options.body&&JSON.parse(options.body)});if(path==='api/properties')return {ok:true,json:async()=>({properties:{},markStocks:{},etalonLoaded:false})};return {ok:true,json:async()=>({report:reportA})};};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__dbg={state,applyEnvelope,get props(){return nomenclatureProperties;},set props(v){nomenclatureProperties=v;},get stocks(){return markStocks;},set stocks(v){markStocks=v;}}; bootstrap();'));
const tick=()=>new Promise(r=>setTimeout(r,40));
(async()=>{try{
 await tick();const {state,applyEnvelope,props,stocks}=w.__dbg;
 const keyOf=it=>JSON.stringify(['sku',it.sku,it.warehouse]);
 // 1. Отметка при остатке 5: свойство true, база остатка 5.
 state.report=reportA;state.rowMap=new Map(reportA.items.map(it=>[it.excelRow,it]));
 const chk=d.querySelector('[data-plus-row="8"]');
 chk.checked=true;chk.dispatchEvent(new w.Event('change',{bubbles:true}));
 const chkY=d.querySelector('[data-plus-row="9"]');
 chkY.checked=true;chkY.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(props[keyOf(reportA.items[0])],true,'Отметка записана в свойства');
 assert.equal(stocks[keyOf(reportA.items[0])],5,'База остатка зафиксирована (5)');
 assert.equal(stocks[keyOf(reportA.items[1])],3,'База остатка Игрека (3)');
 // 2. Новая ведомость: остаток Икса вырос до 7 -> отметка снялась; Игрек 3 -> осталась.
 const reportB={...reportA,fileName:'B.xlsx',items:[mk(8,'X','Товар Икс',7),mk(9,'Y','Товар Игрек',3),mk(10,'Z','Товар Зет',2),mk(11,'N','Совершенно новый товар',4)]};
 applyEnvelope({report:reportB,historyWorkbookId:1});await tick();
 assert.equal(props[keyOf(reportB.items[0])],false,'Вырос остаток — отметка снята');
 assert.equal(stocks[keyOf(reportB.items[0])],undefined,'База снятой отметки удалена');
 assert.equal(props[keyOf(reportB.items[1])],true,'Остаток не изменился — отметка осталась');
 assert.equal(props[keyOf(reportB.items[3])],undefined,'Новый товар без отметки');
 assert.ok(!state.staryoRows.has(8),'Строка с снятой отметкой чиста');
 assert.ok(state.staryoRows.has(9),'Оставшаяся отметка на месте');
 const persisted=calls.filter(c=>c.path==='api/properties'&&c.body&&c.body.properties&&c.body.properties[keyOf(reportB.items[0])]===false);
 assert.ok(persisted.length,'Снятие отметки отправлено на сервер');
 console.log('PLUS-AUTO-UNMARK: OK');process.exit(0);
}catch(e){console.error('FAIL:',e.message);process.exit(1);}})();
