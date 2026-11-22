const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
w.scrollTo=()=>{};w.setInterval=()=>1;
const mk=(row)=>({excelRow:row,sku:'00'+row,name:'Товар '+row,warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:2,purchasePrice:2,monthlySales:[],autoOrderQty:1,finalOrderQty:1});
const items=Array.from({length:30},(_,i)=>mk(8+i));
const env={report:{items,fileName:'Т.xlsx',periods:[],warehouses:[],suppliers:[],groups:[],params:{},totalItems:items.length},savedFileName:'',lastSavedAt:''};
w.fetch=async(path)=>{
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 return {ok:true,json:async()=>env};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=(ms=80)=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 await tick();
 const inp=d.querySelector('input[data-qty-row="8"]');
 assert.ok(inp,'Б75: таблица отрисована');
 inp.focus();
 // Обычное нажатие — один шаг, синхронно.
 inp.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
 assert.equal(Number(d.activeElement.dataset.qtyRow),9,'Б75: обычная стрелка — шаг на строку');
 // Б75: зажатая клавиша (repeat) — шаги копятся и применяются за кадр.
 const cur=d.activeElement;
 for(let i=0;i<5;i++) cur.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,repeat:true}));
 await tick(120);
 assert.equal(Number(d.activeElement.dataset.qtyRow),14,'Б75: повторы применены одним переходом (9 -> 14), фокус:',d.activeElement.dataset.qtyRow);
 // Вверх повторами — возврат.
 for(let i=0;i<2;i++) d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,repeat:true}));
 await tick(120);
 assert.equal(Number(d.activeElement.dataset.qtyRow),12,'Б75: повторы вверх работают');
 // Контракты кода: индекс строк, кэш сумм, лёгкий рендер.
 const src=fs.readFileSync('internal/server/web/app.js','utf8');
 assert.ok(src.includes('function filteredIndexOf'),'Б75: индекс строк');
 assert.ok(src.includes('supplierSumsCache'),'Б75: кэш сумм поставщиков');
 assert.ok(src.includes('queueKbdNavStep'),'Б75: склейка повторов');
 assert.ok(!src.includes("const idx=state.filteredItems.findIndex(it=>it.excelRow===Number(inp.dataset.qtyRow))"),'Б75: линейного поиска в обработчике стрелок нет');
 console.log('BATCH-75: fast arrow scrolling coalesced + cached sums: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
