const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар один',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4,manualOverride:null}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[{warehouse:'Мир',totalItems:1,zeroStockItems:1,overstockItems:0,overstockCost:0}],suppliers:[{supplier:'Поставщик',warehouse:'Мир',totalItems:1,orderItems:1,totalOrderQty:4,totalOrderCost:8}],groups:[]};
w.fetch=async(path,options={})=>{
 const body=options.body?JSON.parse(options.body):null;
 calls.push({path,body});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path==='api/settings/paths'&&!options.method)return {ok:true,json:async()=>({workbookDir:'D:\\Ведомости',etalonDir:'D:\\Эталоны',workbookCustom:true,etalonCustom:false})};
 if(path==='api/settings/paths')return {ok:true,json:async()=>({saved:true})};
 if(path==='api/settings/mail'&&!options.method)return {ok:true,json:async()=>({host:'smtp.example.ru',port:465,username:'u@example.ru',from:'',useTLS:true,hasPassword:true,configured:true})};
 if(path==='api/settings/mail')return {ok:true,json:async()=>({saved:true})};
 if(path.startsWith('api/supplier-emails'))return {ok:true,json:async()=>({emails:['a@sup.ru','b@sup.ru'],last:'b@sup.ru'})};
 if(path==='api/orders/send-mail')return {ok:true,json:async()=>({sent:true,to:body.to,fileName:'Заказ, Поставщик.xlsx'})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 // Кнопки рядом с «Конфигурация».
 const cfg=d.getElementById('btnConfigurePanel');
 assert.equal(cfg.nextElementSibling.id,'btnSavePaths','Б70: «Указать путь сохранения» рядом с «Конфигурация»');
 assert.equal(cfg.nextElementSibling.nextElementSibling.id,'btnMailSettings','Б70: «Настройка почты» рядом с «Конфигурация»');
 // Пути сохранения: подставляются действующие, сохраняются обе папки.
 d.getElementById('btnSavePaths').click();await tick();
 assert.ok(!d.getElementById('savePathsModal').classList.contains('hidden'));
 assert.equal(d.getElementById('savePathWorkbook').value,'D:\\Ведомости','Б70: своя папка ведомостей подставлена');
 assert.equal(d.getElementById('savePathEtalon').value,'','Б70: стандартная папка эталона — пустое поле');
 assert.match(d.getElementById('savePathEtalonHint').textContent,/Эталоны/);
 d.getElementById('savePathEtalon').value='D:\\Эталоны2';
 d.getElementById('btnSavePathsOk').click();await tick();
 const pathsPost=calls.find(c=>c.path==='api/settings/paths'&&c.body);
 assert.deepEqual(pathsPost.body,{etalonDir:'D:\\Эталоны2',workbookDir:'D:\\Ведомости'},'Б70: обе папки ушли на сервер');
 assert.ok(d.getElementById('savePathsModal').classList.contains('hidden'));
 // Настройка почты: поля заполнены, пароль не подставляется.
 d.getElementById('btnMailSettings').click();await tick();
 assert.equal(d.getElementById('mailHost').value,'smtp.example.ru');
 assert.equal(d.getElementById('mailPort').value,'465');
 assert.equal(d.getElementById('mailPassword').value,'');
 assert.match(d.getElementById('mailPassword').placeholder,/сохранён/);
 d.getElementById('btnMailSettingsOk').click();await tick();
 const mailPost=calls.find(c=>c.path==='api/settings/mail'&&c.body);
 assert.equal(mailPost.body.host,'smtp.example.ru');assert.equal(mailPost.body.port,465);assert.equal(mailPost.body.useTLS,true);
 // Вкладка «Заказ»: крайне правый столбец «Почта».
 const headCells=[...d.querySelectorAll('#suppliersTable thead th')];
 assert.equal(headCells.at(-1).textContent.trim(),'Почта','Б70: «Почта» — крайне правый столбец');
 d.querySelector('[data-sup-row-check]').click();await tick(); // отметить поставщика — как в работе
 const mailBtn=d.querySelector('[data-mail-sup]');
 assert.ok(mailBtn,'Б70: кнопка «Почта» у готового поставщика');
 mailBtn.click();await tick();
 assert.ok(!d.getElementById('mailSendModal').classList.contains('hidden'),'Б70: подтверждение отправки открыто');
 assert.equal(d.getElementById('mailToInput').value,'b@sup.ru','Б70: подставлена почта последней отправки');
 assert.equal(d.querySelectorAll('#mailToSelect option').length,2,'Б70: выбор из нескольких адресов адресата');
 d.getElementById('btnMailSendOk').click();await tick();
 const sendPost=calls.find(c=>c.path==='api/orders/send-mail');
 assert.ok(sendPost,'Б70: отправка вызвана');
 assert.equal(sendPost.body.to,'b@sup.ru');assert.equal(sendPost.body.supplier,'Поставщик');assert.equal(sendPost.body.warehouse,'Мир');
 assert.ok(d.getElementById('mailSendModal').classList.contains('hidden'));
 assert.match(d.getElementById('toast').textContent,/отправлен по почте/);
 // Выход: вопрос про эталон, эталон — только вручную.
 assert.equal(d.getElementById('closeConfirmTitle').textContent,'Сохранить эталон?');
 assert.equal(d.getElementById('btnCloseSaveYes').textContent,'Сохранить эталон');
 assert.equal(d.getElementById('btnCloseSaveNo').textContent,'Не сохранять');
 console.log('BATCH-70 UI: paths/mail settings, «Почта» column + send, exit etalon prompt: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
