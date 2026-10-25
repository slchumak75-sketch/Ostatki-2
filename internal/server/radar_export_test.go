package server

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

func TestRadarExportSelectionAndReadOnly(t *testing.T) {
	app := New(false)
	app.report = &model.CalculationReport{Items: []model.CalculatedItem{
		{RawItem: model.RawItem{ExcelRow: 8, Warehouse: "Мир", Group: "Группа", SKU: "001", Name: "Товар <1>", ClosingStock: 9, PurchasePrice: 2}, IsOverstock: true, SalesSegment: 4, SumSalesLast12M: 3, OverstockValue: 12.5},
		{RawItem: model.RawItem{ExcelRow: 9, Name: "Не неликвид"}},
		{RawItem: model.RawItem{ExcelRow: 10, Warehouse: "Другой", Name: "Второй"}, IsOverstock: true, OverstockValue: 3},
	}}
	original := append([]model.CalculatedItem(nil), app.report.Items...)
	request := func(method, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(method, "/api/export/radar", strings.NewReader(body)))
		return rec
	}
	for _, body := range []string{`{}`, `{"excelRows":[]}`, `{"excelRows":[9]}`, `{"excelRows":[999]}`, `broken`} {
		if rec := request(http.MethodPost, body); rec.Code != 400 {
			t.Fatalf("invalid selection %s: %d", body, rec.Code)
		}
	}
	if rec := request(http.MethodGet, ""); rec.Code != 405 {
		t.Fatal(rec.Code)
	}
	rec := request(http.MethodPost, `{"excelRows":[10,8,10]}`)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Header().Get("Content-Disposition"), "filename*=UTF-8''") {
		t.Fatal("missing Unicode download filename")
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var sheet string
	for _, f := range zr.File {
		if f.Name == "xl/worksheets/sheet1.xml" {
			r, _ := f.Open()
			raw, _ := io.ReadAll(r)
			r.Close()
			sheet = string(raw)
		}
	}
	for _, want := range []string{`<autoFilter ref="A1:K3"`, `ySplit="1"`, `Заморожено сверх года`, `<c r="K4" s="3"><v>15.5</v>`, `Товар &lt;1&gt;`, `>001<`} {
		if !strings.Contains(sheet, want) {
			t.Fatalf("missing %s", want)
		}
	}
	if strings.Index(sheet, "Второй") > strings.Index(sheet, "Товар &lt;1&gt;") {
		t.Fatal("export lost requested sort order")
	}
	if strings.Contains(sheet, "Не неликвид") {
		t.Fatal("non-radar row leaked")
	}
	if !reflect.DeepEqual(original, app.report.Items) {
		t.Fatal("export mutated report")
	}
	app.report = nil
	if rec := request(http.MethodPost, `{"excelRows":[8]}`); rec.Code != 400 {
		t.Fatal(rec.Code)
	}
}
