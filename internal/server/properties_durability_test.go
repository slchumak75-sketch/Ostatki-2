package server_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestPropertiesDurableIncrementalSaveAndExport(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	props := map[string]bool{}
	for i := 0; i < 18000; i++ {
		props[xlsx.NomenclaturePropertyKey("", "Герметики", fmt.Sprintf("Длинное наименование товара для проверки сохранения %d", i), "Склад Мир")] = i%2 == 0
	}
	request := func(app *server.AppServer, method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, bytes.NewReader(raw)))
		if rec.Code != 200 {
			t.Fatalf("%s %d %s", path, rec.Code, rec.Body.String())
		}
		return rec
	}
	rec := request(app, http.MethodPost, "/api/properties", map[string]any{"properties": props, "persist": true})
	var ack struct {
		Persisted bool `json:"persisted"`
		Marked    int  `json:"markedCount"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &ack)
	if !ack.Persisted || ack.Marked != 9000 {
		t.Fatal("unconfirmed durable save", rec.Body.String())
	}
	key := xlsx.NomenclaturePropertyKey("", "Герметики", "Длинное наименование товара для проверки сохранения 0", "Склад Мир")
	request(app, http.MethodPost, "/api/properties", map[string]any{"properties": map[string]bool{key: false}, "persist": true})
	if _, err := os.Stat(filepath.Join(dir, "Свойства Номенклатуры", "properties.json.bak")); err != nil {
		t.Fatal("backup missing", err)
	}
	restarted := server.New(false)
	restarted.SetSaveDir(dir)
	rec = request(restarted, http.MethodGet, "/api/properties", nil)
	var catalog struct {
		Properties map[string]bool `json:"properties"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &catalog)
	if len(catalog.Properties) != 18000 || catalog.Properties[key] {
		t.Fatal("incremental update did not survive restart")
	}
	rec = request(restarted, http.MethodGet, "/api/properties/export", nil)
	imported, err := xlsx.ParsePropertiesXLSX(rec.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, checked := range imported {
		if checked {
			count++
		}
	}
	if len(imported) != 18000 || count != 8999 {
		t.Fatal("export lost marks", len(imported), count)
	}
}
