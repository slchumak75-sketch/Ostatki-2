const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
for(const id of ['tableScrollContainer','overstockContainer','chartsContent']) assert.ok(d.getElementById(id).classList.contains('statement-surface'),'Statement and analysis tabs share a surface style');
for(const selector of ['#overstockToolbar','.charts-controls']) assert.ok(d.querySelector(selector).classList.contains('analysis-controls'));

w.eval(fs.readFileSync('internal/server/web/charts.js','utf8'));
const periods=[1,2,3].map(month=>({year:2026,month,label:`Месяц ${month}`}));
const item=(row,wh,group,sup,price,sales)=>({excelRow:row,warehouse:wh,group,supplier:sup,purchasePrice:price,monthlySales:sales,sku:String(row),name:'Товар',salesSegment:0,sumSalesLast12M:5,closingStock:1,finalOrderQty:0});
const items=[item(8,'A','Группа <1>','S1',10,[1,2,3]),item(9,'B','Группа <1>','S2',20,[2,0,1]),item(10,'A','Группа 2','S1',5,[0,2,-1]),item(11,'A','Группа 2','S3',0,[100,100,100])];
const rep={fileName:'test.xlsx',items,periods,warehouses:[],groups:[],suppliers:[],params:{}};
const before=JSON.stringify(rep);
w.SalesCharts.update(rep);
assert.equal(d.querySelector('[data-tab="overstock"]').nextElementSibling.dataset.tab,'charts');
assert.equal(d.querySelectorAll('#chartKind option').length,5);
assert.ok(d.getElementById('chartTop'),'Top-10 selector exists');
assert.ok(d.getElementById('chartUnit'),'Units selector exists');
let data=w.SalesCharts.aggregate(rep,'groups','',0,2);
assert.equal(data.total,130);assert.equal(data.rows[0].total,120);assert.equal(data.excluded,1);assert.equal(data.returns,1);
assert.equal(JSON.stringify(rep),before,'Charts never mutate the report');
const change=(id,value)=>{d.getElementById(id).value=value;d.getElementById(id).dispatchEvent(new w.Event('change'));};
assert.ok(!d.querySelector('#chartsContent script'));
change('chartWarehouse','B');assert.match(d.getElementById('chartsContent').textContent,/60,00/);
change('chartFrom','1');change('chartTo','1');assert.match(d.getElementById('chartsContent').textContent,/нет положительных продаж/);
change('chartWarehouse','');change('chartFrom','0');change('chartTo','2');
for(const kind of ['groups','suppliers','supplierShares','groupShares','monthlyGroups']){
 change('chartKind',kind);assert.ok(d.querySelector('#chartsContent svg'));assert.ok(d.querySelector('#chartsContent .chart-values.data-table'),'Exact chart values use statement table styling');
 assert.match(d.getElementById('chartsContent').textContent,/130,00/);
 if(kind.endsWith('Shares'))assert.match(d.getElementById('chartsContent').textContent,/%/);
}
// Динамика по группам: тонкие гладкие кривые, шкала по каждому месяцу, панель выбора групп.
change('chartKind','monthlyGroups');
assert.equal(d.querySelectorAll('#chartsContent path').length,2,'One smooth curve per product group');
assert.equal(d.querySelectorAll('#chartsContent path[stroke-width="1.3"]').length,2,'Very thin lines');
assert.ok(d.querySelectorAll('#chartsContent circle').length>=6,'Marker dots on the curves');
assert.match(d.querySelector('#chartsContent path title').textContent,/Группа/);
assert.equal(d.querySelectorAll('#chartsContent svg text[transform^="rotate(-35"]').length,3,'Every month is labeled on the horizontal scale');
assert.ok(!d.getElementById('chartGroupPicker').classList.contains('hidden'),'Group picker is visible for the dynamics chart');
assert.equal(d.querySelectorAll('#chartGroupList input[data-cgp-group]').length,2,'Picker lists all groups');
assert.match(d.querySelector('#chartsContent svg').textContent,/50,00/,'Default autoscale covers the strongest group');
// Выбор одной группы галочкой: одна линия, вертикаль автомасштабируется под неё.
const g2=[...d.querySelectorAll('#chartGroupList input[data-cgp-group]')].find(c=>c.dataset.cgpGroup==='Группа 2');
g2.checked=true;g2.dispatchEvent(new w.Event('change',{bubbles:true}));
assert.equal(d.querySelectorAll('#chartsContent path').length,1,'Only the checked group is drawn');
assert.ok(!d.querySelector('#chartsContent svg').textContent.includes('50,00'),'Autoscale drops the unchecked peak');
assert.match(d.querySelector('#chartsContent svg').textContent,/10,00/,'Scale fits the selected group');
// Сброс выбора возвращает топ-15 (обе группы).
d.getElementById('chartGroupReset').click();
assert.equal(d.querySelectorAll('#chartsContent path').length,2,'Reset restores the top groups');
// Суммарный режим: все отмеченные группы складываются в одну линию «Сумма (N)».
// После каждого change список перерисовывается — галочки ставим по свежему DOM.
for(const name of ['Группа <1>','Группа 2']){
  const c=[...d.querySelectorAll('#chartGroupList input[data-cgp-group]')].find(x=>x.dataset.cgpGroup===name);
  c.checked=true;c.dispatchEvent(new w.Event('change',{bubbles:true}));
}
d.getElementById('chartSumMode').checked=true;d.getElementById('chartSumMode').dispatchEvent(new w.Event('change'));
assert.equal(d.querySelectorAll('#chartsContent path').length,1,'Sum mode draws a single total curve');
assert.match(d.querySelector('#chartsContent path title').textContent,/Сумма \(2\)/,'Sum curve is labelled');
assert.equal(d.querySelectorAll('#chartsContent path[stroke-width="2.4"]').length,1,'Sum curve is thicker');
// Поквартальный режим: точки — суммы за квартал, светлые полосы кварталов.
d.getElementById('chartQuarterBands').checked=true;d.getElementById('chartQuarterBands').dispatchEvent(new w.Event('change'));
assert.match(d.getElementById('chartsContent').textContent,/1 кв\. 2026/,'Quarter labels on the axis');
assert.equal(d.querySelectorAll('#chartsContent .qband').length,1,'One light band per quarter');
assert.match(d.getElementById('chartsContent').textContent,/сумма за квартал/,'Quarterly note is shown');
d.getElementById('chartSumMode').checked=false;d.getElementById('chartSumMode').dispatchEvent(new w.Event('change'));
assert.match(d.querySelector('#chartsContent circle title').textContent,/1 кв\. 2026 — Группа <1>: 120,00/,'Per-group quarterly sum in money');
d.getElementById('chartQuarterBands').checked=false;d.getElementById('chartQuarterBands').dispatchEvent(new w.Event('change'));
d.getElementById('chartGroupReset').click();
assert.equal(d.querySelectorAll('#chartsContent path').length,2,'Back to monthly per-group curves');
assert.equal(d.getElementById('chartGroupHint').textContent.includes('топ-15'),true,'Hint mentions the top-15 default');
change('chartFrom','2');change('chartTo','0');assert.match(d.getElementById('chartsContent').textContent,/Начало периода/);
change('chartFrom','0');change('chartTo','2');
// Топ-10 + «Прочие» и единицы «шт.».
change('chartKind','groups');change('chartTop','top10');assert.ok(d.querySelector('#chartsContent svg'),'Top-10 keeps small datasets intact');
change('chartTop','all');change('chartUnit','units');assert.match(d.getElementById('chartsContent').textContent,/311/,'Units mode sums raw quantities');
const unitsData=w.SalesCharts.aggregate(rep,'groups','',0,2,{unit:'units'});assert.equal(unitsData.total,311);assert.equal(unitsData.excluded,0,'Units mode does not require prices');
change('chartUnit','money');
// Подсказки столбцов содержат SKU и долю.
change('chartKind','groups');assert.match(d.querySelector('#chartsContent rect title').textContent,/SKU: \d/);assert.match(d.querySelector('#chartsContent rect title').textContent,/% от итога/);
// Топ-10 + «Прочие» на богатом наборе: 12 поставщиков → 10 + «Прочие (2)», итог сохраняется.
// Группы номерованы («1 Группа»…«12 Группа»), продажи идут вразрез номерам (у «2» максимум).
const wideItems=Array.from({length:12},(_,i)=>({excelRow:100+i,warehouse:'A',group:`${i+1} Группа`,supplier:`S${i+1}`,purchasePrice:10,monthlySales:[i===1?99:12-i,0,0],sku:String(100+i),name:'Т',salesSegment:3,sumSalesLast12M:30,closingStock:5,finalOrderQty:0}));
const wideRep={fileName:'wide.xlsx',items:wideItems,periods:[{year:2026,month:1,label:'Я'},{year:2026,month:2,label:'Ф'},{year:2026,month:3,label:'М'}],warehouses:[],groups:[],suppliers:[],params:{}};
w.SalesCharts.update(wideRep);change('chartKind','suppliers');change('chartTop','top10');
assert.match(d.getElementById('chartsContent').textContent,/Прочие \(2\)/);
assert.equal(d.querySelectorAll('#chartsContent svg g').length,11,'Топ-10 плюс «Прочие» = 11 строк');
const wideAgg=w.SalesCharts.aggregate(wideRep,'suppliers','',0,2);
const wideTotal=wideAgg.rows.reduce((s,r)=>s+r.total,0);
assert.match(d.getElementById('chartsContent').textContent,new RegExp(wideTotal.toLocaleString('ru-RU',{minimumFractionDigits:2}).replace(/\u00a0/g,'[\\u00a0 ]').replace('.',',')),'«Прочие» keeps the grand total');
change('chartTop','all');
// Динамика по группам: до 15 групп рисуются целиком (12 ≤ 15), без «Прочие».
change('chartKind','monthlyGroups');
assert.equal(d.querySelectorAll('#chartsContent path').length,12,'All 12 groups fit the top-15 limit');
assert.equal(d.querySelectorAll('#chartGroupList input[data-cgp-group]').length,12,'Picker lists all 12 groups');
// Перечень отсортирован по номеру и алфавиту, а не по продажам; у каждой строки свой стабильный цвет.
const pickerNames=[...d.querySelectorAll('#chartGroupList .cgp-name')].map(e=>e.textContent);
assert.deepEqual(pickerNames.slice(0,3),['1 Группа','2 Группа','3 Группа'],'Picker is sorted by group number, not by sales');
assert.equal(d.querySelectorAll('#chartGroupList .cgp-dot').length,12,'Every picker row shows its group color');
const strokes=[...new Set([...d.querySelectorAll('#chartsContent path')].map(p=>p.getAttribute('stroke')))];
assert.equal(strokes.length,12,'Each numbered group keeps its own stable color');
// Возврат к основной фикстуре.
w.SalesCharts.update(rep);change('chartKind','groups');
w.SalesCharts.update(null);assert.match(d.getElementById('chartsContent').textContent,/Загрузите ведомость/);
w.scrollTo=()=>{};w.setInterval=()=>1;
w.fetch=async path=>({ok:true,json:async()=>path==='api/properties'?{properties:{}}:{report:rep}});
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
(async()=>{try{
 await new Promise(r=>setTimeout(r,80));
 d.querySelector('[data-tab="charts"]').click();
 assert.ok(d.getElementById('view-charts').classList.contains('active'));
 assert.ok(!d.getElementById('view-table').classList.contains('active'));
 assert.ok(d.querySelector('#chartsContent svg'),'Charts include rows hidden by ordinary default table filters');
 // Поповер рейтинга: вертикальная линия на каждый месяц; в один год полос нет, подпись года по центру.
 d.querySelector('[data-tab="table"]').click();
 await new Promise(r=>setTimeout(r,120));
 const rcpPill=d.querySelector('[data-rating-row="8"]');
 rcpPill.getBoundingClientRect=()=>({left:300,right:320,top:400,bottom:420,width:20,height:20});
 rcpPill.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));
 const rcp=d.getElementById('ratingChartPopover');
 assert.ok(!rcp.classList.contains('hidden'),'Rating chart popover opens');
 assert.equal(rcp.querySelectorAll('.rcp-mline').length,3,'A vertical line for every month');
 assert.match(rcp.textContent,/2026/,'Year label is rendered');
 assert.equal(rcp.querySelector('.rcp-yband'),null,'Single year renders no alternating band');
 d.dispatchEvent(new w.Event('scroll'));
 assert.ok(rcp.classList.contains('hidden'),'Scroll hides the popover');
 const css=fs.readFileSync('internal/server/web/styles.css','utf8');
 assert.match(css,/\.charts-controls \{[^}]*position:sticky/,'Chart kind bar must stay pinned while scrolling');
 console.log('Five sales charts, prices, periods, warehouses, shares, empty states and read-only integration passed');
}finally{w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
