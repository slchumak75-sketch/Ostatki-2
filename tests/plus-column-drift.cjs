// Батч-34: столбец «+» (пометка для выгрузки «Старьё») — всегда первый и
// всегда видимый; кнопка «Актуально» меняет только фильтрацию строк, а не
// раскладку таблицы. Регрессия прежних «разъездов» колонок при переключении.
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
const rows=()=>[...d.querySelectorAll('#tableBody tr[data-row]')].map(tr=>Number(tr.dataset.row)).sort((a,b)=>a-b);
(async()=>{
  await tick();
  const t=d.getElementById('itemsTable');
  const relevant=d.getElementById('btnRelevant');
  const ths=()=>[...t.querySelectorAll('thead tr th')];
  const colWidths=()=>[...t.querySelectorAll(':scope > colgroup > col')].map(c=>c.style.width);

  assert.equal(ths().findIndex(th=>th.classList.contains('plus-col')),0,'Plus column is the first header');
  assert.ok(t.querySelector('#tableBody tr[data-row]').firstElementChild.classList.contains('plus-cell'),'First body cell is the plus checkbox');

  // %-раскладка (как после нормировки ширин)
  let cg=d.createElement('colgroup');
  const n=ths().length,base=100/n;
  for(let i=0;i<n;i++){const c=d.createElement('col');c.style.width=base+'%';cg.appendChild(c);}
  t.insertBefore(cg,t.firstChild);
  t.classList.add('table-manual-cols');
  const widthsPct=colWidths();

  // Выключаем «Актуально» (4 клика) — раскладка неизменна, помеченные строки видны
  relevant.click();await tick(); // Б59: «Актуально» — один клик
  assert.equal(t.querySelector(':scope > colgroup'),cg,'colgroup node survives toggling');
  assert.ok(colWidths().every((v,i)=>v===widthsPct[i]),'widths unchanged after 4 toggles');
  assert.equal(colWidths().length,ths().length,'colgroup covers all columns');

  // Включаем обратно — то же самое
  relevant.click();await tick();
  assert.equal(t.querySelector(':scope > colgroup'),cg,'colgroup node still the same');
  assert.ok(colWidths().every((v,i)=>v===widthsPct[i]),'widths unchanged after re-enable');

  // px-раскладка (после перетаскивания колонок) — тот же инвариант
  cg=t.querySelector(':scope > colgroup');cg.remove();
  cg=d.createElement('colgroup');
  for(let i=0;i<n;i++){const c=d.createElement('col');c.style.width=(80+(i%5)*7)+'px';cg.appendChild(c);}
  t.insertBefore(cg,t.firstChild);
  const widthsPx=colWidths();
  relevant.click();await tick();
  assert.ok(colWidths().every((v,i)=>v===widthsPx[i]),'px-layout widths unchanged');
  relevant.click();await tick();
  assert.ok(colWidths().every((v,i)=>v===widthsPx[i]),'px-layout widths unchanged back');

  // Поведение фильтра: зелёное «Актуально» скрывает только помеченные строки
  const pressed=()=>relevant.getAttribute('aria-pressed');
  // Кнопка защищена от случайного выключения: активная кнопка отвечает на 4-й клик.
  const enable=async()=>{for(let i=0;i<4&&pressed()!=='true';i++){relevant.click();await tick();}};
  const disable=async()=>{for(let i=0;i<4&&pressed()!=='false';i++){relevant.click();await tick();}};
  await disable();
  const chk=d.querySelector('[data-plus-row="9"]');
  chk.checked=true;chk.dispatchEvent(new w.Event('change',{bubbles:true}));
  assert.ok(rows().includes(9),'Disabled relevance shows marked rows');
  assert.ok(chk.checked,'Marked row shows its checkbox');
  await enable();
  assert.ok(!rows().includes(9),'Active relevance hides marked rows');
  await disable();
  assert.ok(rows().includes(9),'Marked row visible again when disabled');
  const shown=d.querySelector('[data-plus-row="9"]');
  assert.ok(shown&&shown.checked,'Its checkbox is checked');
  await enable();
  const visibleChk=d.querySelector('[data-plus-row="8"]');
  assert.ok(visibleChk,'Unmarked rows still show empty checkboxes');
  assert.ok(!visibleChk.checked,'Their checkboxes are empty');
  console.log('PLUS-COLUMN-ALWAYS-FIRST: OK');
  process.exit(0);
})().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
