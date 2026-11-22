const {JSDOM}=require('jsdom');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dom=new JSDOM(fs.readFileSync('internal/server/web/index.html','utf8'),{url:'http://app.test',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
w.scrollTo=()=>{};w.setInterval=()=>1;
const items=[{excelRow:8,sku:'001',name:'Товар',warehouse:'Мир',group:'Группа',supplier:'Поставщик',closingStock:0,sumSalesLast12M:5,salesSegment:3,purchasePrice:2,monthlySales:[],autoOrderQty:4,finalOrderQty:4}];
const report={fileName:'Т.xlsx',items,params:{},periods:[],warehouses:[{warehouse:'Мир',totalItems:1,zeroStockItems:1,overstockItems:0,overstockCost:0}],suppliers:[{supplier:'Поставщик',warehouse:'Мир',totalItems:1,orderItems:1,totalOrderQty:4,totalOrderCost:8}],groups:[]};
let savedEmails=['a@sup.ru','b@sup.ru'],savedLast='b@sup.ru';
w.fetch=async(path,options={})=>{
 const body=options.body?JSON.parse(options.body):null;
 calls.push({path,body});
 if(path==='api/properties')return {ok:true,json:async()=>({properties:{},etalonLoaded:false})};
 if(path.startsWith('api/supplier-emails?'))return {ok:true,json:async()=>({emails:[...savedEmails],last:savedLast})};
 if(path==='api/supplier-emails/remove'){savedEmails=savedEmails.filter(x=>x!==body.email);if(savedLast===body.email)savedLast='';return {ok:true,json:async()=>({emails:[...savedEmails],last:savedLast})};}
 if(path==='api/orders/send-mail')return {ok:true,json:async()=>({sent:true,to:body.to,fileName:'Заказ.xlsx'})};
 return {ok:true,json:async()=>({report})};
};
w.eval(fs.readFileSync('internal/server/web/app.js','utf8'));
const tick=()=>new Promise(r=>setTimeout(r,60));
(async()=>{try{
 await tick();
 d.querySelector('[data-sup-row-check]').click();await tick();
 d.querySelector('[data-mail-sup]').click();await tick();
 assert.equal(d.querySelectorAll('#mailToSelect option').length,2);
 assert.equal(d.getElementById('mailToInput').value,'b@sup.ru');
 // Б73: удаление ненужного адреса из отправки.
 d.getElementById('mailToSelect').value='a@sup.ru';
 d.getElementById('btnMailAddrDelete').click();await tick();
 const rm=calls.find(c=>c.path==='api/supplier-emails/remove');
 assert.ok(rm,'Б73: удаление адреса вызвано');
 assert.equal(rm.body.email,'a@sup.ru');assert.equal(rm.body.supplier,'Поставщик');assert.equal(rm.body.warehouse,'Мир');
 assert.equal(d.querySelectorAll('#mailToSelect option').length,1,'Б73: адрес исчез из списка');
 assert.match(d.getElementById('toast').textContent,/Адрес удалён/);
 // Удаление последнего адреса прячет список выбора.
 d.getElementById('btnMailAddrDelete').click();await tick();
 assert.equal(d.querySelectorAll('#mailToSelect option').length,0);
 assert.ok(d.getElementById('mailToSelectWrap').classList.contains('hidden'),'Б73: пустой список скрыт');
 assert.equal(d.getElementById('mailToInput').value,'','Б73: поле адреса очищено');
 // Б73: имя вложения письма — RFC 5987 (серверный контракт).
 const goMail=fs.readFileSync('internal/server/mail_order.go','utf8');
 assert.ok(goMail.includes('mime.FormatMediaType("attachment"'),'Б73: имя вложения кодируется по RFC 5987');
 assert.ok(!goMail.includes('filename*=UTF-8'),'Б73: самодельная кодировка имени убрана');
 console.log('BATCH-73: delete saved mail addresses + RFC 5987 attachment name: OK');
}catch(e){console.error(e);process.exitCode=1;}finally{w.close();}})();
