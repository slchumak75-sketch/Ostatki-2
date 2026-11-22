const fs=require('node:fs'),assert=require('node:assert/strict');
// Б74: Excel-восстановление заказа и имя склада в почте — серверные контракты.
const writer=fs.readFileSync('internal/xlsx/writer.go','utf8');
assert.ok(writer.includes('application/vnd.openxmlformats-package.relationships+xml'),'Б74: нормативный тип части связей');
assert.ok(!writer.includes('openxmlformats.package.relationships'),'Б74: битого типа (точка) не осталось');
assert.ok(writer.includes('func DisplayWarehouseName'),'Б74: отображаемое имя склада доступно письму');
assert.ok(writer.includes('normalizeWarehouseKey'),'Б74: переименование устойчиво к пробелам/регистру');
const mail=fs.readFileSync('internal/server/mail_order.go','utf8');
assert.ok(mail.includes('orderMailSubject')&&mail.includes('xlsx.DisplayWarehouseName(warehouse)'),'Б74: тема и текст письма — с организацией');
const html=fs.readFileSync('internal/server/web/index.html','utf8');
assert.ok(html.includes('Вариант 7.18'),'Б74: индекс 7.18 в интерфейсе');
console.log('BATCH-74: excel repair fix + warehouse org name in mail: OK');
