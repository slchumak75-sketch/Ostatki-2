const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
w.scrollTo=()=>{};w.setInterval=()=>1;
const mk=(row,auto)=>({excelRow:row,sku:'00'+row,name:'Товар '+row,warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:2,purchasePrice:1,monthlySales:[],autoOrderQty:auto,finalOrderQty:1});
const items=Array.from({length:30},(_,i)=>mk(8+i,i+3));
const byRow=new Map(items.map(it=>[it.excelRow,it]));
const env={report:{items,fileName:'Т.xlsx',periods:[],warehouses:[],suppliers:[],groups:[],params:{},totalItems:items.length},savedFileName:'',lastSavedAt:''};
w.fetch=async(path)=>{
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 return {ok:true,json:async()=>env};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=(ms=80)=>new Promise(r=>setTimeout(r,ms));
const recOf=(row)=>{const it=byRow.get(row);const a=Math.round(it.autoOrderQty||0);return String(a>0?a:Math.round(it.finalOrderQty||0));};
(async()=>{try{
 await tick();
 d.getElementById('btnHighlightOrder').click();await tick();
 d.getElementById('btnOrderHint').click();await tick();
 const pop=d.getElementById('orderHintPopover');
 // Порядок строк в таблице — как отрисовано (сортировка может отличаться от excelRow).
 const order=[...d.querySelectorAll('input[data-qty-row]')].map(n=>Number(n.dataset.qtyRow));
 assert.ok(order.length>=8,'Б76: строк достаточно');
 const inp=d.querySelector(`input[data-qty-row="${order[0]}"]`);
 inp.focus();await tick(30);
 assert.ok(!pop.classList.contains('hidden'),'Б76: подсказка у первой строки');
 assert.equal(pop.textContent.trim(),recOf(order[0]),'Б76: рекомендация первой строки');
 // Одиночный шаг — подсказка сразу за фокусом, как раньше.
 inp.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
 assert.equal(Number(d.activeElement.dataset.qtyRow),order[1],'Б76: шаг на следующую строку');
 assert.equal(pop.textContent.trim(),recOf(order[1]),'Б76: одиночный шаг — подсказка сразу');
 // Быстрый поток: подсказка не перемеряется на каждой строке...
 const before=pop.textContent.trim();
 for(let i=0;i<4;i++) d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,repeat:true}));
 assert.equal(pop.textContent.trim(),before,'Б76: в потоке подсказка не дёргается за каждой строкой');
 // ...а на паузе показывается для текущей строки.
 await tick(400);
 assert.equal(Number(d.activeElement.dataset.qtyRow),order[5],'Б76: фокус после повторов');
 assert.equal(pop.textContent.trim(),recOf(order[5]),'Б76: на паузе подсказка текущей строки');
 // Контракты кода плавности.
 const src=fs.readFileSync('internal/server/web/app.js','utf8');
 assert.ok(src.includes('noteKbdNavStep'),'Б76: учёт потока шагов');
 assert.ok(src.includes('kbdNavBurstSteps >= 3'),'Б76: подсказка на паузе в потоке');
 assert.ok(src.includes('deferredPitchTimer'),'Б76: калибровка высоты — на паузе');
 const focusBody=src.slice(src.indexOf('function focusQtyRow'),src.indexOf("el('tableBody').addEventListener('keydown'"));
 assert.equal((focusBody.match(/getBoundingClientRect/g)||[]).length,2,'Б76: в focusQtyRow одна фактическая поправка (одна пара замеров)');
 console.log('BATCH-76: smooth arrow scrolling (single correction, deferred hint/pitch): OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
