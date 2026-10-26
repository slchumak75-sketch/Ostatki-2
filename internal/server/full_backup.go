package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// The archive deliberately contains settings, not statement files or executable code.
func (s *AppServer) handleFullBackup(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, 405, "требуется GET")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.propertiesDirLocked()
	if err == nil {
		err = s.loadPropertiesLocked(filepath.Join(dir, "properties.json"))
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	parts := map[string]any{"manifest.json": map[string]any{"version": 1, "application": "Ostatki2", "contains": "reference, working marks, calculation settings, column widths; no workbook"}, "properties.json": s.catalogLocked(), "settings.json": s.params}
	if len(s.etalon) > 0 {
		parts["etalon.json"] = model.NomenclatureCatalog{Version: 2, FileName: s.etalonSource, SavedAt: s.etalonSavedAt, StoredAt: s.etalonStoredAt, Properties: etalonProperties(s.etalon), Nomenclature: s.etalon}
	}
	rawWidths, err := os.ReadFile(filepath.Join(dir, "column-widths.json"))
	if err == nil {
		var widths any
		if json.Unmarshal(rawWidths, &widths) != nil {
			writeError(w, 500, "повреждены ширины столбцов")
			return
		}
		parts["column-widths.json"] = widths
	} else if !os.IsNotExist(err) {
		writeError(w, 500, err.Error())
		return
	}
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for name, value := range parts {
		raw, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		f, err := zw.Create(name)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if _, err = f.Write(raw); err != nil {
			writeError(w, 500, err.Error())
			return
		}
	}
	if err := zw.Close(); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="Ostatki2-backup.zip"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(out.Bytes())
}

func validateWidths(raw []byte) error {
	var data struct {
		Widths map[string][]float64 `json:"widths"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Widths == nil {
		return fmt.Errorf("неверный файл ширин")
	}
	for key, values := range data.Widths {
		if (key != "itemsTable" && key != "suppliersTable") || len(values) == 0 || len(values) > 64 {
			return fmt.Errorf("неверная таблица")
		}
		for _, v := range values {
			if v <= 0 || v > 100000 || math.IsNaN(v) || math.IsInf(v, 0) {
				return fmt.Errorf("неверные ширины")
			}
		}
	}
	return nil
}
func (s *AppServer) handleFullRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, 405, "требуется POST")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	if r.ParseMultipartForm(32<<20) != nil {
		writeError(w, 400, "неверный архив")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "выберите ZIP")
		return
	}
	defer f.Close()
	raw, err := io.ReadAll(f)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil || len(zr.File) > 8 {
		writeError(w, 400, "неверный ZIP")
		return
	}
	allowed := map[string]bool{"manifest.json": true, "etalon.json": true, "properties.json": true, "settings.json": true, "column-widths.json": true}
	files := map[string][]byte{}
	for _, entry := range zr.File {
		if !allowed[entry.Name] || files[entry.Name] != nil || entry.UncompressedSize64 > 16<<20 {
			writeError(w, 400, "неверный состав архива")
			return
		}
		reader, err := entry.Open()
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		data, err := io.ReadAll(io.LimitReader(reader, (16<<20)+1))
		reader.Close()
		if err != nil || len(data) > 16<<20 || !json.Valid(data) {
			writeError(w, 400, "повреждён JSON архива")
			return
		}
		files[entry.Name] = data
	}
	var manifest struct {
		Version     int    `json:"version"`
		Application string `json:"application"`
	}
	if json.Unmarshal(files["manifest.json"], &manifest) != nil || manifest.Version != 1 || manifest.Application != "Ostatki2" {
		writeError(w, 400, "неподдерживаемый архив")
		return
	}
	var selected []string
	if json.Unmarshal([]byte(r.FormValue("selected")), &selected) != nil || len(selected) == 0 || len(selected) > 4 {
		writeError(w, 400, "выберите разделы")
		return
	}
	selectedSet := map[string]bool{}
	var ref, props model.NomenclatureCatalog
	var params model.ForecastParams
	for _, name := range selected {
		data, ok := files[name]
		if !ok || name == "manifest.json" || selectedSet[name] {
			writeError(w, 400, "раздел отсутствует или повторён: "+name)
			return
		}
		selectedSet[name] = true
		switch name {
		case "etalon.json":
			ref, err = xlsx.DecodeNomenclatureCatalog(data)
			if err == nil && len(ref.Nomenclature) == 0 {
				err = fmt.Errorf("пустой эталон")
			}
		case "properties.json":
			props, err = xlsx.DecodeNomenclatureCatalog(data)
		case "settings.json":
			err = json.Unmarshal(data, &params)
			if err == nil && params.HorizonDays <= 0 {
				err = fmt.Errorf("неверные параметры расчёта")
			}
			params = forecast.NormalizeParams(params)
		case "column-widths.json":
			err = validateWidths(data)
		}
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.propertiesDirLocked()
	if err == nil {
		err = s.loadPropertiesLocked(filepath.Join(dir, "properties.json"))
	}
	if err == nil {
		err = os.MkdirAll(dir, 0700)
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if selectedSet["etalon.json"] && r.FormValue("token") != s.referenceTokenLocked() {
		writeError(w, 409, "Данные изменились. Повторите восстановление.")
		return
	}
	// Keep previous file bytes for rollback; validate every selected component before writes.
	old := map[string][]byte{}
	for _, name := range selected {
		data, e := os.ReadFile(filepath.Join(dir, name))
		if e != nil && !os.IsNotExist(e) {
			writeError(w, 500, e.Error())
			return
		}
		old[name] = data
	}
	rollback := func() {
		for _, name := range selected {
			path := filepath.Join(dir, name)
			if old[name] == nil {
				_ = os.Remove(path)
			} else {
				_ = writeVerifiedProperties(path, old[name])
			}
		}
	}
	if selectedSet["etalon.json"] {
		if err = archiveReference(dir); err != nil {
			writeError(w, 500, err.Error())
			return
		}
	}
	for _, name := range selected {
		data := files[name]
		if name == "etalon.json" {
			ref.StoredAt = time.Now().Format(time.RFC3339)
			data, _ = json.Marshal(ref)
		}
		if name == "settings.json" {
			data, _ = json.Marshal(params)
		}
		if err = writeVerifiedProperties(filepath.Join(dir, name), data); err != nil {
			rollback()
			writeError(w, 500, "Восстановление отменено: "+err.Error())
			return
		}
	}
	if selectedSet["etalon.json"] {
		s.etalon = ref.Nomenclature
		s.etalonSavedAt = ref.SavedAt
		s.etalonStoredAt = ref.StoredAt
		s.etalonSource = ref.FileName
		trimReferenceHistory(dir)
	}
	if selectedSet["properties.json"] {
		s.properties = props.Properties
		s.nomenclature = props.Nomenclature
		s.propertiesSavedAt = props.SavedAt
		s.propertiesFileName = props.FileName
	}
	if selectedSet["settings.json"] {
		s.params = params
	}
	s.historyWorkbookID.Add(1)
	if s.wb != nil {
		s.epoch.Add(1)
		s.report = forecast.CalculateExplicit(s.wb, s.params, s.overrides, s.orderExclusionsLocked(s.wb))
	}
	writeJSON(w, 200, map[string]any{"restored": strings.Join(selected, ", ")})
}

func (s *AppServer) preferredParamsLocked() model.ForecastParams {
	dir, err := s.propertiesDirLocked()
	if err != nil {
		return model.DefaultParams()
	}
	raw, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	var p model.ForecastParams
	if err != nil || json.Unmarshal(raw, &p) != nil {
		return model.DefaultParams()
	}
	return forecast.NormalizeParams(p)
}
