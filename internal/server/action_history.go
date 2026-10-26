package server

import (
	"encoding/json"
	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"net/http"
)

type actionHistorySnapshot struct {
	WorkbookID      uint64               `json:"workbookId"`
	Params          model.ForecastParams `json:"params"`
	Overrides       map[int]int          `json:"overrides"`
	Properties      map[string]bool      `json:"properties"`
	Suppliers       []string             `json:"suppliers"`
	SelectionActive bool                 `json:"selectionActive"`
}

// History restores working data only, never the frozen reference or workbook.
func (s *AppServer) handleActionHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeError(w, 405, "требуется GET или POST")
		return
	}
	var snap actionHistorySnapshot
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&snap); err != nil {
			writeError(w, 400, "неверное состояние действия")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wb == nil || s.report == nil {
		writeError(w, 409, "ведомость не загружена")
		return
	}
	if r.Method == http.MethodGet {
		props := s.catalogLocked().Properties
		writeJSON(w, 200, actionHistorySnapshot{WorkbookID: s.historyWorkbookID.Load(), Params: s.params, Overrides: s.overrides, Properties: props, Suppliers: s.sortedSelectedSuppliersLocked(), SelectionActive: s.supplierSelectionActive})
		return
	}
	if snap.WorkbookID != s.historyWorkbookID.Load() {
		writeError(w, 409, "ведомость изменилась; история недействительна")
		return
	}
	valid := map[int]bool{}
	for _, it := range s.wb.Items {
		valid[it.ExcelRow] = true
	}
	for row, qty := range snap.Overrides {
		if !valid[row] || qty < 0 {
			writeError(w, 400, "неверная строка заказа")
			return
		}
	}
	if snap.Properties == nil || snap.Overrides == nil {
		writeError(w, 400, "неполное состояние действия")
		return
	}
	oldProps, oldRecords, oldReport := s.properties, s.nomenclature, s.report
	records := make(map[string]model.NomenclatureRecord, len(s.nomenclature))
	for key, value := range s.nomenclature {
		value.Checked = snap.Properties[key]
		records[key] = value
	}
	props := make(map[string]bool, len(s.properties)+len(snap.Properties))
	for key := range s.properties {
		props[key] = false
	}
	for key, value := range snap.Properties {
		props[key] = value
	}
	s.properties = props
	s.nomenclature = records
	params := forecast.NormalizeParams(snap.Params)
	s.report = forecast.CalculateExplicit(s.wb, params, snap.Overrides, s.orderExclusionsLocked(s.wb))
	dir, err := s.propertiesDirLocked()
	if err == nil {
		err = s.persistPropertiesLocked(dir)
	}
	if err != nil {
		s.properties = oldProps
		s.nomenclature = oldRecords
		s.report = oldReport
		writeError(w, 500, "не удалось сохранить отмену действия: "+err.Error())
		return
	}
	s.params = params
	s.overrides = snap.Overrides
	s.supplierSelectionActive = snap.SelectionActive
	s.selectedSuppliers = map[string]bool{}
	for _, supplier := range snap.Suppliers {
		s.selectedSuppliers[supplier] = true
	}
	s.epoch.Add(1)
	writeJSON(w, 200, map[string]any{"state": s.buildStateEnvelopeLocked(), "properties": s.properties, "nomenclature": s.catalogLocked().Nomenclature})
}
