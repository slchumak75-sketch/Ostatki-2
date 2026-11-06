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
assert.equal(d.querySelector('[data-tab="charts"]').nextElementSibling.dataset.tab,'analytics');
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
assert.equal(d.querySelectorAll('#chartsContent .qsum').length,1,'Quarter sum shown above the chart');
assert.match(d.querySelector('#chartsContent .qsum').textContent,/130,00 руб\./,'Quarter sum uses the current unit');
assert.match(d.getElementById('chartsContent').textContent,/сумма за квартал/,'Quarterly note is shown');
d.getElementById('chartSumMode').checked=false;d.getElementById('chartSumMode').dispatchEvent(new w.Event('change'));
assert.match(d.querySelector('#chartsContent circle title').textContent,/1 кв\. 2026 — Группа <1>: 120,00/,'Per-group quarterly sum in money');
d.getElementById('chartQuarterBands').checked=false;d.getElementById('chartQuarterBands').dispatchEvent(new w.Event('change'));
d.getElementById('chartGroupReset').click();
assert.equal(d.querySelectorAll('#chartsContent path').length,2,'Back to monthly per-group curves');
// Аналитика тенденций — отдельная вкладка справа от «Графики»; таблица всегда в рублях.
const tabsBar=[...d.querySelectorAll('.tab-btn')].map(b=>b.dataset.tab);
assert.deepEqual(tabsBar,['table','suppliers','charts','analytics'],'Tab row: ведомость, заказ, графики, аналитика');
const anTab=d.querySelector('.tab-btn[data-tab="analytics"]');
assert.equal(anTab.previousElementSibling.dataset.tab,'charts','Analytics tab sits right after Charts');
assert.ok(!d.querySelector('.tab-btn[data-tab="overstock"]'),'Overstock tab removed from the row');
const ovBtn=d.getElementById('btnOverstockTab');
assert.ok(ovBtn&&ovBtn.textContent.includes('Неликвиды')&&d.getElementById('btnConfigurePanel').parentElement===ovBtn.parentElement,'Overstock button lives next to Configure');
assert.ok(ovBtn.querySelector('#cntTabOverstock'),'Overstock counter moved onto the button');
assert.equal(d.getElementById('btnAnalytics'),null,'Standalone analytics button removed');
assert.ok(d.getElementById('view-analytics')&&d.getElementById('analyticsContent'),'Analytics view container exists');
// Таблица тенденций ушла с вкладки графиков; на вкладке аналитики — честное сообщение при одном годе.
assert.equal(d.querySelector('#chartsContent .chart-trends'),null,'Charts tab no longer hosts the trends table');
w.SalesCharts.renderAnalytics();
assert.match(d.querySelector('#analyticsContent .chart-trends').textContent,/не менее четырёх полных кварталов \(сейчас: 1: 1 кв\. 2026\)/,'Period with one full quarter explains itself');
// Полные два года: окно = 1–4 кв. 2026; пары квартал-к-кварталу по годам + «Год».
const yItems=[
 {excelRow:400,warehouse:'A',group:'Y Группа',supplier:'SY',purchasePrice:10,monthlySales:[10,0,0,10,0,0,5,0,0,5,0,0,10,0,0,20,0,0,10,0,0,20,0,0],sku:'400',name:'Т',salesSegment:3,sumSalesLast12M:60,closingStock:1,finalOrderQty:0},
 {excelRow:401,warehouse:'A',group:'Z Группа',supplier:'SZ',purchasePrice:1,monthlySales:[5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5],sku:'401',name:'Т',salesSegment:2,sumSalesLast12M:120,closingStock:1,finalOrderQty:0},
];
const yPeriods=[
 ...['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'].map((m,i)=>({year:2025,month:i+1,label:`${m} 25`})),
 ...['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'].map((m,i)=>({year:2026,month:i+1,label:`${m} 26`}))
];
const yRep={fileName:'yoy.xlsx',items:yItems,periods:yPeriods,warehouses:[],groups:[],suppliers:[],params:{}};
w.SalesCharts.update(yRep);
change('chartKind','monthlyGroups');
w.SalesCharts.renderAnalytics();
assert.deepEqual([...d.getElementById('analyticsWarehouse').options].map(o=>o.value),['','A'],'Analytics selector picks up warehouses from the report');
const yTrends=d.querySelector('#analyticsContent .chart-trends');
const headRows=yTrends.querySelectorAll('thead tr');
assert.deepEqual([...headRows[0].querySelectorAll('th')].map(e=>e.textContent),['Группа','Тенденция','1 кв. 2026','2 кв. 2026','3 кв. 2026','4 кв. 2026','Год'],'Top header: group, trend, four quarters, year');
assert.deepEqual([...headRows[1].querySelectorAll('th')].map(e=>e.textContent),['%','руб.','%','руб.','%','руб.','%','руб.','%','руб.'],'Sub header: percent and rubles per block');
const yRow=[...yTrends.querySelectorAll('tbody tr')].find(tr=>tr.textContent.includes('Y Группа'));
assert.ok(yRow,'Every data group gets its own row');
assert.equal(yRow.querySelectorAll('td').length,12,'Row: group, trend badge, four quarter pairs, year pair');
assert.match(yRow.querySelector('.ct-badge').textContent,/рост/,'Trend badge: year window doubled');
const yCells=[...yRow.querySelectorAll('td')].map(e=>e.textContent.trim());
assert.equal(yCells[2],'0,00','Q1 pair percent without the percent sign');
assert.equal(yCells[3],'0,00','Q1 pair amount without the currency word');
assert.equal(yCells[4],'+100,00','Q2 pair percent');
assert.equal(yCells[5],'+100,00','Q2 pair amount');
assert.equal(yCells[6],'+100,00','Q3 pair percent');
assert.equal(yCells[7],'+50,00','Q3 pair amount');
assert.equal(yCells[8],'+300,00','Q4 pair percent');
assert.equal(yCells[9],'+150,00','Q4 pair amount');
assert.equal(yCells[10],'+100,00','Year percent');
assert.equal(yCells[11],'+300,00','Year amount');
assert.match(yRow.querySelector('.ct-badge').getAttribute('title'),/600,00 против 300,00 руб\. годом ранее \(\+100,00%\)/,'Badge tooltip keeps the full comparison');
const zRow=[...yTrends.querySelectorAll('tbody tr')].find(tr=>tr.textContent.includes('Z Группа'));
assert.match(zRow.querySelector('.ct-badge').textContent,/стабильно/,'Flat group keeps its badge');
const footCells=[...yTrends.querySelectorAll('tfoot td')].map(e=>e.textContent.trim());
assert.equal(footCells[0],'Итог','Footer row is labelled Итог');
assert.deepEqual(footCells.slice(2),['—','0,00','—','+100,00','—','+50,00','—','+150,00','—','+300,00'],'Footer sums the signed amounts per column');
assert.match(yTrends.textContent,/Порог тенденции ±5%/,'Threshold is five percent');
assert.ok(!yTrends.textContent.includes('неравномерн'),'Unevenness flag is not published');
// Единицы графика не влияют на аналитику: всегда рубли.
change('chartUnit','units');
w.SalesCharts.renderAnalytics();
const uHead=d.querySelector('#analyticsContent .chart-trends thead').textContent;
assert.match(uHead,/руб\./,'Analytics header keeps rubles');
assert.ok(!uHead.includes('шт.'),'Units mode does not leak into analytics');
const uCells=[...d.querySelector('#analyticsContent .chart-trends tbody tr').querySelectorAll('td')].map(e=>e.textContent.trim());
assert.equal(uCells[3],'0,00','Amounts stay in rubles under units mode');
change('chartUnit','money');
// Таблица считается по всем группам: группа, скрытая выбором другой, остаётся в тенденциях.
const yBox=[...d.querySelectorAll('#chartGroupList input[data-cgp-group]')].find(c=>c.dataset.cgpGroup==='Y Группа');
yBox.checked=true;yBox.dispatchEvent(new w.Event('change',{bubbles:true}));
assert.ok(!d.querySelector('#chartsContent .sales-chart').textContent.includes('Z Группа'),'Group is hidden from the chart');
w.SalesCharts.renderAnalytics();
const tHidden=d.querySelector('#analyticsContent .chart-trends');
assert.ok([...tHidden.querySelectorAll('tbody tr')].some(tr=>tr.textContent.includes('Z Группа')),'Hidden group is still analysed in the table');
assert.match(tHidden.textContent,/Итог по 2 группам/,'Counters cover all groups, not only shown');
// Порядок групп — по номерам, затем по алфавиту; селектор склада фильтрует таблицу.
const soItems=[
 {excelRow:600,warehouse:'A',group:'10 Группа',supplier:'S10',purchasePrice:1,monthlySales:[5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5],sku:'600',name:'Т',salesSegment:3,sumSalesLast12M:120,closingStock:1,finalOrderQty:0},
 {excelRow:601,warehouse:'B',group:'2 Группа',supplier:'S2',purchasePrice:2,monthlySales:[5,5,5,5,5,5,5,5,5,5,5,5,10,10,10,10,10,10,10,10,10,10,10,10],sku:'601',name:'Т',salesSegment:3,sumSalesLast12M:180,closingStock:1,finalOrderQty:0},
];
const soRep={fileName:'so.xlsx',items:soItems,periods:yPeriods,warehouses:[],groups:[],suppliers:[],params:{}};
w.SalesCharts.update(soRep);change('chartKind','monthlyGroups');
w.SalesCharts.renderAnalytics();
const soWh=d.getElementById('analyticsWarehouse');
assert.deepEqual([...soWh.options].map(o=>o.value),['','A','B'],'Analytics warehouse selector lists report warehouses');
const soTable=d.querySelector('#analyticsContent .chart-trends');
const soOrder=[...soTable.querySelectorAll('tbody tr')].map(tr=>tr.querySelector('td').textContent.trim());
assert.deepEqual(soOrder,['2 Группа','10 Группа'],'Groups ordered by number, not lexicographically');
const soFoot=[...soTable.querySelectorAll('tfoot td')].map(e=>e.textContent.trim());
assert.deepEqual(soFoot.slice(2),['—','+30,00','—','+30,00','—','+30,00','—','+30,00','—','+120,00'],'Footer totals across both warehouses');
soWh.value='A';soWh.dispatchEvent(new w.Event('change'));
const aTable=d.querySelector('#analyticsContent .chart-trends');
assert.deepEqual([...aTable.querySelectorAll('tbody tr')].map(tr=>tr.querySelector('td').textContent.trim()),['10 Группа'],'Warehouse filter limits the rows');
const aCells=[...aTable.querySelector('tbody tr').querySelectorAll('td')].map(e=>e.textContent.trim());
assert.equal(aCells[11],'0,00','Filtered group keeps its own numbers');
soWh.value='';soWh.dispatchEvent(new w.Event('change'));
assert.equal([...d.querySelector('#analyticsContent .chart-trends').querySelectorAll('tbody tr')].length,2,'Clearing the selector restores all groups');
// Выбор поставщика — слева от склада; фильтрует таблицу, работает вместе со складом.
const anLabels=[...d.querySelectorAll('#view-analytics .charts-controls label')].map(l=>l.firstChild.textContent.trim());
assert.deepEqual(anLabels,['Поставщик','Склад'],'Supplier selector sits left of warehouse');
const soSup=d.getElementById('analyticsSupplier');
assert.deepEqual([...soSup.options].map(o=>o.value),['','S2','S10'],'Analytics supplier selector lists report suppliers');
soSup.value='S10';soSup.dispatchEvent(new w.Event('change'));
assert.deepEqual([...d.querySelector('#analyticsContent .chart-trends').querySelectorAll('tbody tr')].map(tr=>tr.querySelector('td').textContent.trim()),['10 Группа'],'Supplier filter limits the rows');
soSup.value='S2';soSup.dispatchEvent(new w.Event('change'));
soWh.value='A';soWh.dispatchEvent(new w.Event('change'));
assert.equal([...d.querySelector('#analyticsContent .chart-trends').querySelectorAll('tbody tr')].length,0,'Supplier and warehouse filters combine');
soSup.value='';soWh.value='';soWh.dispatchEvent(new w.Event('change'));soSup.dispatchEvent(new w.Event('change'));
// Номер не в начале имени: «Группа 2» раньше «Группа 10»; естественный порядок и в перечне.
const natItems=[
 {excelRow:700,warehouse:'A',group:'Группа 10',supplier:'N1',purchasePrice:1,monthlySales:[5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5],sku:'700',name:'Т',salesSegment:3,sumSalesLast12M:120,closingStock:1,finalOrderQty:0},
 {excelRow:701,warehouse:'A',group:'Группа 2',supplier:'N2',purchasePrice:1,monthlySales:[5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5],sku:'701',name:'Т',salesSegment:3,sumSalesLast12M:120,closingStock:1,finalOrderQty:0},
 {excelRow:702,warehouse:'A',group:'1 Группа',supplier:'N3',purchasePrice:1,monthlySales:[5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5],sku:'702',name:'Т',salesSegment:3,sumSalesLast12M:120,closingStock:1,finalOrderQty:0},
];
const natRep={fileName:'nat.xlsx',items:natItems,periods:yPeriods,warehouses:[],groups:[],suppliers:[],params:{}};
w.SalesCharts.update(natRep);change('chartKind','monthlyGroups');
w.SalesCharts.renderAnalytics();
const natOrder=[...d.querySelectorAll('#analyticsContent .chart-trends tbody tr')].map(tr=>tr.querySelector('td').textContent.trim());
assert.deepEqual(natOrder,['1 Группа','Группа 2','Группа 10'],'Trailing numbers sort naturally in analytics');
assert.deepEqual([...d.querySelectorAll('#chartGroupList .cgp-name')].map(e=>e.textContent),['1 Группа','Группа 2','Группа 10'],'Picker shares the natural order');
// Полуторагодовой набор: у окна 3 кв. 2025 — 2 кв. 2026 пары прошлого года есть только у 1 и 2 кв. 2026.
const hItems=[{excelRow:410,warehouse:'A',group:'H Группа',supplier:'SH',purchasePrice:10,monthlySales:[10,0,0,10,0,0,5,0,0,5,0,0,10,0,0,20,0,0],sku:'410',name:'Т',salesSegment:3,sumSalesLast12M:40,closingStock:1,finalOrderQty:0}];
const hPeriods=[
 ...['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'].map((m,i)=>({year:2025,month:i+1,label:`${m} 25`})),
 ...['Янв','Фев','Мар','Апр','Май','Июн'].map((m,i)=>({year:2026,month:i+1,label:`${m} 26`}))
];
const hRep={fileName:'half.xlsx',items:hItems,periods:hPeriods,warehouses:[],groups:[],suppliers:[],params:{}};
w.SalesCharts.update(hRep);change('chartKind','monthlyGroups');
w.SalesCharts.renderAnalytics();
const hRow=[...d.querySelector('#analyticsContent .chart-trends').querySelectorAll('tbody tr')].find(tr=>tr.textContent.includes('H Группа'));
const hCells=[...hRow.querySelectorAll('td')].map(e=>e.textContent.trim());
assert.equal(hCells[2],'—','Q3 2025 has no year-earlier pair');
assert.equal(hCells[3],'—','Q3 2025 amount stays empty');
assert.equal(hCells[4],'—','Q4 2025 has no year-earlier pair either');
assert.equal(hCells[5],'—','Q4 2025 amount stays empty');
assert.equal(hCells[6],'0,00','Q1 2026 vs Q1 2025: percent');
assert.equal(hCells[7],'0,00','Q1 2026 vs Q1 2025: amount');
assert.equal(hCells[8],'+100,00','Q2 2026 vs Q2 2025: percent');
assert.equal(hCells[9],'+100,00','Q2 2026 vs Q2 2025: amount');
assert.equal(hCells[10],'+100,00','Year percent uses the pairs that exist');
assert.equal(hCells[11],'+200,00','Year amount uses the pairs that exist');
const hFoot=[...d.querySelectorAll('#analyticsContent .chart-trends tfoot td')].map(e=>e.textContent.trim());
assert.deepEqual(hFoot.slice(2),['—','—','—','—','—','0,00','—','+100,00','—','+200,00'],'Footer skips quarters without pairs');
assert.match(d.querySelector('#analyticsContent .chart-trends').textContent,/3 кв\. 2025 — 2 кв\. 2026/,'Half window is named');
// Полных кварталов четыре, но перед окном нет полного одноимённого квартала — честное сообщение.
const p2Items=[{excelRow:500,warehouse:'A',group:'P Группа',supplier:'SP',purchasePrice:10,monthlySales:[0,10,0,10,0,0,5,0,0,5,0,0,10,0,0],sku:'500',name:'Т',salesSegment:3,sumSalesLast12M:40,closingStock:1,finalOrderQty:0}];
const p2Periods=[
 ...['Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'].map((m,i)=>({year:2025,month:i+2,label:`${m} 25`})),
 ...['Янв','Фев','Мар'].map((m,i)=>({year:2026,month:i+1,label:`${m} 26`}))
];
const p2Rep={fileName:'p2.xlsx',items:p2Items,periods:p2Periods,warehouses:[],groups:[],suppliers:[],params:{}};
w.SalesCharts.update(p2Rep);change('chartKind','monthlyGroups');
w.SalesCharts.renderAnalytics();
assert.match(d.querySelector('#analyticsContent .chart-trends').textContent,/Для сравнения нужен 1 кв\. 2025 — одноимённый квартал перед окном \(2 кв\. 2025 — 1 кв\. 2026\)\./,'Missing year-earlier quarter explains itself');
// Оформление: закреплённая шапка, вертикальные линии, группа в одну строку, числа справа, узкие столбцы.
const css=fs.readFileSync('internal/server/web/styles.css','utf8');
assert.match(css,/\.chart-trends-table thead tr:nth-child\(2\) th \{ position: sticky; top: 28px/,'Second header row is pinned below the first');
assert.match(css,/\.ct-scroll \{ overflow: auto; max-height: 60vh; \}/,'Table scrolls inside a capped container');
assert.match(css,/border-left: 1px solid var\(--border\); padding: 3px 5px; \}/,'Vertical rules and narrow cells');
assert.match(css,/\.chart-trends-table td:first-child \{ white-space: nowrap; \}/,'Group column stays on one line');
assert.match(css,/\.chart-trends-table td:nth-child\(2\), \.chart-trends-table thead tr:first-child th:nth-child\(2\) \{ text-align: right; \}/,'Trend column is right-aligned');
assert.match(css,/\.chart-trends-table\.data-table \{ table-layout: auto; \}/,'Trends table uses automatic column widths');
assert.match(css,/\.chart-trends-table\.data-table td, \.chart-trends-table\.data-table tfoot td \{ text-align: right; \}/,'All data cells align right over .data-table defaults');
assert.match(css,/\.chart-trends-table\.data-table td:first-child \{ text-align: left; white-space: nowrap; min-width: max-content; \}/,'Group column keeps the full name on one line');
assert.match(css,/\.chart-trends-table\.data-table tbody td:nth-child\(3\), [^}]*\{ background-color: #f0f7ff; \}/,'Tint A covers quarter pairs 1/3 and the year block');
assert.match(css,/\.chart-trends-table\.data-table tbody td:nth-child\(5\), [^}]*\{ background-color: #fff8ee; \}/,'Tint B covers quarter pairs 2/4');
assert.match(css,/\.chart-trends-table\.data-table thead tr:nth-child\(1\) th:nth-child\(4\) \{ background-color: #fff8ee; \}/,'Quarter headers alternate tints');
// Возврат к основной фикстуре.
w.SalesCharts.update(rep);
change('chartKind','groups');
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
assert.equal(d.querySelectorAll('#chartGroupList .cgp-total').length,0,'No per-row sums in the picker');
assert.ok(!fs.readFileSync('internal/server/web/styles.css','utf8').match(/\.cgp-list[^}]*grid-template-columns/),'Picker uses vertical column flow');
const dots8=[...d.querySelectorAll('#chartGroupList .cgp-item')].map(e=>e.querySelector('.cgp-name').textContent);
assert.ok(dots8[0].startsWith('1 ')&&dots8[7].startsWith('8 '),'First column flows top-to-bottom by number');
const strokes=[...new Set([...d.querySelectorAll('#chartsContent path')].map(p=>p.getAttribute('stroke')))];
assert.equal(strokes.length,12,'Each numbered group keeps its own stable color');
// Тенденции на одногодичном богатом наборе: пояснение о необходимости полных кварталов.
w.SalesCharts.renderAnalytics();
assert.match(d.querySelector('#analyticsContent .chart-trends').textContent,/не менее четырёх полных кварталов \(сейчас: 1: 1 кв\. 2026\)/,'Wide single-quarter set explains itself');
// Неравномерность: максимум превышает минимум ненулевых месяцев более чем втрое (два года).
const unItems=[{excelRow:300,warehouse:'A',group:'U Группа',supplier:'SU',purchasePrice:10,monthlySales:[30,1,1,1,1,1,1,1],sku:'300',name:'Т',salesSegment:3,sumSalesLast12M:37,closingStock:1,finalOrderQty:0}];
const unPeriods=[{year:2025,month:1,label:'Я 25'},{year:2025,month:2,label:'Ф 25'},{year:2025,month:3,label:'М 25'},{year:2025,month:4,label:'А 25'},{year:2026,month:1,label:'Я 26'},{year:2026,month:2,label:'Ф 26'},{year:2026,month:3,label:'М 26'},{year:2026,month:4,label:'А 26'}];
const unRep={fileName:'u.xlsx',items:unItems,periods:unPeriods,warehouses:[],groups:[],suppliers:[],params:{}};
w.SalesCharts.update(unRep);change('chartKind','monthlyGroups');
// Флаг «продажи неравномерные» больше не публикуется в таблице тенденций.
w.SalesCharts.renderAnalytics();
assert.ok(!d.querySelector('#analyticsContent .chart-trends').textContent.includes('неравномерн'),'Unevenness flag is not published');
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
