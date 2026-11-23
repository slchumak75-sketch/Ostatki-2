package xlsx

import (
	"archive/zip"
	"bytes"
	"testing"
)

// Б80: колонка «Код» из выгрузки 1С читается как штрихкод и едет в
// позицию ведомости (RawItem.Barcode), где бы колонка ни стояла.
func TestParseBarcodeFromKodColumn(t *testing.T) {
	sheet := `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
		`<row r="7">` +
		`<c r="A7" t="inlineStr"><is><t>Склад</t></is></c>` +
		`<c r="B7" t="inlineStr"><is><t>Группа номенклатуры</t></is></c>` +
		`<c r="C7" t="inlineStr"><is><t>Артикул</t></is></c>` +
		`<c r="D7" t="inlineStr"><is><t>Код</t></is></c>` +
		`<c r="E7" t="inlineStr"><is><t>Номенклатура</t></is></c>` +
		`<c r="F7" t="inlineStr"><is><t>Расход</t></is></c>` +
		`<c r="G7" t="inlineStr"><is><t>Конечный остаток</t></is></c>` +
		`<c r="I7" t="inlineStr"><is><t>Цена последнего поставщика</t></is></c>` +
		`<c r="J7" t="inlineStr"><is><t>Розничная цена</t></is></c>` +
		`<c r="K7" t="inlineStr"><is><t>Последний поставщик</t></is></c>` +
		`<c r="L7" t="inlineStr"><is><t>Январь 2024 г.</t></is></c>` +
		`</row>` +
		`<row r="8">` +
		`<c r="A8" t="inlineStr"><is><t>Мир</t></is></c>` +
		`<c r="B8" t="inlineStr"><is><t>Группа</t></is></c>` +
		`<c r="C8" t="inlineStr"><is><t>ART-1</t></is></c>` +
		`<c r="D8" t="inlineStr"><is><t>0460001234567</t></is></c>` +
		`<c r="E8" t="inlineStr"><is><t>Товар</t></is></c>` +
		`<c r="F8"><v>5</v></c><c r="G8"><v>3</v></c>` +
		`<c r="I8"><v>10</v></c><c r="J8"><v>12</v></c>` +
		`<c r="K8" t="inlineStr"><is><t>Поставщик</t></is></c>` +
		`<c r="L8"><v>2</v></c>` +
		`</row></sheetData></worksheet>`
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f, err := zw.Create("xl/worksheets/sheet1.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte(sheet)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	wb, err := ParseBytes(buf.Bytes(), "test.xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if len(wb.Items) != 1 {
		t.Fatalf("items=%d", len(wb.Items))
	}
	it := wb.Items[0]
	if it.SKU != "ART-1" || it.Barcode != "0460001234567" {
		t.Fatalf("sku=%q barcode=%q", it.SKU, it.Barcode)
	}
}
