package server_test

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func TestPropertiesExcelEndpoints(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	key := xlsx.NomenclaturePropertyKey("000123", "", "")
	raw, err := xlsx.GeneratePropertiesXLSX(map[string]bool{key: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	upload := func(raw []byte) *httptest.ResponseRecorder {
		t.Helper()
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		part, _ := mw.CreateFormFile("file", "properties.xlsx")
		_, _ = part.Write(raw)
		_ = mw.Close()
		req := httptest.NewRequest(http.MethodPost, "/api/properties/import", &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		rec := httptest.NewRecorder()
		app.Handler().ServeHTTP(rec, req)
		return rec
	}
	rec := upload(raw)
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "Свойства Номенклатуры", "properties.json")); !os.IsNotExist(err) {
		t.Fatal("import must not autosave")
	}
	rec = httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/properties/export", nil))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	props, err := xlsx.ParsePropertiesXLSX(rec.Body.Bytes())
	if err != nil || !props[key] {
		t.Fatal(props, err)
	}
	raw, _ = xlsx.GeneratePropertiesXLSX(map[string]bool{key: false}, nil)
	rec = upload(raw)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	if rec = upload([]byte("broken")); rec.Code != 400 {
		t.Fatal("invalid import accepted")
	}
	rec = httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/properties", nil))
	var result struct {
		Properties map[string]bool `json:"properties"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	if value, ok := result.Properties[key]; !ok || value {
		t.Fatal("failed import changed state or false not restored", result)
	}
}
