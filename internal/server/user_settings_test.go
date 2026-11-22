package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
)

// Батч-70: пути сохранения и настройки почты хранятся и применяются.
func TestUserSettingsPathsAndMail(t *testing.T) {
	base := t.TempDir()
	app := server.New(true)
	app.SetSaveDir(base)
	h := app.Handler()

	workbookDir := filepath.Join(base, "Мои ведомости")
	etalonDir := filepath.Join(base, "Мои эталоны")

	// Сохранение путей: папки создаются, GET отдаёт их как действующие.
	rec := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{"workbookDir": workbookDir, "etalonDir": etalonDir})
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/settings/paths", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("POST /api/settings/paths: %d %s", rec.Code, rec.Body.String())
	}
	if got := app.SaveDir(); got != workbookDir {
		t.Fatalf("SaveDir = %q, want %q", got, workbookDir)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings/paths", nil))
	if rec.Code != 200 {
		t.Fatalf("GET /api/settings/paths: %d %s", rec.Code, rec.Body.String())
	}
	var paths struct {
		WorkbookDir    string `json:"workbookDir"`
		EtalonDir      string `json:"etalonDir"`
		WorkbookCustom bool   `json:"workbookCustom"`
		EtalonCustom   bool   `json:"etalonCustom"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &paths); err != nil {
		t.Fatal(err)
	}
	if paths.WorkbookDir != workbookDir || paths.EtalonDir != etalonDir || !paths.WorkbookCustom || !paths.EtalonCustom {
		t.Fatalf("paths = %+v", paths)
	}

	// Относительный путь отклоняется.
	rec = httptest.NewRecorder()
	body, _ = json.Marshal(map[string]any{"workbookDir": "relative/folder", "etalonDir": ""})
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/settings/paths", bytes.NewReader(body)))
	if rec.Code != 400 {
		t.Fatalf("relative path must be rejected: %d %s", rec.Code, rec.Body.String())
	}

	// Настройки почты: пароль не отдаётся обратно, только признак наличия.
	rec = httptest.NewRecorder()
	body, _ = json.Marshal(map[string]any{"host": "smtp.example.com", "port": 465, "username": "user@example.com", "password": "secret", "from": "user@example.com", "useTLS": true})
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/settings/mail", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("POST /api/settings/mail: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings/mail", nil))
	var mailResp struct {
		Host        string `json:"host"`
		Port        int    `json:"port"`
		HasPassword bool   `json:"hasPassword"`
		Configured  bool   `json:"configured"`
		Password    string `json:"password"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &mailResp); err != nil {
		t.Fatal(err)
	}
	if mailResp.Host != "smtp.example.com" || mailResp.Port != 465 || !mailResp.HasPassword || !mailResp.Configured {
		t.Fatalf("mail = %+v", mailResp)
	}
	if mailResp.Password != "" {
		t.Fatal("password must never be returned")
	}

	// Адреса получателей: пустой список до первой отправки.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/supplier-emails?supplier=ABC&warehouse=Мир", nil))
	if rec.Code != 200 {
		t.Fatalf("GET /api/supplier-emails: %d %s", rec.Code, rec.Body.String())
	}
	var emails struct {
		Emails []string `json:"emails"`
		Last   string   `json:"last"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &emails); err != nil {
		t.Fatal(err)
	}
	if len(emails.Emails) != 0 || emails.Last != "" {
		t.Fatalf("emails = %+v", emails)
	}
}
