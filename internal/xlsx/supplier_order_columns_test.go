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
