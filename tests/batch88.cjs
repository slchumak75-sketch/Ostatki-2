const fs=require('node:fs'),assert=require('node:assert/strict');
// Б88: установка падала на "C:\Program Files (x86)\Ostatki2" — нет прав.
// Установщик обязан сам уходить из Program Files в папку пользователя,
// а не умирать с «Невозможно открыть файл для записи».
const nsi=fs.readFileSync('installer/ostatki.nsi','utf8');
assert.ok(nsi.includes('Function .onInit'),'Б88: .onInit в установщике есть');
assert.ok(nsi.includes('$PROGRAMFILES64')&&nsi.includes('$LOCALAPPDATA\\Programs\\Ostatki2'),'Б88: Program Files -> папка пользователя');
assert.ok(nsi.includes('.ostatki_write_test'),'Б88: проверка записи в папку до копирования');
assert.ok(nsi.includes('нет прав на запись'),'Б88: понятное объяснение вместо падения');
const upd=fs.readFileSync('internal/server/update_windows.go','utf8');
assert.ok(upd.includes('нет прав на запись в папку программы'),'Б88: и помощник обновления называет причину про права');
console.log('BATCH-88: installer escapes Program Files without admin: OK');
