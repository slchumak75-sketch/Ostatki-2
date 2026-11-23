package server_test

import (
	"bytes"
	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSavedColumnWidthsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/column-widths", bytes.NewBufferString(`{"widths":{"itemsTable":[10,20,30]}}`)))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	app2 := server.New(false)
	app2.SetSaveDir(dir)
	rec = httptest.NewRecorder()
	app2.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/column-widths", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `[10,20,30]`) {
		t.Fatal(rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	app2.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/column-widths", bytes.NewBufferString(`{"widths":{"itemsTable":[-1]}}`)))
	if rec.Code != 400 {
		t.Fatal("invalid widths accepted")
	}
}

// Б78: клиент отправляет ширины всех таблиц плюс служебный флаг
// __plusFirst — раньше сервер такой запрос отклонял (400), и файл
// с ширинами не писался вообще.
func TestColumnWidthsClientPayloadAccepted(t *testing.T) {
	dir := t.TempDir()
	app := server.New(false)
	app.SetSaveDir(dir)
	payload := `{"widths":{"itemsTable":[10,20],"suppliersTable":[30,40],"overstockTable":[50,60],"orderPreviewTable":[70,80],"__plusFirst":true}}`
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/column-widths", bytes.NewBufferString(payload)))
	if rec.Code != 200 {
		t.Fatal(rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/column-widths", nil))
	body := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(body, `"overstockTable":[50,60]`) || !strings.Contains(body, `"orderPreviewTable":[70,80]`) || !strings.Contains(body, `"__plusFirst":true`) {
		t.Fatal(rec.Code, body)
	}
	rec = httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/column-widths", bytes.NewBufferString(`{"widths":{"unknownTable":[10]}}`)))
	if rec.Code != 400 {
		t.Fatal("unknown table accepted", rec.Code)
	}
}
