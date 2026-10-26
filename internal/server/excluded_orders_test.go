package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestMarkedNomenclatureExcludesAutomaticOrders(t *testing.T) {
	app := server.New(false)
	dir := t.TempDir()
	app.SetSaveDir(dir)
	file := filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx")
	if err := app.LoadWorkbookFromPath(file); err != nil {
		t.Fatal(err)
	}
	call := func(path string, body any) {
		t.Helper()
		raw, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw)))
		if rec.Code != 200 {
			t.Fatal(path, rec.Code, rec.Body.String())
		}
	}
	report := func() *model.CalculationReport {
		t.Helper()
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))
		var env struct {
			Report *model.CalculationReport `json:"report"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatal(err)
		}
		return env.Report
	}
	var target model.CalculatedItem
	for _, it := range report().Items {
		if it.AutoOrderQty > 0 {
			target = it
			break
		}
	}
	if target.AutoOrderQty == 0 {
		t.Fatal("fixture has no automatic orders")
	}
	key := xlsx.NomenclaturePropertyKey(target.SKU, target.Group, target.Name, target.Warehouse)
	find := func() model.CalculatedItem {
		for _, it := range report().Items {
			if it.ExcelRow == target.ExcelRow {
				return it
			}
		}
		t.Fatal("missing row")
		return model.CalculatedItem{}
	}
	call("/api/properties", map[string]any{"properties": map[string]bool{key: true}, "save": true})
	if it := find(); it.AutoOrderQty != 0 || it.FinalOrderQty != 0 {
		t.Fatal("marked item auto-filled", it.AutoOrderQty, it.FinalOrderQty)
	}
	call("/api/params", report().Params)
	if it := find(); it.AutoOrderQty != 0 || it.FinalOrderQty != 0 {
		t.Fatal("parameter recalculation restored auto-order")
	}
	call("/api/override", map[string]any{"excelRow": target.ExcelRow, "value": 7})
	if it := find(); it.AutoOrderQty != 0 || it.FinalOrderQty != 7 {
		t.Fatal("manual entry must remain available", it.FinalOrderQty)
	}
	call("/api/override", map[string]any{"excelRow": target.ExcelRow, "clear": true})
	if it := find(); it.FinalOrderQty != 0 {
		t.Fatal("reset must not autofill marked item")
	}
	call("/api/properties", map[string]any{"properties": map[string]bool{key: false}})
	if it := find(); it.AutoOrderQty <= 0 || it.FinalOrderQty != 0 {
		t.Fatal("unmark must restore recommendation without filling order")
	}
	// Previously saved properties apply even when loading before the browser connects.
	app2 := server.New(false)
	app2.SetSaveDir(dir)
	if err := app2.LoadWorkbookFromPath(file); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	app2.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	var env struct {
		Report *model.CalculationReport `json:"report"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &env)
	for _, it := range env.Report.Items {
		if it.ExcelRow == target.ExcelRow && it.FinalOrderQty != 0 {
			t.Fatal("saved checkmark ignored during loading")
		}
	}
}
