// Регрессия варианта 7 (после релиза #95): «Сделать автозаказ» и «Очистить» у поставщика
// блокировались тостом «Дождитесь сохранения введённого количества и повторите».
// Кнопки должны ждать сохранения количества (короткий бюджет), а очередь override
// обязана разгружаться при любом исходе запроса — успех, ошибка, сбой, отмена.
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.setInterval=()=>1;
 let failNextOverride=false,hangOverride=false,abortNextOverride=false;
const make=(excelRow,sku,warehouse,autoOrderQty,finalOrderQty=0,supplier='Поставщик')=>({excelRow,sku,name:'Товар',warehouse,supplier,group:'Группа',closingStock:3,sumSalesLast12M:10,salesSegment:3,monthlySales:[],autoOrderQty,finalOrderQty,purchasePrice:2,manualOverride:finalOrderQty});
const items=[make(8,'001','Мир',5),make(9,'002','Мир',0),make(10,'001','Другой',7),make(11,'001','Мир',9,0,'Другой')];
const report={fileName:'Тест.xlsx',items,params:{budgetCap:0},periods:[],warehouses:[],groups:[],suppliers:[]};
w.fetch=async(path,options={})=>{
  calls.push({path,options});
  if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:true})};
  if(path==='api/override'){
    if(abortNextOverride){abortNextOverride=false;const err=new Error('The operation was aborted');err.name='AbortError';throw err;}
    if(failNextOverride){failNextOverride=false;return {ok:false,json:async()=>({error:'сервер недоступен'})};}
    if(hangOverride)return new Promise(()=>{});
    const req=JSON.parse(options.body);
    items.find(it=>it.excelRow===req.excelRow).finalOrderQty=req.value;
  }
  if(path==='api/orders/fill'){const req=JSON.parse(options.body);for(const it of items)if((it.warehouse===req.warehouse)&&(req.suppliers||[req.supplier]).includes(it.supplier)){it.finalOrderQty=(req.clear||req.cancel)?0:it.autoOrderQty;it.manualOverride=(req.clear||req.cancel)?null:it.finalOrderQty;}}
  return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__drain={state,refreshExcelTable}; bootstrap();'));
const tick=(ms=70)=>new Promise(r=>setTimeout(r,ms));
const toastText=()=>d.getElementById('toast').classList.contains('hidden')?'':d.getElementById('toast').textContent;
const typeQty=(row,val)=>{const inp=d.querySelector(`[data-qty-row="${row}"]`);inp.dispatchEvent(new w.FocusEvent('focusin',{bubbles:true}));inp.value=val;inp.dispatchEvent(new w.Event('input',{bubbles:true}));return inp;};
const lastToastIncludes=(txt)=>toastText().includes(txt);
(async()=>{try{
 await tick();const {state,refreshExcelTable}=w.__drain;
 const fill=d.getElementById('btnFillOrder');
 state.colFilters={warehouse:['Мир'],supplier:['Поставщик']};refreshExcelTable();
 // 1) Ввод количества и мгновенное нажатие «Сделать автозаказ»: кнопка ждёт сохранения,
 //    а не показывает «Дождитесь сохранения введённого количества и повторите».
 let callsBefore=calls.length;
 typeQty(8,'4');
 fill.click();await tick(400);
 assert.ok(!lastToastIncludes('Дождитесь сохранения'),'Fill must wait for the pending quantity instead of blocking');
 assert.ok(calls.some(c=>c.path==='api/orders/fill'),'Fill request must be sent after the quantity drains');
 assert.ok(calls.slice(callsBefore).find(c=>c.path==='api/override'),'Edited quantity is saved first');
 const overrideIdx=calls.slice(callsBefore).findIndex(c=>c.path==='api/override'),fillIdx=calls.slice(callsBefore).findIndex(c=>c.path==='api/orders/fill');
 assert.ok(overrideIdx>-1&&fillIdx>-1&&overrideIdx<fillIdx,'The quantity save precedes the auto-order request');
 assert.equal(JSON.parse(calls.filter(c=>c.path==='api/override').at(-1).options.body).value,4);
 // 1б) Отмена запроса сохранения (AbortError — как при загрузке ведомости/эталона) не залипает в очереди.
 abortNextOverride=true;callsBefore=calls.length;
 typeQty(8,'6');
 await tick(400);
 assert.ok(!lastToastIncludes('Дождитесь сохранения'),'Aborted save must not leave the queue blocked');
 fill.click();await tick(400);
 assert.ok(calls.slice(callsBefore).some(c=>c.path==='api/orders/fill'),'Fill works right after an aborted save');
 // 2) Сбой сохранения количества больше не блокирует кнопки навсегда: очередь разгружается.
 failNextOverride=true;callsBefore=calls.length;
 typeQty(8,'2');
 await tick(400); // 280мс таймер отправляет override, запрос падает
 assert.ok(!lastToastIncludes('Дождитесь сохранения'),'Failed save must not leave the queue blocked');
 assert.ok(lastToastIncludes('сервер недоступен'),'The failure is reported to the user');
 fill.click();await tick(400);
 assert.ok(calls.slice(callsBefore).some(c=>c.path==='api/orders/fill'),'Fill works right after a failed quantity save');
 // 3) «Очистить» у поставщика тоже ждёт несохранённое количество и выполняется.
 callsBefore=calls.length;
 typeQty(8,'3');
 d.querySelector('[data-filter-col="supplier"]').click();
 const clearBtn=d.querySelector('[data-supplier-clear]');
 assert.ok(clearBtn,'Supplier filter popover shows the clear button');
 clearBtn.click();
 await tick();
 assert.ok(!d.getElementById('safetyDialog').classList.contains('hidden'),'Clear dialog opens');
 const clearSupplier=clearBtn.dataset.supplierClear;
 const expectedWarehouses=['Выберите склад',...[...new Set(items.filter(it=>it.supplier===clearSupplier).map(it=>it.warehouse))].sort()];
 const opts=[...d.getElementById('supplierClearWarehouse').options].map(o=>o.textContent);
 assert.deepEqual(opts,expectedWarehouses,'Dialog lists the supplier warehouses');
 d.getElementById('supplierClearWarehouse').value='0';
 d.getElementById('safetyDialogYes').click();
 await tick(400);
 assert.ok(!lastToastIncludes('Дождитесь сохранения'),'Clear must wait for the pending quantity instead of blocking');
 const clearReq=calls.slice(callsBefore).find(c=>c.path==='api/orders/fill'&&JSON.parse(c.options.body).clear===true);
 assert.ok(clearReq,'Clear request is sent after the quantity drains');
 assert.equal(JSON.parse(clearReq.options.body).supplier,clearSupplier);
 // 4) Если сохранение зависло — честный тост по истечении бюджета, автозаказ не выполняется.
 hangOverride=true;callsBefore=calls.length;
 typeQty(8,'7');
 fill.click();
 await tick(5300);
 assert.ok(lastToastIncludes('Дождитесь сохранения'),'Stuck save explains itself after the wait budget');
 assert.ok(!calls.slice(callsBefore).some(c=>c.path==='api/orders/fill'),'Fill is not sent while the save is stuck');
 assert.equal(fill.disabled,false,'Fill button is re-enabled after the failed wait');
 console.log('override-drain tests passed');
 process.exit(0);
}catch(err){console.error('FAIL:',err.message);console.error(toastText());process.exit(1);}})();
