// Регрессия (батч-28): автозаказ для поставщика, который водится только на одном складе.
// Два дефекта:
// 1) orderScope требовал «ровно один отмеченный склад», даже когда склад поставщика
//    однозначен: при двух отмеченных складах (или одном чужом) «Сделать автозаказ»
//    падал с «Выберите один склад»;
// 2) смена отмеченных складов перестраивала список поставщиков и МОЛЧА СБРАСЫВАЛА
//    выбранного поставщика, если его склад не среди отмеченных, — автозаказу уже
//    некого было заказывать.
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
const fills=[];
w.setInterval=(cb,ms)=>1;
w.fetch=async(path,options={})=>{
  if(path==='api/orders/fill'){fills.push(JSON.parse(options.body));}
  return envelope();
};
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
  // 1) Отмечены ОБА склада, поставщик «Односклад» (только «Склад А») → автозаказ по его складу
  await setWarehouse('Склад А',true);
  await setWarehouse('Склад Б',true);
  assert.equal(d.getElementById('lblMsWarehouse').textContent,'Склады: 2','оба склада отмечены');
  await pickSupplier('Односклад');
  fills.length=0;
  d.getElementById('btnFillOrder').click();
  await tick();await tick();
  assert.equal(fills.length,1,'автозаказ должен выполниться при двух отмеченных складах');
  assert.equal(fills[0].warehouse,'Склад А','склад поставщика подставлен автоматически');
  assert.equal(fills[0].supplier,'Односклад');
  // 2) Смена складов НЕ сбрасывает поставщика: отмечен только чужой «Склад Б»
  await setWarehouse('Склад А',false);
  assert.equal(d.getElementById('fltSupplier').value,'Односклад','выбор поставщика пережил смену складов');
  d.getElementById('btnFillOrder').click();
  await tick();await tick();
  assert.equal(fills.length,2,'автозаказ должен выполниться при чужом отмеченном складе');
  assert.equal(fills[1].warehouse,'Склад А');
  // 3) Многоскладовой поставщик при двух отмеченных складах — по-прежнему требует один склад
  await setWarehouse('Склад А',true);
  assert.equal(d.getElementById('lblMsWarehouse').textContent,'Склады: 2');
  await pickSupplier('Многосклад');
  fills.length=0;
  d.getElementById('btnFillOrder').click();
  await tick();await tick();
  assert.equal(fills.length,0,'многоскладовому поставщику нужен явный один склад (инвариант сохранён)');
  // 4) Многоскладовой + ровно его склад — работает как раньше
  await setWarehouse('Склад Б',false);
  d.getElementById('btnFillOrder').click();
  await tick();await tick();
  assert.equal(fills.length,1);
  assert.equal(fills[0].warehouse,'Склад А');
  console.log('SUPPLIER-SINGLE-WAREHOUSE-AUTOFILL: OK');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
