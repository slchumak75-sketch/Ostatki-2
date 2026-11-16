package server

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// handleImportOrder — «Загрузить заказ» (батч-36): принимает файл заказа
// (выгрузка «Заказ поставщику»), сопоставляет строки с текущей ведомостью
// (артикул + склад, при пустом артикуле — наименование + склад; названия
// складов из выгрузки переводятся во внутренние) и перезаписывает значения
// столбца «Заказ» как ручной ввод.
func (s *AppServer) handleImportOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()
	if err := r.ParseMultipartForm(256 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "ошибка чтения формы: "+err.Error())
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "не передан файл заказа: "+err.Error())
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка чтения потока: "+err.Error())
		return
	}
	rows, err := xlsx.ParseOrderImportBytes(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	s.mu.Lock()
	if s.wb == nil {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "файл Excel не загружен — сначала загрузите ведомость")
		return
	}
	startEpoch := s.epoch.Load()

	// Индексы ведомости: склад+артикул и склад+наименование.
	type idKey struct{ wh, id string }
	bySKU := make(map[idKey]int, len(s.wb.Items))
	byName := make(map[idKey][]int, len(s.wb.Items))
	norm := func(v string) string {
		return strings.ToLower(strings.Join(strings.Fields(v), " "))
	}
	for _, it := range s.wb.Items {
		wh := norm(it.Warehouse)
		if sku := norm(it.SKU); sku != "" {
			bySKU[idKey{wh, sku}] = it.ExcelRow
		}
		if nm := norm(it.Name); nm != "" {
			k := idKey{wh, nm}
			byName[k] = append(byName[k], it.ExcelRow)
		}
	}

	applied, cleared := 0, 0
	var unmatched []string
	seenRow := make(map[int]bool)
	for _, row := range rows {
		wh := norm(xlsx.InternalWarehouseName(row.Warehouse))
		var target int
		if row.SKU != "" {
			if excelRow, ok := bySKU[idKey{wh, norm(row.SKU)}]; ok {
				target = excelRow
			}
		}
		if target == 0 && row.Name != "" {
			if candidates := byName[idKey{wh, norm(row.Name)}]; len(candidates) > 0 {
				target = candidates[0]
			}
		}
		if target == 0 || seenRow[target] {
			if len(unmatched) < 10 && !seenRow[target] {
				label := row.SKU
				if label == "" {
					label = row.Name
				}
				unmatched = append(unmatched, fmt.Sprintf("%s (%s): нет в ведомости", label, row.Warehouse))
			}
			continue
		}
		seenRow[target] = true
		if row.Qty > 0 {
			s.overrides[target] = row.Qty
			applied++
		} else {
			if _, had := s.overrides[target]; had {
				cleared++
			}
			delete(s.overrides, target)
		}
	}

	wb := s.wb
	params := s.params
	excludedRows := s.orderExclusionsLocked(wb)
	overridesCopy := make(map[int]int, len(s.overrides))
	for k, v := range s.overrides {
		overridesCopy[k] = v
	}
	s.mu.Unlock()

	rep := forecast.CalculateExplicit(wb, params, overridesCopy, excludedRows)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.epoch.Load() != startEpoch || s.wb == nil {
		env := s.buildStateEnvelopeLocked()
		env.ImportSummary = &importSummary{Applied: applied, Cleared: cleared, Unmatched: unmatched, Total: len(rows)}
		writeJSONForRequest(w, r, http.StatusOK, env)
		return
	}
	s.report = rep
	env := s.buildStateEnvelopeLocked()
	env.ImportSummary = &importSummary{Applied: applied, Cleared: cleared, Unmatched: unmatched, Total: len(rows)}
	writeJSONForRequest(w, r, http.StatusOK, env)
}
