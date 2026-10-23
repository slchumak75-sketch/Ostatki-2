package server

import (
	"encoding/json"
	"fmt"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
	"io"
	"net/http"
	"net/url"
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
func (s *AppServer) loadPropertiesLocked(latest string) error {
	if !s.propertiesLoaded {
		s.properties = make(map[string]bool)
		raw, err := os.ReadFile(latest)
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("не удалось прочитать свойства: %w", err)
		}
		if err == nil {
			if err := json.Unmarshal(raw, &s.properties); err != nil {
				return fmt.Errorf("файл свойств повреждён: %w", err)
			}
		}
		if s.properties == nil {
			s.properties = make(map[string]bool)
		}
		s.propertiesLoaded = true
	}

	return nil
}
func (s *AppServer) handleProperties(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeError(w, 405, "требуется GET или POST")
		return
	}
	var req struct {
		Properties map[string]bool `json:"properties"`
		RemoveKeys []string        `json:"removeKeys"`
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
	if err := s.loadPropertiesLocked(latest); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	for _, key := range req.RemoveKeys {
		delete(s.properties, key)
	}
	for key, value := range req.Properties {
		s.properties[key] = value
	}
	name := ""
	if req.Save {
		name, err = s.savePropertiesLocked(dir)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"properties": s.properties, "fileName": name, "directory": dir})
}

// Caller holds s.mu; no periodic disk writes are performed.
func (s *AppServer) savePropertiesLocked(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	raw, err := json.MarshalIndent(s.properties, "", "  ")
	if err != nil {
		return "", err
	}
	name := "Свойства Номенклатуры, " + time.Now().Format("02.01.2006, 15：04：05") + ".json"
	for _, path := range []string{filepath.Join(dir, name), filepath.Join(dir, "properties.json")} {
		if err := os.WriteFile(path+".tmp", raw, 0600); err != nil {
			return "", err
		}
		if err := os.Rename(path+".tmp", path); err != nil {
			return "", err
		}
	}
	return name, nil
}

func (s *AppServer) handleExportProperties(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "требуется GET")
		return
	}
	s.mu.Lock()
	dir, err := s.propertiesDirLocked()
	if err != nil {
		s.mu.Unlock()
		writeError(w, 500, err.Error())
		return
	}
	if err := s.loadPropertiesLocked(filepath.Join(dir, "properties.json")); err != nil {
		s.mu.Unlock()
		writeError(w, 500, err.Error())
		return
	}
	props := make(map[string]bool, len(s.properties))
	for k, v := range s.properties {
		props[k] = v
	}
	var items []model.CalculatedItem
	if s.report != nil {
		items = append(items, s.report.Items...)
		for _, it := range items {
			key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
			if _, ok := props[key]; !ok {
				props[key] = false
			}
		}
	}
	s.mu.Unlock()
	raw, err := xlsx.GeneratePropertiesXLSX(props, items)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	name := "Свойства Номенклатуры, " + time.Now().Format("02.01.2006, 15：04：05") + ".xlsx"
	w.Header().Set("Content-Disposition", `attachment; filename="properties.xlsx"; filename*=UTF-8''`+url.PathEscape(name))
	_, _ = w.Write(raw)
}
func (s *AppServer) handleImportProperties(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		writeError(w, 400, "ошибка загрузки файла")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "выберите Excel-файл")
		return
	}
	defer f.Close()
	raw, err := io.ReadAll(f)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	imported, err := xlsx.ParsePropertiesXLSX(raw)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.propertiesDirLocked()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err := s.loadPropertiesLocked(filepath.Join(dir, "properties.json")); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	for k, v := range imported {
		s.properties[k] = v
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"properties": s.properties, "imported": len(imported)})
}
