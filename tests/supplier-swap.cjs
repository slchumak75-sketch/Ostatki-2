// Подмена поставщика в отдельной строке: «+» справа от поставщика в столбце
// «Поставщик» (только таблица Номенклатуры) открывает простой перечень
// поставщиков (без сумм и галочек); выбор заменяет поставщика в этой строке.
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];w.scrollTo=()=>{};w.setInterval=()=>1;
const make=(excelRow,sku,warehouse,autoOrderQty,supplier)=>({excelRow,sku,name:'Товар',warehouse,supplier,group:'Группа',closingStock:3,sumSalesLast12M:10,salesSegment:3,monthlySales:[],autoOrderQty,finalOrderQty:0,purchasePrice:2,manualOverride:0});
const items=[make(8,'001','Мир',5,'Поставщик'),make(9,'002','Мир',0,'Другой'),make(10,'003','Другой',7,'Третий')];
const report={fileName:'Тест.xlsx',items,params:{budgetCap:0},periods:[],warehouses:[],groups:[],suppliers:[]};
let overrideRequests=0;const originals={};
w.fetch=async(path,options={})=>{calls.push({path,options});
  if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:true})};
  if(path==='api/supplier-override'){
    overrideRequests++;
    const req=JSON.parse(options.body);
    const it=items.find(x=>x.excelRow===req.excelRow);
    if(!it)return {ok:false,json:async()=>({error:'неверная строка ведомости'})};
    if(!Object.prototype.hasOwnProperty.call(originals,req.excelRow))originals[req.excelRow]=it.supplier;
    if(originals[req.excelRow]===req.supplier)delete originals[req.excelRow];
    it.supplier=req.supplier;
    return {ok:true,json:async()=>({report,supplierOriginals:{...originals}})};
  }
  return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8').replace('  bootstrap();','  window.__swap={state,refreshExcelTable}; bootstrap();'));
const tick=(ms=70)=>new Promise(r=>setTimeout(r,ms));
const pop=()=>d.getElementById('supplierSwapPopover');
const listItems=()=>[...d.querySelectorAll('#supplierSwapList .ssp-item')].map(b=>b.textContent);
const toastText=()=>d.getElementById('toast').classList.contains('hidden')?'':d.getElementById('toast').textContent;
(async()=>{try{
 await tick();const {state,refreshExcelTable}=w.__drain||w.__swap;
 state.colFilters={};refreshExcelTable();
 // 1) Кнопка «+» есть в каждой строке таблицы Номенклатуры и только в ней.
 const btns=d.querySelectorAll('#tableBody [data-supswap-row]');
 assert.equal(btns.length,d.querySelectorAll('#tableBody tr[data-row]').length,'Each item row has the swap button');
 assert.equal(d.querySelectorAll('.sup-swap-btn').length,btns.length,'No swap buttons outside the items table');
 // 2) Клик «+» открывает перечень: только имена, без чекбоксов и сумм, без текущего поставщика строки.
 btns[0].click();
 assert.ok(!pop().classList.contains('hidden'),'Popover opens from the plus button');
 assert.equal(d.querySelectorAll('#supplierSwapList input[type="checkbox"]').length,0,'No checkboxes in the list');
 assert.deepEqual(listItems(),['Другой','Третий'],'Plain supplier names only, current one excluded');
 assert.ok(!/\d/.test(listItems().join('')),'No numeric sums in the list');
 // 3) Поиск фильтрует перечень.
 const search=d.getElementById('supplierSwapSearch');
 search.value='дрu'.replace('u','');search.value='Дру';search.dispatchEvent(new w.Event('input',{bubbles:true}));
 assert.deepEqual(listItems(),['Другой'],'Search filters the list');
 search.value='';search.dispatchEvent(new w.Event('input',{bubbles:true}));
 // 4) Esc закрывает поповер.
 d.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.ok(pop().classList.contains('hidden'),'Escape closes the popover');
 // 5) Выбор поставщика заменяет его в конкретной строке.
 btns[0].click();
 d.querySelector('#supplierSwapList [data-ssp-supplier="Другой"]').click();
 await tick();
 assert.equal(overrideRequests,1,'Substitution is sent to the server');
 const body=JSON.parse(calls.find(c=>c.path==='api/supplier-override').options.body);
 assert.deepEqual(body,{excelRow:8,supplier:'Другой'});
 const cell8=d.querySelector('[data-qty-row="8"]').closest('tr').querySelector('.sup-cell');
 assert.equal(cell8.textContent.replace('+','').trim(),'Другой','Row 8 shows the substituted supplier');
 assert.match(toastText(),/Поставщик заменён: Другой/);
 assert.ok(pop().classList.contains('hidden'),'Popover closes after the choice');
 // 6) Подмена затрагивает только одну строку.
 assert.equal(items[1].supplier,'Другой');assert.equal(items[2].supplier,'Третий');
 // 7) «+» остаётся: доступна переподмена, список больше не содержит действующего поставщика.
 const btn8=d.querySelector('[data-qty-row="8"]').closest('tr').querySelector('[data-supswap-row]');
 btn8.click();
 assert.ok(!pop().classList.contains('hidden'),'The plus button stays available for re-substitution');
 assert.deepEqual(listItems(),['Поставщик','Третий'],'Current supplier is excluded on re-swap');
 d.querySelector('#supplierSwapList [data-ssp-supplier="Поставщик"]').click();
 await tick();
 assert.equal(overrideRequests,2);
 assert.equal(d.querySelector('[data-qty-row="8"]').closest('tr').querySelector('.sup-cell').textContent.replace('+','').trim(),'Поставщик','Re-substitution applies');
 // 8) Клик мимо поповера закрывает его.
 const btn8b=d.querySelector('[data-qty-row="8"]').closest('tr').querySelector('[data-supswap-row]');
 btn8b.click();
 assert.ok(!pop().classList.contains('hidden'));
 d.body.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
 assert.ok(pop().classList.contains('hidden'),'Outside click closes the popover');
 // 9) Прокрутка закрывает поповер.
 btn8b.click();
 d.dispatchEvent(new w.Event('scroll',{bubbles:true}));
 assert.ok(pop().classList.contains('hidden'),'Scroll closes the popover');
 console.log('supplier-swap tests passed');
 process.exit(0);
}catch(err){console.error('FAIL:',err.message);console.error(toastText());process.exit(1);}})();
