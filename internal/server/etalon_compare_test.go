package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestComparisonUsesRawRatingAndWarehouseScopedUnion(t *testing.T) {
	app := New(false)
	dir := t.TempDir()
	app.SetSaveDir(dir)
	app.propertiesLoaded = true
	app.properties = map[string]bool{}
	app.etalon = map[string]model.NomenclatureRecord{}
	app.report = &model.CalculationReport{}
	// checked, current stock, reference stock, current rating, reference rating, matches
	cases := []struct {
		checked           bool
		stock, refStock   float64
		rating, refRating int
		matches           bool
	}{
		{true, 11, 10, 3, 3, true},   // marked stock increase
		{false, 9, 10, 0, 1, true},   // 1 -> 0, even without mark and without stock increase
		{false, 11, 10, 3, 3, false}, // growth without a mark
		{true, 10, 10, 2, 2, false},  // equality is not growth
		{true, 9, 10, 2, 2, false},   // decrease is not growth
		{false, 9, 10, 0, 2, false},  // 2 -> 0 must not match
		{true, -1, -2, 0, 1, true},   // negative balances and overlap, one output row
	}
	for i, c := range cases {
		it := model.CalculatedItem{RawItem: model.RawItem{ExcelRow: i + 8, SKU: "001", Warehouse: string(rune('А' + i)), Name: "Товар", ClosingStock: c.stock}, SalesSegment: c.rating}
		if i == 6 {
			it.SKU = ""
			it.Group = "Группа"
		}
		key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
		app.report.Items = append(app.report.Items, it)
		app.properties[key] = c.checked
		app.etalon[key] = model.NomenclatureRecord{SKU: it.SKU, Warehouse: it.Warehouse, Name: it.Name, Group: it.Group, Stock: c.refStock, Rating: c.refRating}
	}
	// A new item that has no warehouse-matching reference must be absent.
	app.report.Items = append(app.report.Items, model.CalculatedItem{RawItem: model.RawItem{ExcelRow: 99, SKU: "001", Warehouse: "Новый склад", Name: "Товар", ClosingStock: 999}, SalesSegment: 0})
	original := append([]model.CalculatedItem(nil), app.report.Items...)
	app.mu.RLock()
	overlay := app.buildStateEnvelopeLocked()
	app.mu.RUnlock()
	if overlay.Report.Items[1].SalesSegment != 0 {
		t.Fatal("normal report must display its current rating, not the reference rating")
	}
	// The catalog and ordinary export must not inherit the reference rating.
	app.wb = &model.WorkbookData{}
	if app.reportForExportLocked().Items[1].SalesSegment != 0 {
		t.Fatal("export inherited the reference rating")
	}
	catalog := app.catalogLocked()
	it := app.report.Items[1]
	key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
	if catalog.Nomenclature[key].Rating != 0 || app.etalon[key].Rating != 1 {
		t.Fatal("live catalog and fixed reference were mixed")
	}
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/etalon/compare", nil))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var got struct {
		Rows  []etalonComparisonRow `json:"rows"`
		Count int                   `json:"matchedCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Rows) != len(cases) || got.Count != 3 {
		t.Fatal(got)
	}
	for i, c := range cases {
		r := got.Rows[i]
		if r.Matches != c.matches || r.CurrentRating != c.rating {
			t.Fatalf("case %d: %+v", i, r)
		}
	}
	if !reflect.DeepEqual(original, app.report.Items) {
		t.Fatal("comparison mutated the original report")
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 0 {
		t.Fatal("comparison must not write files", files, err)
	}
}

func TestComparisonRequiresWorkbookAndReference(t *testing.T) {
	app := New(false)
	app.SetSaveDir(t.TempDir())
	for _, report := range []*model.CalculationReport{nil, {Items: []model.CalculatedItem{{RawItem: model.RawItem{ExcelRow: 8}}}}} {
		app.report = report
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/etalon/compare", nil))
		if rec.Code != 400 {
			t.Fatal(rec.Code)
		}
	}
}

func TestFailedPropertiesWriteDoesNotAdvanceSaveStatus(t *testing.T) {
	app := New(false)
	app.propertiesLoaded = true
	app.propertiesFileName = "previous.json"
	app.propertiesSavedAt = "2026-10-20T10:00:00+03:00"
	dir := t.TempDir()
	// An occupied directory at the catalog filename forces replacement to fail.
	if err := os.Mkdir(dir+"/properties.json", 0700); err != nil {
		t.Fatal(err)
	}
	if err := app.persistPropertiesLocked(dir); err == nil {
		t.Fatal("expected storage failure")
	}
	if app.propertiesFileName != "previous.json" || app.propertiesSavedAt != "2026-10-20T10:00:00+03:00" {
		t.Fatal("failed write changed the last successful save metadata")
	}
}
