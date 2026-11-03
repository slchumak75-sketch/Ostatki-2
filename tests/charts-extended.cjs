// Расширенные графики: сезонность (среднее по годам), покрытие запаса (границы),
// структура бюджета, неликвиды, рейтинг, Топ-10 + «Прочие», единицы «шт.».
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document;
w.eval(fs.readFileSync('internal/server/web/charts.js','utf8'));
const periods=[{year:2025,month:1,label:'Янв 25'},{year:2025,month:2,label:'Фев 25'},{year:2025,month:3,label:'Мар 25'},{year:2026,month:1,label:'Янв 26'},{year:2026,month:2,label:'Фев 26'},{year:2026,month:3,label:'Мар 26'}];
const mk=(row,over={})=>({excelRow:row,warehouse:over.wh||(row%2?'A':'B'),group:over.group||`G${row}`,supplier:over.sup||`S${row}`,purchasePrice:over.price??10,monthlySales:over.sales||[10,10,10,10,10,10],sku:String(row),name:`Товар ${row}`,salesSegment:over.seg??3,sumSalesLast12M:over.s12??60,closingStock:over.stock??10,finalOrderQty:over.order??0,overstockValue:over.over??0});
const items=[
 ...Array.from({length:12},(_,i)=>mk(100+i,{sup:`S${i+1}`,group:`G${i+1}`})),
 mk(200,{sup:'S1',group:'G1',sales:[0,0,0,0,0,0],stock:5,seg:0,s12:0}),           // Нет продаж, остаток есть
 mk(201,{sup:'S2',group:'G2',stock:30,seg:1,s12:60}),                              // cover 3 → 3–6 мес
 mk(202,{sup:'S3',group:'G3',stock:120,seg:5,s12:60}),                             // cover 12 → > 12 мес
 mk(203,{sup:'S4',group:'G4',stock:5,seg:2,s12:60}),                               // cover 0.5 → < 1 мес
 mk(204,{sup:'S1',group:'G1',order:2,over:100}),                                   // бюджет: заказ 20; неликвид 100
 mk(205,{sup:'S2',group:'G2',over:50}),                                            // неликвид 50
];
const rep={fileName:'ext.xlsx',items,periods,warehouses:[],groups:[],suppliers:[],params:{}};
const before=JSON.stringify(rep);
w.SalesCharts.update(rep);
const change=(id,value)=>{d.getElementById(id).value=value;d.getElementById('chartKind').dispatchEvent(new w.Event('change'));};
const text=()=>d.getElementById('chartsContent').textContent;
(async()=>{try{
 // Сезонность: равные средние по календарным месяцам (продажи постоянны), два года усреднены.
 const season=w.SalesCharts.aggregate(rep,'seasonality','',0,5);
 assert.equal(season.rows.length,3);assert.ok(Math.abs(season.rows[0].total-season.rows[1].total)<1e-6);assert.ok(Math.abs(season.rows[0].total-season.rows[2].total)<1e-6);
 change('chartKind','seasonality');assert.match(text(),/Январь/);assert.match(text(),/Декабрь|Марта?/);
 // Покрытие запаса: границы бакетов по остатку/средним продажам.
 change('chartKind','stockCover');
 assert.match(text(),/Нет продаж/);assert.match(text(),/< 1 мес/);assert.match(text(),/3–6 мес/);assert.match(text(),/> 12 мес/);
 const totalSkus=(text().match(/(\d+)\s*SKU/g)||[]).length;
 assert.ok(totalSkus>0);
 // Структура бюджета: заказ по поставщикам (20 = 2 шт × 10) и остатки (итого 2 800).
 change('chartKind','budgetStructure');
 assert.match(text(),/Заказ по поставщикам/);assert.match(text(),/20,00/);assert.match(text(),/Остатки по складам/);
 assert.match(text(),/1\u00a0950,00/,'Warehouse B stock value');assert.match(text(),/1\u00a0050,00/,'Warehouse A stock value');
 // Неликвиды: 100 + 50 по группам G1/G2.
 change('chartKind','nonliquid');
 assert.match(text(),/100,00/);assert.match(text(),/50,00/);
 // Рейтинг: сегменты и «Без продаж».
 change('chartKind','ratings');
 assert.match(text(),/Без продаж/);assert.match(text(),/Сегмент 5\+/);
 const ratings=w.SalesCharts.update; // no-op
 // Топ-10 + «Прочие»: 12 поставщиков → 10 + «Прочие (2)».
 change('chartKind','suppliers');change('chartTop','top10');
 assert.match(text(),/Прочие \(2\)/);
 assert.equal(d.querySelectorAll('#chartsContent svg g').length,11,'Топ-10 плюс «Прочие» = 11 строк');
 const head=w.SalesCharts.aggregate(rep,'suppliers','',0,5).rows;
 const expected=head.slice(0,10).reduce((s,r)=>s+r.total,0)+head.slice(10).reduce((s,r)=>s+r.total,0);
 assert.match(text(),new RegExp(expected.toLocaleString('ru-RU',{minimumFractionDigits:2}).replace(/\u00a0/g,'[\\u00a0 ]').replace('.',',')),'«Прочие» сохраняет общий итог');
 change('chartTop','all');
 assert.ok(!text().includes('Прочие ('));
 // Единицы «шт.»: те же данные в штуках.
 change('chartUnit','units');
 assert.match(text(),/шт\./);
 const units=w.SalesCharts.aggregate(rep,'suppliers','',0,5,{unit:'units'});
 assert.equal(units.excluded,0);assert.ok(units.total>0);
 change('chartUnit','money');
 assert.equal(JSON.stringify(rep),before,'Charts never mutate the report');
 console.log('Extended charts: seasonality, coverage, budget, non-liquid, ratings, top-10+other, units passed');
 process.exit(0);
}catch(err){console.error('FAIL:',err.message);console.error(text().slice(0,400));process.exit(1);}})();
