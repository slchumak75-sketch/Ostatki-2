package xlsx_test

import (
	"archive/zip"
	"bytes"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestParseFlexibleFloatAndPeriodHeaders(t *testing.T) {
	if got := xlsx.ParseFlexibleFloat("7.00\n9.72"); got != 9.72 {
		t.Fatalf("expected multiline batch price 9.72, got %v", got)
	}
	if got := xlsx.ParseFlexibleFloat("16.00\n22.14"); got != 22.14 {
		t.Fatalf("expected 22.14, got %v", got)
	}
	if y, m, ok := xlsx.ParsePeriodHeader("Октябрь 2026 г."); !ok || y != 2026 || m != 10 {
		t.Fatalf("unexpected period parse: %d-%d (%v)", y, m, ok)
	}
	if y, m, ok := xlsx.ParsePeriodHeader("03.2025"); !ok || y != 2025 || m != 3 {
		t.Fatalf("unexpected numeric period parse: %d-%d (%v)", y, m, ok)
	}
}

func TestReadAndWriteRealRepositoryWorkbookLossless(t *testing.T) {
	repoFile := filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")
	wb, raw, err := xlsx.ReadFile(repoFile)
	if err != nil {
		t.Fatalf("ReadFile failed: %v", err)
	}

	if len(wb.Items) != 1850 {
		t.Fatalf("expected 1850 items, got %d", len(wb.Items))
	}
	if len(wb.Periods) != 37 {
		t.Fatalf("expected 37 monthly columns, got %d", len(wb.Periods))
	}
	if wb.HeaderRow != 7 || wb.OrderCol != 8 {
		t.Fatalf("expected HeaderRow=7 OrderCol=8, got %d, %d", wb.HeaderRow, wb.OrderCol)
	}
	if wb.CreatedDate != "2026-10-19" {
		t.Fatalf("expected CreatedDate=2026-10-19, got %q", wb.CreatedDate)
	}

	// Проверка точного чтения Склада, Группы, Артикула и чистого Наименования номенклатуры из исходного Excel
	nonEmptySKU := 0
	var row13 *model.RawItem
	for i := range wb.Items {
		if wb.Items[i].SKU != "" {
			nonEmptySKU++
		}
		if wb.Items[i].ExcelRow == 13 {
			row13 = &wb.Items[i]
		}
	}
	if nonEmptySKU != 197 {
		t.Fatalf("expected 197 non-empty SKU values from source Excel, got %d", nonEmptySKU)
	}
	if row13 == nil || row13.Warehouse != "Склад Кореличи" || row13.Group != "2 краски растворители" || row13.SKU != "0242345" || row13.Name != "Ацетон техн.1,0л." {
		t.Fatalf("unexpected row 13 fields: %+v", row13)
	}

	rep := forecast.Calculate(wb, model.DefaultParams(), map[int]int{8: 15})
	orders := forecast.ExtractOrdersMap(rep)

	written, err := xlsx.WriteOrderColumnLossless(raw, wb.HeaderRow, wb.OrderCol, "К закупкам", orders, true)
	if err != nil {
		t.Fatalf("WriteOrderColumnLossless failed: %v", err)
	}

	// Повторное чтение записанного файла и проверка 100% совпадения столбца 8 и сохранности drawing1.xml
	reRead, err := xlsx.ParseBytes(written, "test.xlsx")
	if err != nil {
		t.Fatalf("re-parse failed: %v", err)
	}
	if reRead.OrderHeader != "К закупкам" {
		t.Fatalf("expected header 'К закупкам', got %q", reRead.OrderHeader)
	}
	for _, it := range reRead.Items {
		if it.ExistingOrder == nil {
			t.Fatalf("row %d has nil ExistingOrder", it.ExcelRow)
		}
		if int(*it.ExistingOrder) != orders[it.ExcelRow] {
			t.Fatalf("row %d mismatch: got %v want %d", it.ExcelRow, *it.ExistingOrder, orders[it.ExcelRow])
		}
	}

	writtenTwice, err := xlsx.WriteOrderColumnLossless(written, reRead.HeaderRow, reRead.OrderCol, "К закупкам", orders, false)
	if err != nil {
		t.Fatalf("second WriteOrderColumnLossless failed: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(writtenTwice), int64(len(writtenTwice)))
	if err != nil {
		t.Fatalf("zip read failed: %v", err)
	}
	hasDrawing := false
	for _, f := range zr.File {
		if f.Name == "xl/drawings/drawing1.xml" {
			hasDrawing = true
		}
	}
	if !hasDrawing {
		t.Fatalf("expected xl/drawings/drawing1.xml (1C buttons) to be preserved lossless")
	}

	// Проверка генерации 4-листового отчёта поставщикам (без листа сравнения с Вариантом 1)
	supReport, err := xlsx.GenerateSupplierOrdersXLSX(rep, "", "")
	if err != nil || len(supReport) < 1000 {
		t.Fatalf("GenerateSupplierOrdersXLSX failed: err=%v size=%d", err, len(supReport))
	}
	szr, err := zip.NewReader(bytes.NewReader(supReport), int64(len(supReport)))
	if err != nil {
		t.Fatalf("zip read supReport failed: %v", err)
	}
	for _, f := range szr.File {
		if f.Name == "xl/worksheets/sheet5.xml" {
			t.Fatalf("sheet5.xml (Variant 1 comparison) must be excluded from Variant 2 workbook")
		}
	}
}
