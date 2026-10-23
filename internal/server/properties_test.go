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
