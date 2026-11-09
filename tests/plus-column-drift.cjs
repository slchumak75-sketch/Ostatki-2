// Регрессия (батч-27): «разъезд» колонок от кнопки «Актуально».
// Воспроизводит сценарий из жизни: таблица загружена с %-раскладкой (ширины
// восстановлены/нормированы), dataset.pxBase в свежей сессии НЕ существует.
// Прежний код вставлял в %-мир колонку «+» литеральными '32px', наивная
// нормировка parseFloat смешивала единицы — «+» раздувался до ~24% и
// расталкивал соседние колонки; при обратном переключении всё съезжало назад.
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
const items=[8,9,10,11,12].map(r=>({excelRow:r,name:'Товар '+r,sku:String(r),warehouse:'Склад',group:'Группа',supplier:'Поставщик',sumSalesLast12M:5,closingStock:2,monthlySales:[],salesSegment:0,finalOrderQty:0,purchasePrice:1}));
w.setInterval=(cb,ms)=>1;
w.fetch=async()=>({ok:true,json:async()=>({report:{items,warehouses:[],groups:[],suppliers:[],periods:[],params:{},fileName:'test.xlsx'}})});
w.scrollTo=()=>{};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,50));
const plusIdx=()=>[...d.querySelectorAll('#itemsTable thead th')].findIndex(th=>th.classList.contains('plus-col'));
const colsNow=()=>{const cg=d.getElementById('itemsTable').querySelector(':scope > colgroup');return cg?[...cg.querySelectorAll('col')]:[];};
const assertAllPct=(label)=>{
  for(const c of colsNow())assert.ok(c.style.width.endsWith('%'),label+': в colgroup не-% ширина: '+c.style.width);
};
const assertPlusNarrow=(label)=>{
  const col=colsNow()[plusIdx()];
  const v=parseFloat(col.style.width);
  assert.ok(v>0.3&&v<6,label+`: столбец «+» ${col.style.width} должен быть узким (~2-3%)`);
};
(async()=>{
  await tick();
  const t=d.getElementById('itemsTable');
  const relevant=d.getElementById('btnRelevant');
  // Сценарий 1: СВЕЖАЯ СЕССИЯ, %-раскладка (14 колонок, «+» скрыт), pxBase отсутствует.
  let cg=d.createElement('colgroup');
  const n=14,base=100/n;
  for(let i=0;i<n;i++){const c=d.createElement('col');c.style.width=base+'%';cg.appendChild(c);}
  t.insertBefore(cg,t.firstChild);
  t.classList.add('table-manual-cols');
  // 4 клика — «Актуально» выключен, «+» появляется
  for(let i=0;i<4;i++){relevant.click();await tick();}
  assert.equal(colsNow().length,15,'показ «+»: 15 колонок');
  assertAllPct('показ «+»');
  assertPlusNarrow('показ «+»');
  // Обратно: включили «Актуально» — «+» скрылся, колонки не изменились
  relevant.click();await tick();
  assert.equal(colsNow().length,14,'скрытие «+»: 14 колонок');
  assertAllPct('после скрытия');
  // Ещё цикл — стабильность
  for(let i=0;i<4;i++){relevant.click();await tick();}
  assert.equal(colsNow().length,15,'повторный показ: 15 колонок');
  assertAllPct('повторный показ');
  assertPlusNarrow('повторный показ');
  // Сценарий 2: px-раскладка (после перетаскивания колонок) — тот же инвариант.
  relevant.click();await tick();
  cg=d.getElementById('itemsTable').querySelector(':scope > colgroup');
  cg.remove();
  cg=d.createElement('colgroup');
  for(let i=0;i<14;i++){const c=d.createElement('col');c.style.width=(80+(i%5)*7)+'px';cg.appendChild(c);}
  t.insertBefore(cg,t.firstChild);
  for(let i=0;i<4;i++){relevant.click();await tick();}
  assert.equal(colsNow().length,15,'px-мир: 15 колонок');
  assertAllPct('px-мир после нормировки');
  assertPlusNarrow('px-мир');
  relevant.click();await tick();
  assert.equal(colsNow().length,14,'px-мир: скрытие — 14 колонок');
  console.log('PLUS-COLUMN-DRIFT: OK');
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
