package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Свойства не зависят от текущей ведомости и не очищаются вместе с базой.
// В памяти хранятся также false, чтобы снятая отметка не восстановилась из старой базы.
func (s *AppServer) propertiesDirLocked() (string, error) {
	if s.customSaveDir != "" {
		return filepath.Join(s.customSaveDir, "Свойства Номенклатуры"), nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "Ostatki2", "properties"), nil
}
func (s *AppServer) handleProperties(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeError(w, 405, "требуется GET или POST")
		return
	}
	var req struct {
		Properties map[string]bool `json:"properties"`
		Save       bool            `json:"save"`
	}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req); err != nil {
			writeError(w, 400, "ошибка чтения свойств")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.propertiesDirLocked()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	latest := filepath.Join(dir, "properties.json")
	if !s.propertiesLoaded {
		s.properties = make(map[string]bool)
		raw, err := os.ReadFile(latest)
		if err != nil && !os.IsNotExist(err) {
			writeError(w, 500, "не удалось прочитать свойства: "+err.Error())
			return
		}
		if err == nil {
			if err := json.Unmarshal(raw, &s.properties); err != nil {
				writeError(w, 500, "файл свойств повреждён: "+err.Error())
				return
			}
		}
		if s.properties == nil {
			s.properties = make(map[string]bool)
		}
		s.propertiesLoaded = true
	}
	for key, value := range req.Properties {
		s.properties[key] = value
	}
	name := ""
	if req.Save {
		if err := os.MkdirAll(dir, 0700); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		raw, err := json.MarshalIndent(s.properties, "", "  ")
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		name = "Свойства Номенклатуры, " + time.Now().Format("02.01.2006, 15：04：05") + ".json"
		for _, path := range []string{filepath.Join(dir, name), latest} {
			if err := os.WriteFile(path+".tmp", raw, 0600); err != nil {
				writeError(w, 500, err.Error())
				return
			}
			if err := os.Rename(path+".tmp", path); err != nil {
				writeError(w, 500, err.Error())
				return
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"properties": s.properties, "fileName": name, "directory": dir})
}
