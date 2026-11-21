const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[],timers=[];
w.scrollTo=()=>{};w.setInterval=(cb,ms)=>{timers.push({cb,ms});return timers.length;};
const mk=(row,sku,name,stock,auto,final)=>({excelRow:row,sku,name,warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:stock,sumSalesLast12M:5,salesSegment:2,purchasePrice:1,monthlySales:[],autoOrderQty:auto,finalOrderQty:final});
const items=[mk(8,'001','Товар один',10,7,7),mk(9,'002','Товар два',3,5,9),mk(10,'003','Товар три',0,2,0),mk(11,'004','Товар четыре',0,0,0),mk(12,'005','Товар пять',0,0,7)];
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
 // Батч-55: «+» у «Подсветить заказ» убран; его функции — у отдельной кнопки «Подсказка».
 assert.equal(d.getElementById('btnStockAnalysis'),null,'анализ остатков удалён');
 assert.equal(d.getElementById('stockAnalysisModal'),null,'окно анализа удалено');
 assert.equal(d.getElementById('btnFillOrder'),null,'кнопка «Сделать автозаказ» убрана');
 assert.equal(d.getElementById('orderHintBadge'),null,'бейджа «+» больше нет');
 const badge=d.getElementById('btnOrderHint');
 assert.ok(badge,'кнопка «Подсказка» есть');
 assert.equal(badge.textContent,'Подсказка');
 assert.equal(d.getElementById('btnHighlightOrder').textContent,'Подсветить заказ','у кнопки подсветки только текст, без «+»');
 assert.equal(d.getElementById('btnHighlightOrder').nextElementSibling.id,'btnOrderHint','«Подсказка» сразу после «Подсветить заказ»');
 assert.equal(badge.nextElementSibling.id,'btnToggleAdvanced');
 // Без подсвеченного заказа «Подсказка» не включается — сообщение.
 badge.click();await tick();
 assert.equal(badge.getAttribute('aria-pressed'),'false');
 assert.match(d.getElementById('toast').textContent,/Сначала включите/);
 // Включаем подсветку заказа, затем «Подсказку».
 d.getElementById('btnHighlightOrder').click();await tick();
 badge.click();await tick();
 assert.equal(badge.getAttribute('aria-pressed'),'true');
 assert.ok(badge.classList.contains('btn-active-toggle'));
 // Нажатие «Подсказки» не переключило саму подсветку (окно ниже показывается).
 // Наведение курсора на подсвеченную ячейку → окошко справа, внутри ТОЛЬКО число.
 const inp8=d.querySelector('input[data-qty-row="8"]');
 const td8=inp8.closest('td.order-cell');
 td8.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 const pop=d.getElementById('orderHintPopover');
 assert.ok(!pop.classList.contains('hidden'),'окно показано');
 assert.equal(pop.textContent.trim(),'7','в окошке только число');
 // Движение курсора внутри ячейки (qty-editor, input) — окно стабильно.
 td8.querySelector('.qty-editor').dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(!pop.classList.contains('hidden'),'окно стабильно (qty-editor)');
 inp8.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(!pop.classList.contains('hidden'),'окно стабильно (input)');
 // Уход курсора из ячейки прячет окно.
 td8.dispatchEvent(new w.MouseEvent('mouseout',{bubbles:true,relatedTarget:d.querySelector('#tableBody td')}));
 assert.ok(pop.classList.contains('hidden'),'окно скрыто на mouseout');
 // Другая подсвеченная ячейка (ручное количество 9 при рекомендации 5) — в окошке только 5.
 const td9=d.querySelector('input[data-qty-row="9"]').closest('td.order-cell');
 td9.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(!pop.classList.contains('hidden'),'окно показано для соседней ячейки');
 assert.equal(pop.textContent.trim(),'5');
 // Подсвеченная строка без рекомендации (алгоритм 0, в заказе 0) — нуль не показывается, окошка нет.
 const td11=d.querySelector('input[data-qty-row="11"]').closest('td.order-cell');
 td11.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(pop.classList.contains('hidden'),'нулевая рекомендация не показывается');
 // Подсвеченная строка с нулевым авторасчётом, но с заказом 7 — в окошке 7, а не 0.
 const td12=d.querySelector('input[data-qty-row="12"]').closest('td.order-cell');
 td12.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(!pop.classList.contains('hidden'),'окно показано для ячейки с заказом');
 assert.equal(pop.textContent.trim(),'7');
 // Наведение вне ячейки заказа прячет окно.
 d.querySelector('#tableBody td').dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(pop.classList.contains('hidden'),'окно скрыто вне ячейки заказа');
 // Снятие подсветки — окна нет.
 d.getElementById('btnHighlightOrder').click();await tick();
 td8.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(pop.classList.contains('hidden'),'без подсветки окна нет');
 // Повторное нажатие «Подсказки» выключает режим.
 badge.click();await tick();
 assert.equal(badge.getAttribute('aria-pressed'),'false');
 assert.ok(!badge.classList.contains('btn-active-toggle'));
 td8.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.ok(pop.classList.contains('hidden'),'режим выключен — окна нет');
 console.log('ORDER-HINT UI: «Подсказка» button + number-only popover: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
