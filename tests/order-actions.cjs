const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.setInterval=()=>1;
const make=(excelRow,sku,warehouse,autoOrderQty,finalOrderQty=0,supplier='Поставщик')=>({excelRow,sku,name:'Товар <пример>',warehouse,supplier,group:'Группа',closingStock:3,sumSalesLast12M:10,salesSegment:3,monthlySales:[],autoOrderQty,finalOrderQty,purchasePrice:2,manualOverride:finalOrderQty});
const items=[make(8,'001','Мир',5),make(9,'002','Мир',0),make(10,'001','Другой',7),make(11,'001','Мир',9,0,'Другой'),make(12,'001','Другой',2),make(13,'999','Другой',1)];
items[2].closingStock=4;items[4].closingStock=2;items[5].closingStock=99;items[5].name='Совершенно другая номенклатура';items.push(make(14,'005','Мир',0),make(15,'006','Другой',0));items[6].closingStock=0;items[7].closingStock=0;items.push(make(16,'007','Мир',0));items[8].closingStock=0;items[8].salesSegment=2;
const report={fileName:'Тест.xlsx',items,params:{budgetCap:0},periods:[],warehouses:[],groups:[],suppliers:[]};
w.fetch=async(path,options={})=>{calls.push({path,options});if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:true})};if(path==='api/override'){const req=JSON.parse(options.body);items.find(it=>it.excelRow===req.excelRow).finalOrderQty=req.value;}if(path==='api/orders/fill'){const req=JSON.parse(options.body);for(const it of items)if((it.warehouse===req.warehouse)&&(req.suppliers||[req.supplier]).includes(it.supplier)){it.finalOrderQty=(req.clear||req.cancel)?0:it.autoOrderQty;it.manualOverride=(req.clear||req.cancel)?null:it.finalOrderQty;}}return {ok:true,json:async()=>({report})};};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__actions={state,refreshExcelTable,collectUIState,applyEnvelope}; bootstrap();'));
const tick=()=>new Promise(r=>setTimeout(r,70));
(async()=>{try{
 await tick();const {state,refreshExcelTable,collectUIState,applyEnvelope}=w.__actions;
 const highlight=d.getElementById('btnHighlightOrder');assert.equal(d.getElementById('btnFillOrder'),null,'Б55: кнопки «Сделать автозаказ» в плашке нет');
 // Квадратик «×» по умолчанию зелёный (подсказки выключены); включаем для сценариев ниже.
 assert.equal(state.stockHintsDisabled,true,'Stock hints must start disabled (green square)');
 assert.ok(d.getElementById('btnStockSearchMode').disabled,'Mode button is disabled while hints are off');
 d.getElementById('btnStockHintsOff').click();
 assert.equal(state.stockHintsDisabled,false);
 assert.equal(d.getElementById('btnImportOrder').nextElementSibling,highlight);assert.equal(highlight.nextElementSibling.id,'btnOrderHint');assert.equal(d.getElementById('btnOrderHint').nextElementSibling.id,'btnToggleAdvanced');

 state.colFilters={warehouse:['Мир'],supplier:['Поставщик']};refreshExcelTable();
 const before=JSON.stringify(items),beforeBudget=d.getElementById('kpiOrderCost').textContent,beforeCalls=calls.length;
 highlight.click();assert.equal(JSON.stringify(items),before,'Highlight must never write quantities, even when all are blank');assert.equal(calls.length,beforeCalls);assert.equal(d.getElementById('kpiOrderCost').textContent,beforeBudget);
 assert.equal(d.querySelector('[data-qty-row="8"]').value,'');assert.ok(d.querySelector('[data-qty-row="8"]').classList.contains('order-highlighted'));assert.ok(!d.querySelector('[data-qty-row="9"]').classList.contains('order-highlighted'));assert.deepEqual([...state.highlightedOrderRows].sort((a,b)=>a-b),[8,14,16],'Rated(2+) zero-stock rows are recommended too');assert.equal(d.querySelector('#tableBody tr[data-row]').dataset.row,'8');
 d.querySelector('[data-filter-col="finalOrderQty"]').click();assert.ok(d.querySelector('[data-excel-only="Рекомендовано"]'));d.querySelector('[data-excel-only="Рекомендовано"]').click();assert.deepEqual([...state.filteredItems].map(it=>it.excelRow),[8,14,16],'Recommendations filter includes rated zero-stock rows');
 delete state.colFilters.finalOrderQty;refreshExcelTable();
 const name=d.querySelector('[data-stock-row="8"]');name.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));const pop=d.getElementById('warehouseStockPopover');assert.ok(!pop.classList.contains('hidden'));assert.match(pop.textContent,/6,00 шт/);assert.ok(!pop.textContent.includes('99'));assert.equal(pop.querySelector('пример'),null,'Product names are escaped');assert.ok(pop.textContent.includes('0,00 шт'),'Other-warehouse hints keep zero-stock rows');d.getElementById('btnStockSearchMode').click();name.dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));assert.ok(!pop.classList.contains('hidden'));assert.match(pop.textContent,/3,00 шт/);assert.ok(!pop.textContent.includes('0,00 шт'),'Similar mode must hide zero-stock rows');d.getElementById('btnStockSearchMode').click();d.dispatchEvent(new w.Event('scroll'));assert.ok(pop.classList.contains('hidden'));
 // Б56: при переходе ввода в другую строку подсветка уходит за ней; предыдущая не висит.
 const inp9sel=d.querySelector('[data-qty-row="9"]');inp9sel.dispatchEvent(new w.FocusEvent('focusin',{bubbles:true}));
 assert.deepEqual([...d.querySelectorAll('tr.selected-row')].map(tr=>tr.dataset.row),['9'],'Подсвечена только текущая строка ввода');
 // Б58: движение курсора на другую строку уводит подсветку за курсором; предыдущая гаснет.
 d.querySelector('[data-qty-row="8"]').dispatchEvent(new w.MouseEvent('mouseover',{bubbles:true}));
 assert.deepEqual([...d.querySelectorAll('tr.selected-row')].map(tr=>tr.dataset.row),['8'],'Б58: подсветка следует за курсором');
 // Б66: стрелки вверх/вниз перемещаются по колонке «Заказ» между строками.
 const navInp=d.querySelector('[data-qty-row="8"]');navInp.focus();
 const navOrder=state.filteredItems.map(it=>it.excelRow),navIdx=navOrder.indexOf(8);
 navInp.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
 assert.equal(d.activeElement.dataset.qtyRow,String(navOrder[navIdx+1]),'Б66: ArrowDown — окошко заказа следующей видимой строки');
 d.activeElement.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
 assert.equal(d.activeElement.dataset.qtyRow,'8','Б66: ArrowUp — окошко заказа предыдущей строки');
 const qty=d.querySelector('[data-qty-row="8"]');qty.dispatchEvent(new w.FocusEvent('focusin',{bubbles:true}));qty.value='4';qty.dispatchEvent(new w.Event('input',{bubbles:true}));qty.dispatchEvent(new w.FocusEvent('focusout',{bubbles:true}));await tick();
 // Заказ, проставленный в подсвеченной ячейке, не снимает подсветку.
 assert.ok(qty.classList.contains('order-highlighted'),'Typing an order must keep the highlight');
 assert.ok(!qty.classList.contains('is-manual'));assert.ok(state.highlightedOrderRows.has(8),'Highlight set retains the edited row');
 const star=d.querySelector('[data-qty-row="9"]');star.dispatchEvent(new w.FocusEvent('focusin',{bubbles:true}));star.value='*';star.dispatchEvent(new w.Event('input',{bubbles:true}));star.dispatchEvent(new w.FocusEvent('focusout',{bubbles:true}));await tick();assert.equal(star.value,'пер');assert.equal(items[1].finalOrderQty,0);assert.ok(state.orderTransferRows.has(9));assert.deepEqual([...collectUIState().orderTransferRows],[9]);
 highlight.click();assert.equal(state.highlightedOrderRows.size,0,'Toggle removes the still-highlighted row');
 highlight.click();const saved=collectUIState();assert.deepEqual([...saved.highlightedOrderRows].sort((a,b)=>a-b),[8,14,16]);applyEnvelope({report,uiState:saved,savedFileName:'Тест'},{restoreSaved:true});assert.ok(state.highlightedOrderRows.has(8));
 // Restore explicit scope after the saved-state replay.
 state.colFilters={warehouse:['Мир'],supplier:['Поставщик']};refreshExcelTable();
 const outside=items.filter(it=>it.warehouse!=='Мир'||it.supplier!=='Поставщик').map(it=>it.finalOrderQty);




 const beforeToggle=JSON.stringify(items);highlight.click();assert.equal(state.highlightedOrderRows.size,0);assert.equal(JSON.stringify(items),beforeToggle);assert.equal(highlight.getAttribute('aria-pressed'),'false');highlight.click();assert.ok(state.highlightedOrderRows.has(8));
 state.filledOrderScopes.add(JSON.stringify(['Поставщик','Мир']));const toggledSaved=collectUIState();assert.equal(toggledSaved.filledOrderScopes.length,1);applyEnvelope({report,uiState:toggledSaved,savedFileName:'Тест'},{restoreSaved:true});assert.equal(state.filledOrderScopes.size,1,'Filled scope survives saved-state restoration');
 state.colFilters={warehouse:['Мир'],supplier:['Поставщик']};refreshExcelTable();
 const rating=d.querySelector('[data-rating-row="8"]'),pill=rating.querySelector('.seg-pill')||rating,chart=d.getElementById('ratingChartPopover');
 pill.getBoundingClientRect=()=>({left:300,right:320,top:400,bottom:420,width:20,height:20});Object.defineProperty(chart,'offsetHeight',{configurable:true,value:220});
 rating.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.ok(!chart.classList.contains('hidden'));assert.equal(chart.style.top,'170px','Chart is positioned above the rating');assert.equal(chart.classList.contains('rcp-below'),false);assert.equal(chart.style.width,'548px');assert.equal(chart.getAttribute('aria-hidden'),'false');
 pill.getBoundingClientRect=()=>({left:300,right:320,top:10,bottom:30,width:20,height:20});rating.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.ok(chart.classList.contains('rcp-below'),'Use below only when above would leave the viewport');
 d.dispatchEvent(new w.Event('scroll'));assert.ok(chart.classList.contains('hidden'));
 assert.equal(d.querySelectorAll('[data-reset], .reset-cell-btn').length,0,'Order cells never show reset arrows after fills, cancellations or manual edits');
 // Explicit multi-selection applies both actions to all selected suppliers, not budget checks.
 state.colFilters={warehouse:['Мир']};state.filledOrderScopes.clear();state.highlightedOrderRows.clear();refreshExcelTable();
 d.querySelector('[data-filter-col="supplier"]').click();const selectAll=d.getElementById('efSelectAllChk');selectAll.checked=true;selectAll.dispatchEvent(new w.Event('change',{bubbles:true}));d.getElementById('efBtnOk').click();assert.equal(state.colFilters.supplier.length,2,'Selecting all suppliers explicitly must retain the scope');
 const differentWarehouse=items.filter(it=>it.warehouse==='Другой').map(it=>it.finalOrderQty);
 highlight.click();assert.deepEqual([...state.highlightedOrderRows].sort((a,b)=>a-b),[8,11,14,16]);


 // «Подсветить заказ» допускает несколько поставщиков и несколько складов; ничего не выбрано — все.
 state.colFilters={};state.highlightedOrderRows.clear();refreshExcelTable();
 highlight.click();assert.deepEqual([...state.highlightedOrderRows].sort((a,b)=>a-b),[8,10,11,12,13,14,15,16],'No filters: recommendations across all suppliers and warehouses, incl. rated zero-stock');
 assert.equal(highlight.getAttribute('aria-pressed'),'true','Highlight button reads as active for the whole base');
 highlight.click();assert.equal(state.highlightedOrderRows.size,0,'Repeat click removes only the highlighted scope');
 state.colFilters={warehouse:['Мир','Другой'],supplier:['Поставщик']};refreshExcelTable();
 highlight.click();assert.deepEqual([...state.highlightedOrderRows].sort((a,b)=>a-b),[8,10,12,13,14,15,16],'Several warehouses at once, one supplier');
 assert.equal(highlight.getAttribute('aria-pressed'),'true');
 highlight.click();assert.equal(state.highlightedOrderRows.size,0,'Toggle off spans every selected warehouse');
 // Столбец «Склад» таблицы Номенклатуры: Мир — светло-зелёный, Кореличи — бежевый.
 assert.ok(d.querySelector('#tableBody tr[data-row="8"] td.wh-cell').classList.contains('wh-mir'),'Mir warehouse cells are tinted light green');
 assert.ok(!d.querySelector('#tableBody tr[data-row="8"] td.wh-cell').classList.contains('wh-korelichi'));
 state.colFilters={};refreshExcelTable();
 items[7].warehouse='Склад Кореличи';refreshExcelTable();
 const korCell=d.querySelector('#tableBody tr[data-row="15"] td.wh-cell');
 assert.ok(korCell.classList.contains('wh-korelichi'),'Korelichi warehouse cells are tinted beige');
 assert.ok(!korCell.classList.contains('wh-mir'));
 items[7].warehouse='Другой';refreshExcelTable();
 // Restore the pre-existing scope for the following parameter-change scenario.
 state.colFilters={warehouse:['Мир'],supplier:['Поставщик','Другой']};state.highlightedOrderRows.clear();refreshExcelTable();




 // Clear requires both explicit warehouse selection and confirmation.
 items[0].finalOrderQty=6;items[2].finalOrderQty=7;items[3].finalOrderQty=9;state.orderTransferRows.add(9);refreshExcelTable();
 d.querySelector('[data-filter-col="supplier"]').click();
 const clearCalls=()=>calls.filter(c=>c.path==='api/orders/fill'&&JSON.parse(c.options.body).clear);
 d.querySelector('[data-supplier-clear="Поставщик"]').click();assert.ok(!d.getElementById('safetyDialog').classList.contains('hidden'));assert.equal(clearCalls().length,0);d.getElementById('safetyDialogNo').click();await tick();assert.equal(clearCalls().length,0);assert.equal(items[0].finalOrderQty,6);
 d.querySelector('[data-supplier-clear="Поставщик"]').click();await tick();const whBtns=[...d.querySelectorAll('#safetyDialog .v4-modal-actions button')].filter(b=>b.textContent.includes('Склад'));assert.deepEqual(whBtns.map(b=>b.textContent.replace(/ \+ .*/,'')),['Склад Другой','Склад Мир'],'Б59: кнопки складов с суммами + Отмена');assert.ok(whBtns.every(b=>/\+ [\d\s]+,\d{2} руб\./.test(b.textContent)),'Б59: у каждой кнопки склада — сумма заказа');whBtns.find(b=>b.textContent.includes('Мир')).click();await tick();assert.equal(clearCalls().length,1);assert.equal(JSON.parse(clearCalls()[0].options.body).warehouse,'Мир');assert.equal(items[0].finalOrderQty,0);assert.equal(items[2].finalOrderQty,7,'Same supplier on another warehouse must remain unchanged');assert.equal(items[3].finalOrderQty,9);assert.ok(!state.orderTransferRows.has(9));assert.ok(!state.filledOrderScopes.has(JSON.stringify(['Поставщик','Мир'])));
 // Parameter changes interactively refresh already filled scopes; manual edits opt out.
 state.filledOrderScopes.clear();state.autoFilledQuantities={};state.highlightedOrderRows.clear();state.orderTransferRows.clear();state.colFilters={warehouse:['Мир'],supplier:['Поставщик']};refreshExcelTable();
 state.filledOrderScopes.add(JSON.stringify(['Поставщик','Мир']));state.autoFilledQuantities={8:5,9:0,14:0,16:0};assert.ok(state.filledOrderScopes.has(JSON.stringify(['Поставщик','Мир'])));
 let base=calls.length;
 d.getElementById('inpHorizon').value='90';d.getElementById('inpHorizon').dispatchEvent(new w.Event('change'));
 await new Promise(r=>setTimeout(r,300));
 const paramCalls=calls.slice(base);
 assert.equal(paramCalls.filter(c=>c.path==='api/params').length,1,'Debounced parameter change still posts params once');
 const refreshes=paramCalls.filter(c=>c.path==='api/orders/fill');
 assert.equal(refreshes.length,1,'Filled scope must refresh exactly once per parameter change');
 const refreshReq=JSON.parse(refreshes[0].options.body);
 assert.equal(refreshReq.supplier,'Поставщик');assert.equal(refreshReq.warehouse,'Мир');assert.ok(!refreshReq.cancel,'Refresh must not cancel the order');assert.equal(refreshReq.clear,undefined);assert.equal(refreshReq.params.horizonDays,90);
 assert.deepEqual(refreshReq.refreshRows,{8:5,9:0,14:0,16:0});
 const manual=d.querySelector('[data-qty-row="8"]');manual.dispatchEvent(new w.FocusEvent('focusin',{bubbles:true}));manual.value='2';manual.dispatchEvent(new w.Event('input',{bubbles:true}));manual.dispatchEvent(new w.FocusEvent('focusout',{bubbles:true}));await tick();
 assert.equal(state.autoFilledQuantities[8],undefined,'Manual edit must opt the row out of interactive refresh');
 base=calls.length;
 d.getElementById('inpSafety').value='35';d.getElementById('inpSafety').dispatchEvent(new w.Event('change'));
 await new Promise(r=>setTimeout(r,300));
 const optOut=calls.slice(base).filter(c=>c.path==='api/orders/fill');
 assert.equal(optOut.length,1);assert.deepEqual(JSON.parse(optOut[0].options.body).refreshRows,{9:0,14:0,16:0});
 state.filledOrderScopes.clear();state.autoFilledQuantities={};












 state.colFilters={warehouse:['Мир'],supplier:['Поставщик']};refreshExcelTable();
 const css=fs.readFileSync('internal/server/web/styles.css','utf8');assert.ok(css.includes('.qty-input.order-highlighted'));assert.ok(css.includes('.qty-input.order-highlighted.wh-mir { background: #e4f0e7;'),'Mir highlight = warehouse colour');assert.ok(css.includes('.qty-input.order-highlighted.wh-korelichi { background: #f5ead6;'),'Korelichi highlight = warehouse colour');assert.ok(css.includes('.order-cell.order-cell-highlighted.wh-mir { background: #e4f0e7; }'));assert.ok(!css.includes('.qty-input.is-manual'));
 assert.ok(css.includes('.topbar-actions #btnOrderHint'),'Top-bar buttons share one colour (batch-52)');assert.ok(!css.includes('#fde047'),'Yellow auto-order buttons removed');assert.ok(css.includes('#itemsTable td.wh-cell.wh-mir { background:#e4f0e7; }'),'Mir warehouse colour matches mockup 6');
 // Скрытая вкладка «Поставщики» не перестраивается при наборе заказа: рендер откладывается до открытия.
 d.getElementById('warehousesContainer').innerHTML='<div id="staleMarker"></div>';
 const qtyCell=d.querySelector('[data-qty-row="8"]');qtyCell.dispatchEvent(new w.FocusEvent('focusin',{bubbles:true}));qtyCell.value='2';qtyCell.dispatchEvent(new w.Event('input',{bubbles:true}));qtyCell.dispatchEvent(new w.FocusEvent('focusout',{bubbles:true}));
 await tick();await new Promise(r=>setTimeout(r,320));
 assert.ok(d.getElementById('staleMarker'),'Hidden suppliers tab must not rebuild while typing');
 d.querySelector('[data-tab="suppliers"]').click();
 assert.ok(!d.getElementById('staleMarker'),'Opening the suppliers tab must apply the deferred render');
 console.log('Scoped order actions, blank recommendation highlighting, filters/sorting, manual edit styling, persistence and other-warehouse stock tooltip passed');
}finally{w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
