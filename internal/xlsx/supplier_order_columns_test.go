package xlsx

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

func TestSingleSupplierOrderSalesStockAndOrderColumns(t *testing.T) {
	report := &model.CalculationReport{Items: []model.CalculatedItem{
		{RawItem: model.RawItem{Warehouse: "Мир", SKU: "001", Name: "Товар", Supplier: "Поставщик", ClosingStock: 7.5}, SumSalesLast12M: 32.5, FinalOrderQty: 4},
		{RawItem: model.RawItem{Warehouse: "Мир", SKU: "002", Supplier: "Другой"}, FinalOrderQty: 10},
		{RawItem: model.RawItem{Warehouse: "Мир", SKU: "003", Supplier: "Поставщик"}, FinalOrderQty: 0},
	}}
	raw, err := GenerateSingleSupplierOrderXLSX(report, "Мир", "Поставщик")
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	var sheet string
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			r, _ := f.Open()
			b, _ := io.ReadAll(r)
			r.Close()
			sheet = string(b)
		}
	}
	for _, cell := range []string{inlineStrCell("E1", 1, "Продажи"), inlineStrCell("F1", 1, "Остаток"), inlineStrCell("G1", 1, "Заказ"), numCell("E2", 3, 32.5), numCell("F2", 3, 7.5), numCell("G2", 3, 4), `<autoFilter ref="A1:G2"/>`} {
		if !strings.Contains(sheet, cell) {
			t.Fatalf("missing cell or filter: %s", cell)
		}
	}
	if strings.Contains(sheet, `r="3"`) {
		t.Fatal("nonselected supplier or zero order leaked")
	}
}

func TestSingleSupplierOrderShortFormatDropsSalesAndStock(t *testing.T) {
	report := &model.CalculationReport{Items: []model.CalculatedItem{
		{RawItem: model.RawItem{Warehouse: "Мир", SKU: "001", Name: "Товар", Supplier: "Поставщик", ClosingStock: 7.5}, SumSalesLast12M: 32.5, FinalOrderQty: 4},
	}}
	raw, err := GenerateSingleSupplierOrderXLSXEx(report, "Мир", "Поставщик", false)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	var sheet string
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			r, _ := f.Open()
			b, _ := io.ReadAll(r)
			r.Close()
			sheet = string(b)
		}
	}
	for _, cell := range []string{inlineStrCell("E1", 1, "Заказ"), numCell("E2", 3, 4), `<autoFilter ref="A1:E2"/>`} {
		if !strings.Contains(sheet, cell) {
			t.Fatalf("missing short-format cell: %s", cell)
		}
	}
	for _, banned := range []string{"Продажи", "Остаток", `r="G`} {
		if strings.Contains(sheet, banned) {
			t.Fatalf("short format must not contain %q", banned)
		}
	}
}

// Батч-84: копия заказа — расширенные 7 столбцов и строка «Итого» внизу
// с суммарным количеством; обычный заказ поставщика итога не содержит.
func TestSingleSupplierOrderCopyHasTotalsRow(t *testing.T) {
	report := &model.CalculationReport{Items: []model.CalculatedItem{
		{RawItem: model.RawItem{Warehouse: "Мир", SKU: "001", Name: "Товар", Supplier: "Поставщик", ClosingStock: 7.5, PurchasePrice: 2.5}, SumSalesLast12M: 32.5, FinalOrderQty: 4},
		{RawItem: model.RawItem{Warehouse: "Мир", SKU: "002", Name: "Товар 2", Supplier: "Поставщик", ClosingStock: 1, PurchasePrice: 3}, SumSalesLast12M: 10, FinalOrderQty: 6},
	}}
	raw, err := GenerateSingleSupplierOrderXLSXCopy(report, "Мир", "Поставщик")
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	var sheet string
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			r, _ := f.Open()
			b, _ := io.ReadAll(r)
			r.Close()
			sheet = string(b)
		}
	}
	// Б89: у копии есть столбец «Сумма» (количество × цена) и итог по сумме.
	for _, want := range []string{inlineStrCell("A4", 1, "Итого"), numCell("G4", 3, 10), inlineStrCell("H1", 1, "Сумма"), numCell("H2", 5, 10), numCell("H3", 5, 18), numCell("H4", 5, 28), `<autoFilter ref="A1:H3"/>`} {
		if !strings.Contains(sheet, want) {
			t.Fatalf("copy sheet missing %s\n%s", want, sheet)
		}
	}
	// Обычный (не копия) расширенный заказ строки «Итого» не получает.
	rawPlain, err := GenerateSingleSupplierOrderXLSXEx(report, "Мир", "Поставщик", true)
	if err != nil {
		t.Fatal(err)
	}
	zr2, _ := zip.NewReader(bytes.NewReader(rawPlain), int64(len(rawPlain)))
	for _, f := range zr2.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			r, _ := f.Open()
			b, _ := io.ReadAll(r)
			r.Close()
			if strings.Contains(string(b), "Итого") {
				t.Fatal("plain supplier order must not contain totals row")
			}
		}
	}
}
