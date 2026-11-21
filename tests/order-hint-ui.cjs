const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[],timers=[];
w.scrollTo=()=>{};w.setInterval=(cb,ms)=>{timers.push({cb,ms});return timers.length;};
const mk=(row,sku,name,stock,auto,final)=>({excelRow:row,sku,name,warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:stock,sumSalesLast12M:5,salesSegment:2,purchasePrice:1,monthlySales:[],autoOrderQty:auto,finalOrderQty:final});
const items=[mk(8,'001','Товар один',10,7,7),mk(9,'002','Товар два',3,5,9),mk(10,'003','Товар три',0,2,0)];
const env={report:{items,fileName:'Т.xlsx',periods:[],warehouses:[],suppliers:[],groups:[],params:{},totalItems:items.length},savedFileName:'',lastSavedAt:''};
w.fetch=async(path,options={})=>{
 calls.push({path,options});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 return {ok:true,json:async()=>env};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 // Б44: анализ остатков удалён, «+» стоит справа от «Подсветить заказ».
 assert.equal(d.getElementById('btnStockAnalysis'),null,'Б44: btnStockAnalysis удалён');
 assert.equal(d.getElementById('stockAnalysisModal'),null,'Б44: окно анализа удалено');
 assert.ok(d.getElementById('btnOrderHint'));
 assert.equal(d.getElementById('btnHighlightOrder').nextElementSibling.id,'btnOrderHint');
 assert.equal(d.getElementById('btnOrderHint').nextElementSibling.id,'btnToggleAdvanced');
 // Без подсвеченного заказа «+» не включается — подсказка.
 d.getElementById('btnOrderHint').click();await tick();
 assert.equal(d.getElementById('btnOrderHint').getAttribute('aria-pressed'),'false');
 assert.match(d.getElementById('toast').textContent,/Сначала включите/);
 // Включаем подсветку заказа и «+».
 d.getElementById('btnHighlightOrder').click();await tick();
 assert.equal(d.getElementById('btnOrderHint').getAttribute('aria-pressed'),'false');
 d.getElementById('btnOrderHint').click();await tick();
 assert.equal(d.getElementById('btnOrderHint').getAttribute('aria-pressed'),'true');
 assert.ok(d.getElementById('btnOrderHint').classList.contains('btn-active-toggle'));
 // Наведение на подсвеченную ячейку заказа → окошко с рекомендацией.
 const inp8=d.querySelector('input[data-qty-row="8"]');
 inp8.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 const pop=d.getElementById('orderHintPopover');
 assert.ok(!pop.classList.contains('hidden'),'окно рекомендации показано');
 assert.match(pop.textContent,/Рекомендованный заказ: 7 шт/);
 assert.equal(pop.querySelector('.oh-sub'),null,'совпадение с заказом — без второй строки');
 // Ручное изменение количества → вторая строка «В заказе».
 const inp9=d.querySelector('input[data-qty-row="9"]');
 inp9.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.match(pop.textContent,/Рекомендованный заказ: 5 шт/);
 assert.match(pop.textContent,/В заказе: 9 шт/);
 // Наведение вне ячейки количества прячет окно.
 d.querySelector('td.sku-cell')||d.querySelector('td');
 const anyCell=d.querySelector('#tableBody td');
 anyCell.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(pop.classList.contains('hidden'),'окно скрыто вне ячейки заказа');
 // Наведение на неподсвеченную ячейку — окно не появляется (все строки сняты).
 d.getElementById('btnHighlightOrder').click();await tick();
 inp8.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(pop.classList.contains('hidden'),'без подсветки окна нет');
 // Выключение режима «+».
 d.getElementById('btnHighlightOrder').click();await tick();
 d.getElementById('btnOrderHint').click();await tick();
 inp8.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(pop.classList.contains('hidden'),'режим выключен — окна нет');
 assert.equal(d.getElementById('btnOrderHint').getAttribute('aria-pressed'),'false');
 console.log('ORDER-HINT UI + б44 analysis removal: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
