package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
)

func TestIndependentNomenclatureProperties(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	request := func(app *server.AppServer, method, body string) map[string]json.RawMessage {
		t.Helper()
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(method, "/api/properties", bytes.NewBufferString(body)))
		if rec.Code != 200 {
			t.Fatalf("properties: %d %s", rec.Code, rec.Body.String())
		}
		var result map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	request(app, http.MethodPost, `{"properties":{"sku:A":true,"sku:B":false}}`)
	// Changes are in application memory before an explicit save.
	if _, err := os.Stat(filepath.Join(dir, "Свойства Номенклатуры", "properties.json")); !os.IsNotExist(err) {
		t.Fatal("unsaved properties written to disk")
	}
	result := request(app, http.MethodGet, "")
	if !strings.Contains(string(result["properties"]), `"sku:A":true`) {
		t.Fatal("memory lost properties")
	}
	result = request(app, http.MethodPost, `{"save":true}`)
	var name string
	_ = json.Unmarshal(result["fileName"], &name)
	if !strings.HasPrefix(name, "Свойства Номенклатуры, ") || !strings.Contains(name, "：") {
		t.Fatalf("bad snapshot name %s", name)
	}
	if _, err := os.Stat(filepath.Join(dir, "Свойства Номенклатуры", name)); err != nil {
		t.Fatal(err)
	}
	app2 := server.New(false)
	app2.SetSaveDir(dir)
	result = request(app2, http.MethodGet, "")
	var props map[string]bool
	_ = json.Unmarshal(result["properties"], &props)
	if !props["sku:A"] || props["sku:B"] || len(props) != 2 {
		t.Fatalf("restart did not restore properties: %v", props)
	}
	request(app2, http.MethodPost, `{"properties":{"sku:A":false},"save":true}`)
	app3 := server.New(false)
	app3.SetSaveDir(dir)
	result = request(app3, http.MethodGet, "")
	_ = json.Unmarshal(result["properties"], &props)
	if props["sku:A"] {
		t.Fatal("removed checkmark returned after restart")
	}
}

// Батч-35: база остатка отметки «+» (markStocks) сохраняется в каталоге свойств
// и переживает перезапуск; снятие отметки удаляет её базу.
func TestMarkStocksRoundTrip(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	request := func(a *server.AppServer, method, body string) map[string]json.RawMessage {
		t.Helper()
		rec := httptest.NewRecorder()
		a.Handler().ServeHTTP(rec, httptest.NewRequest(method, "/api/properties", bytes.NewBufferString(body)))
		if rec.Code != 200 {
			t.Fatalf("properties: %d %s", rec.Code, rec.Body.String())
		}
		var result map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	request(app, http.MethodPost, `{"properties":{"sku:X":true},"markStocks":{"sku:X":5.5}}`)
	result := request(app, http.MethodGet, "")
	var stocks map[string]float64
	if err := json.Unmarshal(result["markStocks"], &stocks); err != nil {
		t.Fatal(err)
	}
	if stocks["sku:X"] != 5.5 {
		t.Fatalf("markStock in memory lost: %v", stocks)
	}
	request(app, http.MethodPost, `{"save":true}`)
	app2 := server.New(false)
	app2.SetSaveDir(dir)
	result = request(app2, http.MethodGet, "")
	stocks = nil
	if err := json.Unmarshal(result["markStocks"], &stocks); err != nil {
		t.Fatal(err)
	}
	if stocks["sku:X"] != 5.5 {
		t.Fatalf("markStock did not survive restart: %v", stocks)
	}
	// Снятие отметки удаляет базу.
	request(app2, http.MethodPost, `{"properties":{"sku:X":false},"markStocks":{"sku:X":1}}`)
	result = request(app2, http.MethodGet, "")
	stocks = nil
	_ = json.Unmarshal(result["markStocks"], &stocks)
	if _, ok := stocks["sku:X"]; ok {
		t.Fatalf("unmarked item must not keep a stock baseline: %v", stocks)
	}
}
