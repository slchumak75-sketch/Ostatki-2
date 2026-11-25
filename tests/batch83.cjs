const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
// Б83: установка через Setup (NSIS в CI), кнопка «Обновление» на плашке
// рядом с «Сохранить поля» (обновление по присланному EXE) и поле
// «Комментарий» в окне отправки заказа по почте.
const wf=fs.readFileSync('.github/workflows/build.yml','utf8');
assert.ok(wf.includes('makensis')&&wf.includes('_Setup.exe'),'Б83: CI собирает установщик Setup и кладёт в релиз');
const nsi=fs.readFileSync('installer/ostatki.nsi','utf8');
assert.ok(nsi.includes('$LOCALAPPDATA\\Programs\\Ostatki2'),'Б83: установка в профиль пользователя, без администратора');
assert.ok(nsi.includes('/oname=OstatkiZakupki.exe')&&nsi.includes('Uninstall.exe')&&nsi.includes('Остатки 2.lnk'),'Б83: программа, деинсталлятор и ярлыки');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар один',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4,manualOverride:null}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[{warehouse:'Мир',totalItems:1,zeroStockItems:1,overstockItems:0,overstockCost:0}],suppliers:[{supplier:'Поставщик',warehouse:'Мир',totalItems:1,orderItems:1,totalOrderQty:4,totalOrderCost:8}],groups:[]};
const pickedPath='C:\\Загрузки\\OstatkiZakupki_Variant_7.27.exe';
w.fetch=async(path,options={})=>{
 const body=options.body?JSON.parse(options.body):null;
 calls.push({path,body});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path.startsWith('api/supplier-emails'))return {ok:true,json:async()=>({emails:['a@sup.ru'],last:'a@sup.ru'})};
 if(path==='api/orders/send-mail')return {ok:true,json:async()=>({sent:true,to:body.to,fileName:'Заказ.xlsx'})};
 if(path==='api/settings/pick-file')return {ok:true,json:async()=>({path:pickedPath,cancelled:false})};
 if(path==='api/update/apply')return {ok:true,json:async()=>({updating:true,mode:'replace'})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=(ms=60)=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{
 await tick();
 // Кнопка «Обновление» — на той же плашке, сразу после «Сохранить поля».
 assert.equal(d.getElementById('btnSaveFields').nextElementSibling.id,'btnUpdateApp','Б83: «Обновление» рядом с «Сохранить поля»');
 // Почта: комментарий уходит в письме и очищается при следующем открытии.
 d.querySelector('[data-sup-row-check]').click();await tick();
 d.querySelector('[data-mail-sup]').click();await tick();
 assert.ok(d.getElementById('mailComment'),'Б83: поле «Комментарий» есть в окне отправки');
 d.getElementById('mailComment').value='Прошу подтвердить сроки поставки';
 d.getElementById('btnMailSendOk').click();await tick();
 const sendPost=calls.find(c=>c.path==='api/orders/send-mail');
 assert.equal(sendPost.body.comment,'Прошу подтвердить сроки поставки','Б83: комментарий отправлен на сервер');
 d.querySelector('[data-mail-sup]').click();await tick();
 assert.equal(d.getElementById('mailComment').value,'','Б83: комментарий не повторяется в следующем письме');
 d.getElementById('btnMailSendCancel').click();await tick();
 // Обновление: выбор файла → подтверждение → применение.
 d.getElementById('btnUpdateApp').click();await tick();
 assert.ok(!d.getElementById('safetyDialog').classList.contains('hidden'),'Б83: подтверждение обновления показано');
 assert.match(d.getElementById('safetyDialogText').textContent,/OstatkiZakupki_Variant_7\.27\.exe/,'Б83: в подтверждении — выбранный файл');
 d.getElementById('safetyDialogYes').click();await tick(120);
 const applyPost=calls.find(c=>c.path==='api/update/apply');
 assert.ok(applyPost,'Б83: обновление применено');
 assert.equal(applyPost.body.path,pickedPath,'Б83: на сервер ушёл выбранный файл');
 assert.match(d.getElementById('toast').textContent,/Обновление принято/,'Б83: пользователю сказано о перезапуске');
 console.log('BATCH-83: setup wiring, «Обновление» button flow, mail comment: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
