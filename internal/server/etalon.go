package server

import (
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

// Caller holds s.mu. A reference freezes ratings only; stock, sales and order
// calculations still come from the current 1C workbook. It is never autosaved.
func (s *AppServer) etalonReportLocked(report *model.CalculationReport) *model.CalculationReport {
	if report == nil || len(s.etalon) == 0 {
		return report
	}
	// Envelopes may be encoded outside the lock: never mutate a shared report.
	copyReport := *report
	copyReport.Items = append([]model.CalculatedItem(nil), report.Items...)
	report = &copyReport

	for i := range report.Items {
		it := &report.Items[i]
		if r, ok := s.etalon[xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)]; ok {
			it.SalesSegment = r.Rating
			it.SalesSegmentLabel = model.SalesSegmentLabelByCode(r.Rating)
		}
	}
	return report
}

// Capture every warehouse/row, irrespective of filters or the virtual viewport.
// Old catalog rows survive clearing the workbook and loading a different base.
func (s *AppServer) catalogLocked() model.NomenclatureCatalog {
	if s.nomenclature == nil {
		s.nomenclature = map[string]model.NomenclatureRecord{}
	}
	if s.properties == nil {
		s.properties = map[string]bool{}
	}
	report := s.etalonReportLocked(s.report)
	for key, checked := range s.properties {
		r, ok := s.nomenclature[key]
		if !ok {
			var err error
			r, err = xlsx.RecordFromKey(key)
			if err != nil {
				continue
			}
		}
		r.Checked = checked
		s.nomenclature[key] = r
	}
	if report != nil {
		for _, it := range report.Items {
			key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
			s.nomenclature[key] = model.NomenclatureRecord{Warehouse: it.Warehouse, SKU: it.SKU, Name: it.Name, Group: it.Group, Checked: s.properties[key], Rating: it.SalesSegment, Stock: it.ClosingStock}
		}
	}
	c := model.NomenclatureCatalog{Version: 2, Properties: map[string]bool{}, Nomenclature: map[string]model.NomenclatureRecord{}}
	for key, checked := range s.properties {
		c.Properties[key] = checked
	}
	for key, r := range s.nomenclature {
		c.Nomenclature[key] = r
		c.Properties[key] = r.Checked
	}
	return c
}

func (s *AppServer) handleSaveEtalon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.propertiesDirLocked()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err = s.loadPropertiesLocked(filepath.Join(dir, "properties.json")); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if s.report == nil || len(s.report.Items) == 0 {
		writeError(w, 400, "Сначала загрузите ведомость 1С для сохранения текущего эталона")
		return
	}
	if err = s.persistPropertiesLocked(dir); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	// Freeze only the currently loaded 1C base. Old checkbox-only records do
	// not have known ratings/stock and must not become fabricated zero ratings.
	catalog := model.NomenclatureCatalog{SavedAt: time.Now().Format(time.RFC3339), Version: 2, Properties: map[string]bool{}, Nomenclature: map[string]model.NomenclatureRecord{}}
	for _, it := range s.etalonReportLocked(s.report).Items {
		key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
		record := model.NomenclatureRecord{Warehouse: it.Warehouse, SKU: it.SKU, Name: it.Name, Group: it.Group, Checked: s.properties[key], Rating: it.SalesSegment, Stock: it.ClosingStock}
		catalog.Properties[key] = record.Checked
		catalog.Nomenclature[key] = record
	}
	raw, err := xlsx.GenerateNomenclatureXLSX(catalog.Nomenclature)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	name := etalonFileName(catalog.SavedAt)
	if err = writeVerifiedProperties(filepath.Join(dir, name), raw); err != nil {
		writeError(w, 500, "Эталон не сохранён: "+err.Error())
		return
	}
	if err = s.commitEtalonLocked(dir, catalog); err != nil {
		writeError(w, 500, "Эталон не активирован: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"fileName": name, "directory": dir, "savedInProgram": true, "state": s.buildStateEnvelopeLocked()})
}

// Only the two explicit reference actions call this function.
func (s *AppServer) commitEtalonLocked(dir string, catalog model.NomenclatureCatalog) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if catalog.SavedAt == "" {
		catalog.SavedAt = time.Now().Format(time.RFC3339)
	}
	raw, err := json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "etalon.json")
	if old, err := os.ReadFile(path); err == nil {
		if err = writeVerifiedProperties(path+".bak", old); err != nil {
			return err
		}
	}
	if err = writeVerifiedProperties(path, raw); err != nil {
		return err
	}
	s.etalon = catalog.Nomenclature
	s.etalonSavedAt = catalog.SavedAt
	return nil
}

func (s *AppServer) handleImportEtalon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		writeError(w, 400, "ошибка загрузки эталона")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, 400, "выберите файл эталона")
		return
	}
	defer f.Close()
	raw, err := io.ReadAll(f)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var catalog model.NomenclatureCatalog
	if strings.HasSuffix(strings.ToLower(header.Filename), ".json") {
		catalog, err = xlsx.DecodeNomenclatureCatalog(raw)
	} else {
		catalog.Version = 2
		catalog.Nomenclature, err = xlsx.ParseNomenclatureXLSX(raw)
		catalog.Properties = map[string]bool{}
		for key, v := range catalog.Nomenclature {
			catalog.Properties[key] = v.Checked
		}
	}
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if len(catalog.Nomenclature) == 0 {
		writeError(w, 400, "В эталоне нет номенклатуры с рейтингом")
		return
	}
	// Legacy five-column files contain no frozen rating: don't silently turn all ratings into zero.
	if !strings.HasSuffix(strings.ToLower(header.Filename), ".json") {
		if legacy, err := xlsx.IsLegacyPropertiesXLSX(raw); err != nil || legacy {
			writeError(w, 400, "Для эталона нужны шесть столбцов, включая Рейтинг и Остаток. Старый файл можно загрузить как свойства.")
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
	if err = s.loadPropertiesLocked(filepath.Join(dir, "properties.json")); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err = s.commitEtalonLocked(dir, catalog); err != nil {
		writeError(w, 500, fmt.Sprintf("Не удалось записать эталон: %v", err))
		return
	}
	for key, v := range catalog.Nomenclature {
		s.nomenclature[key] = v
		s.properties[key] = v.Checked
	}
	// An explicit import is durable, including the reference's checkmarks.
	if err = s.persistPropertiesLocked(dir); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if s.wb != nil {
		s.epoch.Add(1)
		s.report = forecast.Calculate(s.wb, s.params, s.overrides, s.orderExclusionsLocked(s.wb))
	}
	writeJSON(w, 200, map[string]any{"properties": s.properties, "nomenclature": s.catalogLocked().Nomenclature, "state": s.buildStateEnvelopeLocked(), "imported": len(catalog.Nomenclature)})
}

// Export is read-only: even a download must not refresh the saved reference.
func (s *AppServer) handleExportEtalon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "требуется GET")
		return
	}
	s.mu.Lock()
	dir, err := s.propertiesDirLocked()
	if err == nil {
		err = s.loadPropertiesLocked(filepath.Join(dir, "properties.json"))
	}
	name := etalonFileName(s.etalonSavedAt)
	records := map[string]model.NomenclatureRecord{}
	for k, v := range s.etalon {
		records[k] = v
	}
	s.mu.Unlock()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if len(records) == 0 {
		writeError(w, 404, "Сначала сохраните или загрузите эталон")
		return
	}
	raw, err := xlsx.GenerateNomenclatureXLSX(records)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="Etalon.xlsx"; filename*=UTF-8''`+url.PathEscape(name))
	_, _ = w.Write(raw)
}

// Keep the snapshot's original date on export, including after restart.
func etalonFileName(savedAt string) string {
	date, err := time.Parse(time.RFC3339, savedAt)
	if err != nil {
		date = time.Now()
	}
	return "Эталон, " + date.Format("02.01.2006") + ".xlsx"
}
