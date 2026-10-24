package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
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
	return filepath.Join(dir, "Ostatki2", "properties-v5"), nil
}
func (s *AppServer) loadPropertiesLocked(latest string) error {
	if !s.propertiesLoaded {
		s.properties = make(map[string]bool)
		s.nomenclature = map[string]model.NomenclatureRecord{}
		s.etalon = map[string]model.NomenclatureRecord{}
		s.etalonSavedAt = ""
		raw, err := os.ReadFile(latest)
		if os.IsNotExist(err) && s.customSaveDir == "" {
			// Read-only migration: never rewrite Variant 4's catalog.
			raw, err = os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(latest)), "properties", "properties.json"))
		}
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("не удалось прочитать свойства: %w", err)
		}
		if err == nil {
			catalog, err := xlsx.DecodeNomenclatureCatalog(raw)
			if err != nil {
				return fmt.Errorf("файл свойств повреждён: %w", err)
			}
			s.properties = catalog.Properties
			s.nomenclature = catalog.Nomenclature
		}
		if raw, err := os.ReadFile(filepath.Join(filepath.Dir(latest), "etalon.json")); err == nil {
			catalog, err := xlsx.DecodeNomenclatureCatalog(raw)
			if err != nil {
				return fmt.Errorf("эталон повреждён: %w", err)
			}
			s.etalon = catalog.Nomenclature
			s.etalonSavedAt = catalog.SavedAt
		} else if !os.IsNotExist(err) {
			return err
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
		Persist    bool            `json:"persist"`
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
	wasLoaded := s.propertiesLoaded
	if err := s.loadPropertiesLocked(latest); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	changed := !wasLoaded
	for _, key := range req.RemoveKeys {
		if _, ok := s.properties[key]; ok {
			changed = true
		}
		delete(s.properties, key)
		delete(s.nomenclature, key)
	}
	for key, value := range req.Properties {
		if prev, ok := s.properties[key]; !ok || prev != value {
			changed = true
		}
		s.properties[key] = value
	}
	if changed && s.wb != nil {
		s.epoch.Add(1)
		s.report = forecast.Calculate(s.wb, s.params, s.overrides, s.orderExclusionsLocked(s.wb))
	}
	name := ""
	if req.Persist && !req.Save {
		if err := s.persistPropertiesLocked(dir); err != nil {
			writeError(w, 500, "Не удалось записать свойства в "+dir+": "+err.Error())
			return
		}
	}
	if req.Save {
		name, err = s.savePropertiesLocked(dir)
		if err != nil {
			writeError(w, 500, "Не удалось сохранить свойства в "+dir+": "+err.Error())
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	result := map[string]any{"fileName": name, "directory": dir, "persisted": req.Persist || req.Save, "markedCount": countMarkedProperties(s.properties)}
	if r.Method == http.MethodGet || (!req.Persist && !req.Save) {
		result["properties"] = s.properties
		result["nomenclature"] = s.catalogLocked().Nomenclature
		result["etalonLoaded"] = len(s.etalon) > 0
		result["etalonFileName"] = etalonFileName(s.etalonSavedAt)
	}
	if changed && s.wb != nil {
		result["state"] = s.buildStateEnvelopeLocked()
	}
	_ = json.NewEncoder(w).Encode(result)
}

func countMarkedProperties(props map[string]bool) int {
	n := 0
	for _, v := range props {
		if v {
			n++
		}
	}
	return n
}

// Flush the temporary file before replacement, then verify the committed bytes.
// A unique temp name also avoids collisions with other running copies of the app.
func writeVerifiedProperties(path string, raw []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".properties-*.tmp")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(temp, path); err != nil {
		return err
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(stored, raw) {
		return fmt.Errorf("проверка записи файла не пройдена")
	}
	return nil
}

func (s *AppServer) persistPropertiesLocked(dir string) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s.catalogLocked(), "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "properties.json")
	if old, err := os.ReadFile(path); err == nil && json.Valid(old) && !bytes.Equal(old, raw) {
		if err := writeVerifiedProperties(path+".bak", old); err != nil {
			return err
		}
	}
	return writeVerifiedProperties(path, raw)
}

// Manual saves additionally create a dated snapshot; incremental saves only update the catalog.
func (s *AppServer) savePropertiesLocked(dir string) (string, error) {
	if err := s.persistPropertiesLocked(dir); err != nil {
		return "", err
	}
	raw, err := json.MarshalIndent(s.catalogLocked(), "", "  ")
	if err != nil {
		return "", err
	}
	name := "Свойства Номенклатуры, " + time.Now().Format("02.01.2006, 15：04：05") + ".json"
	if err := writeVerifiedProperties(filepath.Join(dir, name), raw); err != nil {
		return "", err
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
	records := s.catalogLocked().Nomenclature
	s.mu.Unlock()
	raw, err := xlsx.GenerateNomenclatureXLSX(records)
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
	f, header, err := r.FormFile("file")
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
	var imported map[string]model.NomenclatureRecord
	var marks map[string]bool
	if strings.HasSuffix(strings.ToLower(header.Filename), ".json") {
		var c model.NomenclatureCatalog
		c, err = xlsx.DecodeNomenclatureCatalog(raw)
		imported = c.Nomenclature
		marks = c.Properties
	} else {
		imported, err = xlsx.ParseNomenclatureXLSX(raw)
		marks = map[string]bool{}
		for k, v := range imported {
			marks[k] = v.Checked
		}
	}
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
		s.nomenclature[k] = v
	}
	for k, v := range marks {
		s.properties[k] = v
	}
	if s.wb != nil {
		s.epoch.Add(1)
		s.report = forecast.Calculate(s.wb, s.params, s.overrides, s.orderExclusionsLocked(s.wb))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"properties": s.properties, "nomenclature": s.catalogLocked().Nomenclature, "imported": len(marks), "state": s.buildStateEnvelopeLocked()})
}

// Caller holds at least s.mu.RLock. Catalog entries are scoped to warehouse + nomenclature.
func (s *AppServer) orderExclusionsLocked(wb *model.WorkbookData) map[int]bool {
	rows := map[int]bool{}
	if wb != nil {
		for _, it := range wb.Items {
			if s.properties[xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)] {
				rows[it.ExcelRow] = true
			}
		}
	}
	return rows
}

func (s *AppServer) orderExclusions(wb *model.WorkbookData) map[int]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if dir, err := s.propertiesDirLocked(); err == nil {
		if err := s.loadPropertiesLocked(filepath.Join(dir, "properties.json")); err != nil {
			fmt.Fprintf(os.Stderr, "Чтение свойств: %v\n", err)
		}
	}
	return s.orderExclusionsLocked(wb)
}
