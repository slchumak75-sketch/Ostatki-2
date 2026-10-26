package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// handleFillOrder applies algorithm quantities only to the explicitly selected pair.
// Existing orders outside that pair remain fixed, including under a budget cap.
func (s *AppServer) handleFillOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	var req struct {
		Supplier  string                `json:"supplier"`
		Suppliers []string              `json:"suppliers"`
		Warehouse *string               `json:"warehouse"`
		Cancel    bool                  `json:"cancel"`
		Clear     bool                  `json:"clear"`
		Params    *model.ForecastParams `json:"params,omitempty"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || (strings.TrimSpace(req.Supplier) == "" && len(req.Suppliers) == 0) || (req.Warehouse == nil && !req.Clear) {
		writeError(w, http.StatusBadRequest, "выберите поставщиков и один склад")
		return
	}
	if len(req.Suppliers) > 1000 {
		writeError(w, 400, "слишком много поставщиков")
		return
	}
	selected := map[string]bool{}
	if strings.TrimSpace(req.Supplier) != "" {
		selected[strings.TrimSpace(req.Supplier)] = true
	}
	for _, supplier := range req.Suppliers {
		supplier = strings.TrimSpace(supplier)
		if supplier == "" {
			writeError(w, 400, "пустой поставщик")
			return
		}
		selected[supplier] = true
	}
	s.touchHeartbeat()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wb == nil || s.report == nil {
		writeError(w, http.StatusBadRequest, "ведомость не загружена")
		return
	}
	overrides := make(map[int]int, len(s.overrides))
	for row, qty := range s.overrides {
		overrides[row] = qty
	}
	excluded := s.orderExclusionsLocked(s.wb)
	rows := make(map[int]bool)
	for _, it := range s.wb.Items {
		supplier := strings.TrimSpace(it.Supplier)
		if supplier == "" {
			supplier = "(Поставщик не указан)"
		}
		if selected[supplier] && (req.Clear || it.Warehouse == *req.Warehouse) {
			rows[it.ExcelRow] = true
			if req.Clear || !excluded[it.ExcelRow] {
				delete(overrides, it.ExcelRow)
			}
		}
	}
	if len(rows) == 0 {
		writeError(w, http.StatusBadRequest, "в выбранной паре поставщик/склад нет товаров")
		return
	}
	params := s.params
	if req.Params != nil && !req.Clear {
		params = forecast.NormalizeParams(*req.Params)
	}
	if !req.Cancel && !req.Clear {
		// Pin existing orders outside the scope while calculating recommendations.
		// Temporary pins are never saved as manual overrides on unrelated rows.
		calculationOverrides := make(map[int]int, len(overrides)+len(s.report.Items))
		for row, qty := range overrides {
			calculationOverrides[row] = qty
		}
		for _, it := range s.report.Items {
			if !rows[it.ExcelRow] {
				calculationOverrides[it.ExcelRow] = it.FinalOrderQty
			}
		}
		calculated := forecast.Calculate(s.wb, params, calculationOverrides, excluded)
		for _, it := range calculated.Items {
			if rows[it.ExcelRow] && !excluded[it.ExcelRow] {
				overrides[it.ExcelRow] = it.FinalOrderQty
			}
		}
	}
	rep := forecast.CalculateExplicit(s.wb, params, overrides, excluded)
	s.params = params
	s.overrides = overrides
	s.report = rep
	writeJSONForRequest(w, r, http.StatusOK, s.buildStateEnvelopeLocked())
}
