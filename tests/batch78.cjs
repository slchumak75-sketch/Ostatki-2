const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар ноль',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4},{excelRow:9,sku:'002',name:'Товар запас',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:7,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:2,finalOrderQty:2}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[{warehouse:'Мир',totalItems:2,zeroStockItems:1,overstockItems:0,overstockCost:0}],suppliers:[{supplier:'Поставщик',warehouse:'Мир',totalItems:2,orderItems:2,totalOrderQty:6,totalOrderCost:12}],groups:[]};
w.fetch=async(path,options={})=>{
 const body=options.body?JSON.parse(options.body):null;
 calls.push({path,body});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/column-widths'&&options.method==='POST')return {ok:true,json:async()=>({ok:true})};
 if(path==='api/column-widths')return {ok:true,json:async()=>({widths:{}})};
 if(path==='api/orders/sent-marks')return {ok:true,json:async()=>({sent:[{key:'Поставщик|Мир',supplier:'Поставщик',warehouse:'Мир',sentAt:'22.11.2026 10:00',to:'zakaz@example.com'}]})};
 if(path==='api/db/save')return {ok:true,json:async()=>({fileName:'Ведомость сохраненная.xlsx',savedAt:'22.11.2026'})};
 if(path==='api/shutdown')return {ok:true,json:async()=>({})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__b78={state};bootstrap();'));
const tick=()=>new Promise(r=>setTimeout(r,90));
(async()=>{try{
 await tick();await tick();
 // Б78-2: «Выход» — в шапке перед «Параметры», название прежнее, не в скрытой панели.
 const exitBtn=d.getElementById('btnAppExit');
 assert.ok(exitBtn,'Б78: кнопка «Выход» на месте');
 assert.equal(exitBtn.textContent.trim(),'Выход','Б78: название кнопки не меняем');
 assert.equal(exitBtn.nextElementSibling.id,'btnToggleAdvanced','Б78: «Выход» над кнопкой «Параметры» (в шапке перед ней)');
 assert.ok(!exitBtn.closest('#paramsPanel'),'Б78: «Выход» не спрятана в панели параметров');
 // Б78-3: крестик (beforeunload) больше не открывает наш диалог вслепую.
 w.dispatchEvent(new w.Event('beforeunload',{cancelable:true}));await tick();
 assert.ok(d.getElementById('closeConfirmModal').classList.contains('hidden'),'Б78: beforeunload не открывает диалог эталона');
 // По «Выход» диалог открывается; «Отмена» только закрывает его.
 exitBtn.click();await tick();
 assert.ok(!d.getElementById('closeConfirmModal').classList.contains('hidden'),'Б78: «Выход» открывает вопрос про эталон');
 d.getElementById('btnCloseSaveCancel').click();await tick();
 assert.ok(d.getElementById('closeConfirmModal').classList.contains('hidden'),'Б78: «Отмена» закрывает только диалог');
 assert.ok(!calls.some(c=>c.path==='api/shutdown'),'Б78: после «Отмены» программа не завершается');
 // Б78-4: галочка «Отправлено» на кнопке «Почта».
 d.getElementById('btnSupTabCheckAll').click();await tick();
 const mailBtn=d.querySelector('[data-mail-sup]');
 assert.ok(mailBtn,'Б78: кнопка «Почта» отрисована');
 assert.match(mailBtn.textContent,/✓/,'Б78: галочка отправленного на «Почта»');
 assert.match(mailBtn.title,/Отправлено/);
 // Б78-6: кружок «0» включает подсветку остатков 0 независимо от основной подсветки.
 const zero=d.getElementById('btnHighlightZero');
 assert.ok(zero&&zero.closest('#btnHighlightOrder'),'Б78: кружок «0» внутри «Подсветить заказ»');
 assert.ok(!zero.classList.contains('on'),'Б78: по умолчанию кружок выключен (красный)');
 const row8=d.querySelector('tr[data-row="8"]'),row9=d.querySelector('tr[data-row="9"]');
 assert.ok(row8&&row9,'строки таблицы отрисованы');
 assert.ok(!row8.querySelector('.qty-input').classList.contains('zero-order-hl'));
 zero.click();await tick();
 assert.ok(zero.classList.contains('on'),'Б78: после клика кружок включён (зелёный)');
 assert.ok(d.querySelector('input[data-qty-row="8"]').classList.contains('zero-order-hl'),'Б79: овал в столбце «Заказ» у остатка 0');
 assert.ok(!d.querySelector('tr[data-row="8"]').classList.contains('zero-stock-hl'),'Б79: вся строка не подсвечивается');
 assert.ok(!d.querySelector('input[data-qty-row="9"]').classList.contains('zero-order-hl'),'Б79: остаток 7 без овала');
 zero.click();await tick();
 assert.ok(!d.querySelector('input[data-qty-row="8"]').classList.contains('zero-order-hl'),'Б79: повторный клик снимает подсветку нулей');
 // Б78-5: галочка на включённой «Подсказке».
 d.getElementById('btnHighlightOrder').click();await tick();
 d.getElementById('btnOrderHint').click();await tick();
 assert.equal(d.getElementById('btnOrderHint').textContent,'Подсказка ✓','Б78: галочка справа на включённой «Подсказке»');
 d.getElementById('btnOrderHint').click();await tick();
 assert.equal(d.getElementById('btnOrderHint').textContent,'Подсказка','Б78: выключенная «Подсказка» без галочки');
 // Б78-7: «Актуально» вкл/выкл — та же страница, даже если якорная строка отфильтровалась.
 const st=w.__b78.state;
 st.staryoRows.add(9); // строка 9 отмечена «+»: при включённом «Актуально» скрыта
 d.getElementById('btnRelevant').click();await tick(); // выключили «Актуально» — строка 9 видна
 const scroller=d.getElementById('tableScrollContainer');
 scroller.scrollTop=29; // якорь: вторая строка (excelRow 9), сдвиг 1*24+5
 d.getElementById('btnRelevant').click();await tick();await tick(); // включили «Актуально» — строка 9 скрылась
 assert.equal(scroller.scrollTop,29,'Б78: «Актуально» не уводит со страницы (тот же сдвиг, без прыжка к началу/концу)');
 d.querySelector('[data-tab="suppliers"]').click();await tick();
 d.getElementById('btnRelevant').click();await tick();
 assert.equal(d.querySelector('.tab-btn.active').dataset.tab,'suppliers','Б78: «Актуально» не меняет вкладку');
 console.log('BATCH-78: exit+mail-check+hint-check+zero-circle+actualno-stays: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
