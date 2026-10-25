package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

func TestEtalonBackupFrozenAndRestorable(t *testing.T) {
	app := New(false)
	app.SetSaveDir(t.TempDir())
	request := func(method, path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, nil))
		return rec
	}
	if rec := request(http.MethodGet, "/api/etalon/backup"); rec.Code != 400 {
		t.Fatal(rec.Code)
	}
	dir, _ := app.propertiesDirLocked()
	items := []model.CalculatedItem{{RawItem: model.RawItem{SKU: "001", Name: "Товар", Warehouse: "Склад", ClosingStock: 7}, SalesSegment: 4}}
	refs := referenceRecords(items, nil)
	var key string
	for k, v := range refs {
		key = k
		v.Checked = true
		refs[k] = v
	}
	if err := app.commitEtalonLocked(dir, model.NomenclatureCatalog{Version: 2, Properties: map[string]bool{key: true}, Nomenclature: refs}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(filepath.Join(dir, "etalon.json"))
	app.properties[key] = false
	app.report = &model.CalculationReport{Items: items}
	rec := request(http.MethodGet, "/api/properties")
	var props struct {
		EtalonLoaded     bool            `json:"etalonLoaded"`
		EtalonProperties map[string]bool `json:"etalonProperties"`
		Properties       map[string]bool `json:"properties"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &props); err != nil {
		t.Fatal(err)
	}
	if !props.EtalonLoaded || !props.EtalonProperties[key] || props.Properties[key] {
		t.Fatal("live and reference marks mixed", rec.Body.String())
	}
	rec = request(http.MethodGet, "/api/etalon/backup")
	if rec.Code != 200 || rec.Header().Get("Content-Disposition") == "" {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var backup model.NomenclatureCatalog
	if err := json.Unmarshal(rec.Body.Bytes(), &backup); err != nil {
		t.Fatal(err)
	}
	if !backup.Properties[key] || !backup.Nomenclature[key].Checked || backup.Nomenclature[key].Stock != 7 || backup.Nomenclature[key].Rating != 4 {
		t.Fatal("backup is not the frozen reference", backup)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "etalon.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("backup changed reference")
	}
	restored := New(false)
	restored.SetSaveDir(t.TempDir())
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "Эталон.json")
	part.Write(rec.Body.Bytes())
	writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/etalon/import", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	result := httptest.NewRecorder()
	restored.Handler().ServeHTTP(result, req)
	if result.Code != 200 {
		t.Fatal(result.Code, result.Body.String())
	}
	if got := restored.etalon[key]; got != refs[key] {
		t.Fatal("JSON roundtrip lost reference", got, refs[key])
	}
}
