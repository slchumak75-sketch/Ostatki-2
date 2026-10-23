package xlsx_test

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

	// Проверка индивидуального заказа поставщику (5 столбцов: Склад, Артикул, Номенклатура, Ед., Заказ — без цветовой заливки)
	dt := time.Date(2026, time.October, 20, 12, 0, 0, 0, time.UTC)
	gotName := xlsx.FormatSupplierOrderFilename("Склад Кореличи", `ООО "ГолдДекор"`, dt)
	wantName := "Склад Кореличи, ООО «ГолдДекор», 20.10.2026.xlsx"
	if gotName != wantName {
		t.Fatalf("FormatSupplierOrderFilename mismatch: got %q want %q", gotName, wantName)
	}

	singleOrder, err := xlsx.GenerateSingleSupplierOrderXLSX(rep, "Склад Кореличи", `ООО "ГолдДекор"`)
	if err != nil || len(singleOrder) < 800 {
		t.Fatalf("GenerateSingleSupplierOrderXLSX failed: err=%v len=%d", err, len(singleOrder))
	}
	ozr, err := zip.NewReader(bytes.NewReader(singleOrder), int64(len(singleOrder)))
	if err != nil {
		t.Fatalf("zip read singleOrder failed: %v", err)
	}
	for _, f := range ozr.File {
		if f.Name == "xl/styles.xml" {
			rc, _ := f.Open()
			rawXML, _ := io.ReadAll(rc)
			_ = rc.Close()
			stylesStr := string(rawXML)
			if strings.Contains(stylesStr, `patternType="solid"`) || strings.Contains(stylesStr, "<fgColor") {
				t.Fatalf("single supplier order styles.xml must NOT contain colored cell fills, got: %s", stylesStr)
			}
		}
		if f.Name == "xl/worksheets/sheet1.xml" {
			rc, _ := f.Open()
			rawXML, _ := io.ReadAll(rc)
			_ = rc.Close()
			xmlStr := string(rawXML)
			for _, colHdr := range []string{
				`<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Наименование склада</t></is></c>`,
				`<c r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">Артикул</t></is></c>`,
				`<c r="C1" s="1" t="inlineStr"><is><t xml:space="preserve">Номенклатура</t></is></c>`,
				`<c r="D1" s="1" t="inlineStr"><is><t xml:space="preserve">Ед.</t></is></c>`,
				`<c r="E1" s="1" t="inlineStr"><is><t xml:space="preserve">Заказ</t></is></c>`,
				`<c r="D2" s="4" t="inlineStr"><is><t xml:space="preserve">шт.</t></is></c>`,
			} {
				if !strings.Contains(xmlStr, colHdr) {
					t.Fatalf("single supplier order sheet1.xml missing expected cell: %s", colHdr)
				}
			}
			if strings.Contains(xmlStr, `r="F1"`) {
				t.Fatalf("single supplier order must contain strictly 5 columns (A..E), found F1")
			}
		}
	}

	// Проверка формирования имени и полного сохранения/восстановления базы («<Склад>, Ведомость сохраненная, <ДД.ММ.ГГГГ>.xlsx»)
	saveDate := time.Date(2026, time.October, 22, 15, 30, 0, 0, time.UTC)
	if got := xlsx.FormatSavedDatabaseFilename("Склад Мир", saveDate); got != "Ведомость сохранена, 22.10.2026, 15-30-00.xlsx" {
		t.Fatalf("FormatSavedDatabaseFilename mismatch: got %q", got)
	}
	if got := xlsx.FormatSavedDatabaseFilename("", saveDate); got != "Ведомость сохранена, 22.10.2026, 15-30-00.xlsx" {
		t.Fatalf("FormatSavedDatabaseFilename empty warehouse fallback mismatch: got %q", got)
	}

	defParams := model.DefaultParams()
	selRow := 12
	snap := &model.SavedDatabaseSnapshot{
		Version:                 1,
		SavedAt:                 "22.10.2026 15:30:00",
		SavedFileName:           "Склад Кореличи, Ведомость сохраненная, 22.10.2026.xlsx",
		SourceFileName:          "Ведомость с периодом ОК (1).xlsx",
		WarehouseLabel:          "Склад Кореличи",
		Params:                  defParams,
		Overrides:               map[int]int{8: 25, 12: 7},
		SupplierSelectionActive: true,
		SelectedSuppliers:       []string{`ООО "ГолдДекор"`},
		UI: model.SavedUIState{
			StaryoMode:       true,
			StaryoRows:       []int{8, 12},
			HidePlusSku:      true,
			ActiveTab:        "table",
			ActivePreset:     "short",
			ParamsExpanded:   true,
			SelectedExcelRow: &selRow,
			SortKey:          "closingStock",
			SortDir:          "asc",
			FltWarehouse:     "Склад Кореличи",
			FltRating:        "5",
			FltStatus:        "order",
			SearchSku:        "10",
			SearchName:       "кабель",
			TableColWidths:   []int{110, 140, 90, 260, 48, 70, 36, 70, 75, 75, 80, 75, 75, 85, 180},
			ScrollY:          320,
		},
	}

	savedBytes1, err := xlsx.BuildSavedDatabaseXLSX(raw, wb.HeaderRow, wb.OrderCol, defParams.ColumnHeader, orders, true, snap)
	if err != nil {
		t.Fatalf("BuildSavedDatabaseXLSX #1 failed: %v", err)
	}
	// Повторная перезапись поверх уже сохранённого .xlsx не должна дублировать Extension="json"
	savedBytes2, err := xlsx.BuildSavedDatabaseXLSX(savedBytes1, wb.HeaderRow, wb.OrderCol, defParams.ColumnHeader, orders, true, snap)
	if err != nil {
		t.Fatalf("BuildSavedDatabaseXLSX #2 overwrite failed: %v", err)
	}

	tmpSavedPath := filepath.Join(t.TempDir(), snap.SavedFileName)
	if err := os.WriteFile(tmpSavedPath, savedBytes2, 0o644); err != nil {
		t.Fatalf("write saved db file: %v", err)
	}

	diskMeta, err := xlsx.ReadSavedDatabaseMetadataFromFile(tmpSavedPath)
	if err != nil || diskMeta == nil {
		t.Fatalf("ReadSavedDatabaseMetadataFromFile failed: err=%v meta=%v", err, diskMeta)
	}
	if diskMeta.SavedFileName != snap.SavedFileName || diskMeta.UI.FltWarehouse != "Склад Кореличи" || len(diskMeta.UI.StaryoRows) != 2 {
		t.Fatalf("unexpected disk metadata: %+v", diskMeta)
	}

	extracted, err := xlsx.ExtractSavedDatabaseSnapshot(savedBytes2)
	if err != nil || extracted == nil {
		t.Fatalf("ExtractSavedDatabaseSnapshot failed: err=%v snap=%v", err, extracted)
	}
	if extracted.Overrides[8] != 25 || extracted.Overrides[12] != 7 || !extracted.UI.HidePlusSku || extracted.UI.ScrollY != 320 {
		t.Fatalf("unexpected extracted snapshot: %+v", extracted)
	}
}
