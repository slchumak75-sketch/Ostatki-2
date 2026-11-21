// Регрессия (батч-28, адаптирована в батче-55): смена отмеченных складов
// перестраивала список поставщиков и МОЛЧА СБРАСЫВАЛА выбранного поставщика,
// если его склад не среди отмеченных. Выбор поставщика обязан переживать
// смену складов. Батч-55: кнопка «Сделать автозаказ» убрана из плашки,
// поэтому сценарии нажатия на неё заменены проверкой её отсутствия.
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const mk=(r,sup,wh)=>({excelRow:r,name:'Товар '+r,sku:String(r),warehouse:wh,group:'Группа',supplier:sup,sumSalesLast12M:10,closingStock:2,monthlySales:[],salesSegment:2,finalOrderQty:5,purchasePrice:1});
const items=[mk(1,'Односклад','Склад А'),mk(2,'Односклад','Склад А'),mk(3,'Многосклад','Склад А'),mk(4,'Многосклад','Склад Б')];
const warehouses=[
  {warehouse:'Склад А',totalOrderCost:10,orderItems:2,totalItems:3},
  {warehouse:'Склад Б',totalOrderCost:5,orderItems:1,totalItems:1},
];
const envelope=()=>({ok:true,json:async()=>({report:{items,warehouses,groups:[],suppliers:[{supplier:'Односклад',warehouse:'Склад А',totalOrderCost:10,orderItems:2},{supplier:'Многосклад',warehouse:'Склад А',totalOrderCost:5,orderItems:1},{supplier:'Многосклад',warehouse:'Склад Б',totalOrderCost:5,orderItems:1}],periods:[],params:{},fileName:'test.xlsx'}})});
w.setInterval=(cb,ms)=>1;
w.fetch=async(path,options={})=>envelope();
w.scrollTo=()=>{};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
// Меню складов перерисовывается после каждого изменения — узлы каждый раз читаем заново
const setWarehouse=async(name,checked)=>{
  d.querySelector('[data-ms-trigger="warehouse"]').click();
  await tick();
  const box=d.querySelector(`input[data-ms-check="warehouse"][value="${name}"]`);
  assert.ok(box,'чекбокс склада найден: '+name);
  if(box.checked!==checked){box.click();box.dispatchEvent(new w.Event('change',{bubbles:true}));}
  await tick();
  d.querySelector('[data-ms-trigger="warehouse"]').click();
  await tick();
};
const pickSupplier=async(name)=>{
  const btn=[...d.querySelectorAll('[data-sup-select]')].find(b=>b.dataset.supSelect===name);
  assert.ok(btn,'кнопка поставщика в выпадающем списке: '+name);
  btn.click();
  await tick();
};
(async()=>{
  await tick();
  // Б55: кнопки «Сделать автозаказ» в плашке нет; «Подсказка» — на её месте по смыслу рядом с подсветкой.
  assert.equal(d.getElementById('btnFillOrder'),null,'кнопка «Сделать автозаказ» убрана');
  assert.equal(d.getElementById('btnOrderHint').textContent,'Подсказка');
  // Отмечены ОБА склада, выбран поставщик «Односклад» (только «Склад А»).
  await setWarehouse('Склад А',true);
  await setWarehouse('Склад Б',true);
  assert.equal(d.getElementById('lblMsWarehouse').textContent,'Склады: 2','оба склада отмечены');
  await pickSupplier('Односклад');
  assert.equal(d.getElementById('fltSupplier').value,'Односклад');
  // Смена складов НЕ сбрасывает поставщика: отмечен только чужой «Склад Б».
  await setWarehouse('Склад А',false);
  assert.equal(d.getElementById('fltSupplier').value,'Односклад','выбор поставщика пережил смену складов');
  // И обратно: возврат склада тоже сохраняет выбор; другой поставщик выбирается как раньше.
  await setWarehouse('Склад А',true);
  assert.equal(d.getElementById('fltSupplier').value,'Односклад');
  await pickSupplier('Многосклад');
  assert.equal(d.getElementById('fltSupplier').value,'Многосклад','смена поставщика работает');
  console.log('SUPPLIER-SINGLE-WAREHOUSE (б55): выбор поставщика переживает смену складов: OK');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
