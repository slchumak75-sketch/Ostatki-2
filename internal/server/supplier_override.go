package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
)

// Подмена поставщика в отдельно взятой строке ведомости.
// Значение пишется прямо в книгу (wb.Items), поэтому переживает пересчёты,
// «Сохранить базу» и выгрузки; исходный поставщик запоминается в
// supplierOriginals, чтобы история действий могла вернуть его назад.

type supplierOverrideRequest struct {
	ExcelRow int    `json:"excelRow"`
	Supplier string `json:"supplier"` // пусто = вернуть исходного поставщика строки
}

func (s *AppServer) handleSupplierOverride(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()
	var req supplierOverrideRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "некорректный запрос: "+err.Error())
		return
	}
	req.Supplier = strings.TrimSpace(req.Supplier)

	s.mu.Lock()
	if s.wb == nil || s.report == nil {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "ведомость не загружена")
		return
	}
	idx := -1
	for i := range s.wb.Items {
		if s.wb.Items[i].ExcelRow == req.ExcelRow {
			idx = i
			break
		}
	}
	if idx < 0 {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "неверная строка ведомости")
		return
	}
	changed := false
	if req.Supplier == "" {
		// Возврат исходного поставщика строки.
		if original, tracked := s.supplierOriginals[req.ExcelRow]; tracked {
			s.wb.Items[idx].Supplier = original
			delete(s.supplierOriginals, req.ExcelRow)
			changed = true
		}
	} else if req.Supplier != s.wb.Items[idx].Supplier {
		original, tracked := s.supplierOriginals[req.ExcelRow]
		if !tracked {
			original = s.wb.Items[idx].Supplier
		}
		if req.Supplier == original {
			// Возврат к исходному поставщику через выбор из списка.
			s.wb.Items[idx].Supplier = original
			delete(s.supplierOriginals, req.ExcelRow)
		} else {
			if s.supplierOriginals == nil {
				s.supplierOriginals = make(map[int]string)
			}
			s.supplierOriginals[req.ExcelRow] = original
			s.wb.Items[idx].Supplier = req.Supplier
		}
		changed = true
	}
	if !changed {
		env := s.buildStateEnvelopeLocked()
		s.mu.Unlock()
		writeJSONForRequest(w, r, http.StatusOK, env)
		return
	}
	overridesCopy := make(map[int]int, len(s.overrides))
	for k, v := range s.overrides {
		overridesCopy[k] = v
	}
	wb := s.wb
	params := s.params
	excludedRows := s.orderExclusionsLocked(wb)
	s.mu.Unlock()

	rep := forecast.CalculateExplicit(wb, params, overridesCopy, excludedRows)

	s.mu.Lock()
	s.report = rep
	s.epoch.Add(1)
	env := s.buildStateEnvelopeLocked()
	s.mu.Unlock()
	writeJSONForRequest(w, r, http.StatusOK, env)
}

// applySupplierSubstitutionsLocked синхронизирует книгу с набором подмен
// (используется восстановлением истории): сначала все подменённые строки
// возвращаются к исходным поставщикам, затем применяются подмены снимка.
func (s *AppServer) applySupplierSubstitutionsLocked(subs map[int]supplierSubstitution) bool {
	for row := range s.supplierOriginals {
		if idx := s.indexOfExcelRowLocked(row); idx >= 0 {
			s.wb.Items[idx].Supplier = s.supplierOriginals[row]
		}
	}
	s.supplierOriginals = make(map[int]string, len(subs))
	for row, sub := range subs {
		idx := s.indexOfExcelRowLocked(row)
		if idx < 0 {
			return false
		}
		if sub.Original == "" && sub.Current == "" {
			return false
		}
		s.wb.Items[idx].Supplier = sub.Current
		s.supplierOriginals[row] = sub.Original
	}
	return true
}

func (s *AppServer) indexOfExcelRowLocked(excelRow int) int {
	for i := range s.wb.Items {
		if s.wb.Items[i].ExcelRow == excelRow {
			return i
		}
	}
	return -1
}

// supplierOriginalsCopyLocked возвращает копию карты исходных поставщиков
// подменённых строк (nil безопасно превращается в пустую карту).
func (s *AppServer) supplierOriginalsCopyLocked() map[int]string {
	copy := make(map[int]string, len(s.supplierOriginals))
	for row, original := range s.supplierOriginals {
		copy[row] = original
	}
	return copy
}
