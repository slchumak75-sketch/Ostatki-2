package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestToolbarLayoutPersistence(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	app := New(false)
	call := func(app *AppServer, method, body string) *httptest.ResponseRecorder {
		r := httptest.NewRecorder()
		app.handleToolbarLayout(r, httptest.NewRequest(method, "/api/toolbar-layout", strings.NewReader(body)))
		return r
	}
	r := call(app, http.MethodPost, `{"order":["btnFillOrder","btnHighlightOrder","btnSaveFields","btnTab_table"],"widths":{"btnFillOrder":180,"btnSaveFields":200},"groups":{"topbar":["btnFillOrder","btnHighlightOrder"],"params-1":["btnSaveFields"],"statement":["btnTab_table"]}}`)
	if r.Code != 200 {
		t.Fatalf("save: %d %s", r.Code, r.Body.String())
	}
	r = call(New(false), http.MethodGet, "")
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"btnFillOrder":180`) || !strings.Contains(r.Body.String(), `"params-1":["btnSaveFields"]`) {
		t.Fatalf("reload: %d %s", r.Code, r.Body.String())
	}
	for _, body := range []string{`{"order":["btnFillOrder"],"widths":{"btnFillOrder":-1}}`, `{"order":["btnFillOrder","btnFillOrder"]}`, `{"order":[],"widths":{"btnFillOrder":180}}`} {
		if r := call(app, http.MethodPost, body); r.Code != 400 {
			t.Fatalf("invalid layout accepted: %s", body)
		}
	}
}
