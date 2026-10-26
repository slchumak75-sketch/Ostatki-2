package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
)

// handleFillOrder applies algorithm quantities only to the explicitly selected pair.
// Existing orders outside that pair remain fixed, including under a budget cap.
func (s *AppServer) handleFillOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	var req struct {
		Supplier  string  `json:"supplier"`
		Warehouse *string `json:"warehouse"`
		Cancel    bool    `json:"cancel"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil || strings.TrimSpace(req.Supplier) == "" || req.Warehouse == nil {
		writeError(w, http.StatusBadRequest, "выберите одного поставщика и один склад")
		return
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
		if supplier == req.Supplier && it.Warehouse == *req.Warehouse {
			rows[it.ExcelRow] = true
			if !excluded[it.ExcelRow] {
				delete(overrides, it.ExcelRow)
			}
		}
	}
	if len(rows) == 0 {
		writeError(w, http.StatusBadRequest, "в выбранной паре поставщик/склад нет товаров")
		return
	}
	if !req.Cancel {
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
		calculated := forecast.Calculate(s.wb, s.params, calculationOverrides, excluded)
		for _, it := range calculated.Items {
			if rows[it.ExcelRow] && !excluded[it.ExcelRow] {
				overrides[it.ExcelRow] = it.FinalOrderQty
			}
		}
	}
	rep := forecast.CalculateExplicit(s.wb, s.params, overrides, excluded)
	s.overrides = overrides
	s.report = rep
	writeJSONForRequest(w, r, http.StatusOK, s.buildStateEnvelopeLocked())
}
