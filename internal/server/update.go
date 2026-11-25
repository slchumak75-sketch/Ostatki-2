package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Батч-83: обновление программы по файлу, присланному по почте.
// Кнопка «Обновление» (плашка рядом с «Сохранить поля»): пользователь выбирает
// скачанный EXE новой версии — программа сохраняет ведомость (как при выходе),
// закрывается, помощник заменяет EXE и запускает программу снова.
// Если выбран файл установщика (…_Setup.exe) — запускается установщик,
// программа закрывается, дальше работает мастер установки.
// Данные пользователя лежат в %APPDATA%\Ostatki2 и от замены EXE не зависят.

const minUpdateFileSize = 1_000_000

// validateUpdateFile проверяет выбранный файл обновления.
// Возвращает isSetup=true для файла установщика.
func validateUpdateFile(path string) (bool, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return false, fmt.Errorf("файл обновления не выбран")
	}
	info, err := os.Stat(path)
	if err != nil {
		return false, fmt.Errorf("файл обновления не найден: %s", path)
	}
	if info.IsDir() {
		return false, fmt.Errorf("выбрана папка, а нужен файл обновления (EXE)")
	}
	name := strings.ToLower(filepath.Base(path))
	if !strings.HasSuffix(name, ".exe") {
		return false, fmt.Errorf("нужен файл обновления с расширением .exe")
	}
	if !strings.Contains(name, "ostatki") {
		return false, fmt.Errorf("это не файл программы «Остатки»: выберите присланный файл OstatkiZakupki_Variant_….exe")
	}
	if info.Size() < minUpdateFileSize {
		return false, fmt.Errorf("файл слишком маленький для программы — похоже, он скачался не полностью")
	}
	f, err := os.Open(path)
	if err != nil {
		return false, fmt.Errorf("не удалось открыть файл обновления: %w", err)
	}
	defer f.Close()
	var head [2]byte
	if _, err := f.Read(head[:]); err != nil || head[0] != 'M' || head[1] != 'Z' {
		return false, fmt.Errorf("файл не является программой Windows (EXE)")
	}
	return strings.Contains(name, "setup"), nil
}

func (s *AppServer) handlePickFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	if !s.desktopMode {
		writeError(w, 400, "Выбор файла окном доступен в настольной программе")
		return
	}
	var req struct {
		Title string `json:"title"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req)
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "Выберите файл обновления"
	}
	raw, err := pickFileDialog(title)
	if err != nil {
		writeError(w, 500, "Не удалось открыть окно выбора файла: "+err.Error())
		return
	}
	path := strings.TrimSpace(raw)
	if decoded, derr := decodePickedFolderPath(raw); derr == nil && decoded != "" {
		path = decoded
	}
	if path != "" {
		if _, serr := os.Stat(path); serr != nil {
			writeError(w, 500, "Выбранный файл не найден на компьютере: "+path)
			return
		}
	}
	writeJSON(w, 200, map[string]any{"path": path, "cancelled": path == ""})
}

func (s *AppServer) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	if !s.desktopMode {
		writeError(w, 400, "Обновление по файлу доступно в настольной программе")
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, 400, "некорректный запрос обновления")
		return
	}
	isSetup, err := validateUpdateFile(req.Path)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if isSetup {
		if err := launchUpdateInstaller(strings.TrimSpace(req.Path)); err != nil {
			writeError(w, 500, "Не удалось запустить установщик: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"updating": true, "mode": "setup"})
	} else {
		exePath, err := os.Executable()
		if err != nil {
			writeError(w, 500, "Не удалось определить путь текущей программы: "+err.Error())
			return
		}
		if err := stageSelfUpdate(strings.TrimSpace(req.Path), exePath, os.Getpid()); err != nil {
			writeError(w, 500, "Не удалось подготовить обновление: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"updating": true, "mode": "replace"})
	}
	// Ведомость и свойства сохраняются в triggerShutdown — как при обычном выходе.
	go func() {
		time.Sleep(700 * time.Millisecond)
		s.triggerShutdown()
	}()
}
