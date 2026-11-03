const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
for(const id of ['tableScrollContainer','overstockContainer','chartsContent']) assert.ok(d.getElementById(id).classList.contains('statement-surface'),'Statement and analysis tabs share a surface style');
for(const selector of ['#overstockToolbar','.charts-controls']) assert.ok(d.querySelector(selector).classList.contains('analysis-controls'));

w.eval(fs.readFileSync('internal/server/web/charts.js','utf8'));
const periods=[1,2,3].map(month=>({year:2026,month,label:`Месяц ${month}`}));
const item=(row,wh,group,sup,price,sales)=>({excelRow:row,warehouse:wh,group,supplier:sup,purchasePrice:price,monthlySales:sales,sku:String(row),name:'Товар',salesSegment:0,sumSalesLast12M:0,closingStock:1,finalOrderQty:0});
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
// Динамика по группам: гладкие кривые (по одной на группу) с точками-маркерами.
change('chartKind','monthlyGroups');
assert.equal(d.querySelectorAll('#chartsContent path').length,2,'One smooth curve per product group');
assert.ok(d.querySelectorAll('#chartsContent circle').length>=6,'Marker dots on the curves');
assert.match(d.querySelector('#chartsContent path title').textContent,/Группа/);
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
const wideItems=Array.from({length:12},(_,i)=>({excelRow:100+i,warehouse:'A',group:`G${i+1}`,supplier:`S${i+1}`,purchasePrice:10,monthlySales:[10,10,10],sku:String(100+i),name:'Т',salesSegment:3,sumSalesLast12M:30,closingStock:5,finalOrderQty:0}));
const wideRep={fileName:'wide.xlsx',items:wideItems,periods:[{year:2026,month:1,label:'Я'},{year:2026,month:2,label:'Ф'},{year:2026,month:3,label:'М'}],warehouses:[],groups:[],suppliers:[],params:{}};
w.SalesCharts.update(wideRep);change('chartKind','suppliers');change('chartTop','top10');
assert.match(d.getElementById('chartsContent').textContent,/Прочие \(2\)/);
assert.equal(d.querySelectorAll('#chartsContent svg g').length,11,'Топ-10 плюс «Прочие» = 11 строк');
const wideAgg=w.SalesCharts.aggregate(wideRep,'suppliers','',0,2);
const wideTotal=wideAgg.rows.reduce((s,r)=>s+r.total,0);
assert.match(d.getElementById('chartsContent').textContent,new RegExp(wideTotal.toLocaleString('ru-RU',{minimumFractionDigits:2}).replace(/\u00a0/g,'[\\u00a0 ]').replace('.',',')),'«Прочие» keeps the grand total');
change('chartTop','all');
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
 const css=fs.readFileSync('internal/server/web/styles.css','utf8');
 assert.match(css,/\.charts-controls \{[^}]*position:sticky/,'Chart kind bar must stay pinned while scrolling');
 console.log('Five sales charts, prices, periods, warehouses, shares, empty states and read-only integration passed');
}finally{w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
