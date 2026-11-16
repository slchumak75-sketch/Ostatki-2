package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
)

// Батч-38: несохранённые правки ведомости не пропадают при закрытии окна
// «крестиком» или завершении процесса: в этот момент страница уже не отвечает,
// клиентское сохранение не выполняется — ведомость сохраняет сервер при
// завершении (/api/shutdown, сигнал SIGTERM, watchdog отсоединения страницы).

func shutdownSaveTestApp(t *testing.T) *server.AppServer {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "Ведомость с периодом ОК (1).xlsx"))
	if err != nil {
		t.Fatal(err)
	}
	app := server.New(true)
	app.SetSaveDir(t.TempDir())
	if err := app.LoadWorkbookFromBytes(raw, "veedomost-test.xlsx"); err != nil {
		t.Fatal(err)
	}
	return app
}

func postShutdownJSON(t *testing.T, h http.Handler, path string, payload map[string]any) map[string]any {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func savedFileNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".xlsx" {
			names = append(names, e.Name())
		}
	}
	return names
}

func TestShutdownSavesDirtyDatabase(t *testing.T) {
	app := shutdownSaveTestApp(t)

	base, err := firstWorkbookItem(app)
	if err != nil {
		t.Fatal(err)
	}
	h := app.Handler()

	postShutdownJSON(t, h, "/api/override", map[string]any{"excelRow": base.ExcelRow, "value": 7})

	// «Закрытие окна»: страница не отправляет клиентское сохранение.
	postShutdownJSON(t, h, "/api/shutdown", map[string]any{})

	deadline := time.Now().Add(3 * time.Second)
	for len(savedFileNames(app.SaveDir())) == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("файл сохранённой ведомости не создан при закрытии (dir=%s)", app.SaveDir())
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Новый запуск программы: пользователь грузит сохранённую ведомость.
	names := savedFileNames(app.SaveDir())
	env := postShutdownJSON(t, h, "/api/db/load", map[string]any{"fileName": names[0]})
	rep, ok := env["report"].(map[string]any)
	if !ok {
		t.Fatal("в ответе нет report")
	}
	items, _ := rep["items"].([]any)
	found := false
	for _, raw := range items {
		it, _ := raw.(map[string]any)
		if int(it["excelRow"].(float64)) == base.ExcelRow {
			if got := int(it["finalOrderQty"].(float64)); got != 7 {
				t.Fatalf("после загрузки сохранённой ведомости заказ строки %d = %d, ожидалось 7", base.ExcelRow, got)
			}
			found = true
		}
	}
	if !found {
		t.Fatalf("строка %d не найдена после загрузки сохранённой ведомости", base.ExcelRow)
	}
}

func TestShutdownSkipsCleanDatabase(t *testing.T) {
	app := shutdownSaveTestApp(t)
	h := app.Handler()

	// Правок не было — файл сохранённой ведомости создаваться не должен.
	postShutdownJSON(t, h, "/api/shutdown", map[string]any{})
	time.Sleep(400 * time.Millisecond)
	if names := savedFileNames(app.SaveDir()); len(names) != 0 {
		t.Fatalf("без правок создан файл сохранённой ведомости: %v", names)
	}
}
