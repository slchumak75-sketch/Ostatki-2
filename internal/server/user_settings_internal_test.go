package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Батч-72: путь из окна выбора папки декодируется без порчи кириллицы,
// а требование пароля приложения объясняется человеческим текстом.
func TestPickedFolderDecodeAndFriendlyMailError(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString([]byte(`C:\Users\test\OneDrive\Рабочий стол\Эталоны`))
	got, err := decodePickedFolderPath(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if got != `C:\Users\test\OneDrive\Рабочий стол\Эталоны` {
		t.Fatalf("decoded = %q", got)
	}
	if empty, err := decodePickedFolderPath(""); err != nil || empty != "" {
		t.Fatalf("empty decode = %q, %v", empty, err)
	}
	friendly := friendlySMTPError(errors.New("535 5.7.0 NEOBHODIM parol prilozheniya"))
	if friendly == nil || !strings.Contains(friendly.Error(), "ПАРОЛЬ ПРИЛОЖЕНИЯ") {
		t.Fatalf("friendly = %v", friendly)
	}
	other := friendlySMTPError(errors.New("535 5.7.8 authentication failed"))
	if other == nil || !strings.Contains(other.Error(), "ПАРОЛЬ ПРИЛОЖЕНИЯ") {
		t.Fatalf("535 must also map to the hint: %v", other)
	}
}

// Б77: «Конфигурация» сохраняется автоматически: POST /api/params пишет
// параметры в user-settings.json, и свежая ведомость на новом экземпляре
// сервера получает их вместо заводских.
func TestConfigParamsPersistAndRestore(t *testing.T) {
	base := t.TempDir()
	app := New(true)
	app.SetSaveDir(base)
	h := app.Handler()

	body := []byte(`{"horizonDays":33,"leadTimeDays":7,"safetyStockPct":12,"budgetCap":5000,"minSupplierOrder":50,"seasonMode":"hybrid","packMultiple":1}`)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/params", bytes.NewReader(body)))
	if rec.Code != 200 {
		t.Fatalf("POST /api/params: %d %s", rec.Code, rec.Body.String())
	}
	raw, err := os.ReadFile(filepath.Join(base, "user-settings.json"))
	if err != nil {
		t.Fatalf("user-settings.json не записан: %v", err)
	}
	var saved struct {
		Params *struct {
			HorizonDays    int `json:"horizonDays"`
			SafetyStockPct int `json:"safetyStockPct"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &saved); err != nil || saved.Params == nil {
		t.Fatalf("в настройках нет params: %v (%s)", err, raw)
	}
	if saved.Params.HorizonDays != 33 || saved.Params.SafetyStockPct != 12 {
		t.Fatalf("params = %+v", saved.Params)
	}

	app2 := New(true)
	app2.SetSaveDir(base)
	p := app2.preferredParamsLocked()
	if p.HorizonDays != 33 || p.SafetyStockPct != 12 {
		t.Fatalf("восстановленная конфигурация = %+v", p)
	}
}
