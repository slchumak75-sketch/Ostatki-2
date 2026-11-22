package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Батч-70: пользовательские настройки путей сохранения и почты.
// Хранятся отдельным JSON в каталоге конфигурации программы
// (в тестах — внутри SetSaveDir), отдельно от свойств номенклатуры:
// смена папки ведомостей не должна переносить свойства и эталон.

type mailSettings struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	From     string `json:"from"`
	UseTLS   bool   `json:"useTLS"`
}

type userSettings struct {
	WorkbookDir       string              `json:"workbookDir,omitempty"`
	EtalonDir         string              `json:"etalonDir,omitempty"`
	Mail              mailSettings        `json:"mail"`
	SupplierEmails    map[string][]string `json:"supplierEmails,omitempty"`
	LastSupplierEmail map[string]string   `json:"lastSupplierEmail,omitempty"`
}

func (s *AppServer) userSettingsPath() string {
	if s.customSaveDir != "" {
		return filepath.Join(s.customSaveDir, "user-settings.json")
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "Ostatki2", "user-settings.json")
}

// Вызывается только при удержанном settingsMu.
func (s *AppServer) loadUserSettingsLocked() {
	if s.settingsLoaded {
		return
	}
	s.settingsLoaded = true
	path := s.userSettingsPath()
	if path == "" {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var loaded userSettings
	if json.Unmarshal(raw, &loaded) == nil {
		s.settings = loaded
	}
}

// Вызывается только при удержанном settingsMu.
func (s *AppServer) persistUserSettingsLocked() {
	path := s.userSettingsPath()
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	raw, err := json.MarshalIndent(s.settings, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(path, raw, 0o600)
}

func (s *AppServer) workbookDirSetting() string {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	s.loadUserSettingsLocked()
	return strings.TrimSpace(s.settings.WorkbookDir)
}

func (s *AppServer) etalonDirSetting() string {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	s.loadUserSettingsLocked()
	return strings.TrimSpace(s.settings.EtalonDir)
}

func supplierEmailKey(supplier, warehouse string) string {
	return strings.TrimSpace(supplier) + "|" + strings.TrimSpace(warehouse)
}

func (s *AppServer) handleSavePaths(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		workbook := s.SaveDir()
		etalon := s.etalonDirSetting()
		if etalon == "" {
			s.mu.RLock()
			dir, err := s.outputDirLocked("Эталон")
			s.mu.RUnlock()
			if err == nil {
				etalon = dir
			}
		}
		writeJSON(w, 200, map[string]any{
			"workbookDir":    workbook,
			"etalonDir":      etalon,
			"workbookCustom": s.workbookDirSetting() != "",
			"etalonCustom":   s.etalonDirSetting() != "",
		})
	case http.MethodPost:
		var req struct {
			WorkbookDir string `json:"workbookDir"`
			EtalonDir   string `json:"etalonDir"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeError(w, 400, "некорректный запрос путей сохранения")
			return
		}
		for _, dir := range []string{strings.TrimSpace(req.WorkbookDir), strings.TrimSpace(req.EtalonDir)} {
			if dir == "" {
				continue
			}
			if !filepath.IsAbs(dir) {
				writeError(w, 400, "Путь должен быть полным (с диском): "+dir)
				return
			}
			if err := os.MkdirAll(dir, 0o755); err != nil || !isWritableDir(dir) {
				writeError(w, 400, "Папка недоступна для записи: "+dir)
				return
			}
		}
		s.settingsMu.Lock()
		s.loadUserSettingsLocked()
		s.settings.WorkbookDir = strings.TrimSpace(req.WorkbookDir)
		s.settings.EtalonDir = strings.TrimSpace(req.EtalonDir)
		s.persistUserSettingsLocked()
		s.settingsMu.Unlock()
		writeJSON(w, 200, map[string]any{"workbookDir": s.SaveDir(), "etalonDir": s.etalonDirSetting(), "saved": true})
	default:
		writeError(w, 405, "требуется GET или POST")
	}
}

func (s *AppServer) handleMailSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.settingsMu.Lock()
		s.loadUserSettingsLocked()
		mail := s.settings.Mail
		s.settingsMu.Unlock()
		writeJSON(w, 200, map[string]any{
			"host": mail.Host, "port": mail.Port, "username": mail.Username,
			"from": mail.From, "useTLS": mail.UseTLS,
			"hasPassword": mail.Password != "",
			"configured":  strings.TrimSpace(mail.Host) != "" && strings.TrimSpace(mail.Username) != "",
		})
	case http.MethodPost:
		var req mailSettings
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeError(w, 400, "некорректные настройки почты")
			return
		}
		s.settingsMu.Lock()
		s.loadUserSettingsLocked()
		password := s.settings.Mail.Password
		if strings.TrimSpace(req.Password) != "" {
			password = req.Password
		}
		s.settings.Mail = mailSettings{
			Host: strings.TrimSpace(req.Host), Port: req.Port,
			Username: strings.TrimSpace(req.Username), Password: password,
			From: strings.TrimSpace(req.From), UseTLS: req.UseTLS,
		}
		s.persistUserSettingsLocked()
		s.settingsMu.Unlock()
		writeJSON(w, 200, map[string]any{"saved": true})
	default:
		writeError(w, 405, "требуется GET или POST")
	}
}

func (s *AppServer) handleSupplierEmails(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "требуется GET")
		return
	}
	key := supplierEmailKey(r.URL.Query().Get("supplier"), r.URL.Query().Get("warehouse"))
	s.settingsMu.Lock()
	s.loadUserSettingsLocked()
	emails := append([]string{}, s.settings.SupplierEmails[key]...)
	last := s.settings.LastSupplierEmail[key]
	s.settingsMu.Unlock()
	writeJSON(w, 200, map[string]any{"emails": emails, "last": last})
}
