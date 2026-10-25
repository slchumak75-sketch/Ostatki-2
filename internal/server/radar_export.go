package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func (s *AppServer) handleExportRadar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	var req struct {
		ExcelRows []int `json:"excelRows"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&req); err != nil {
		writeError(w, 400, "некорректная выборка радара")
		return
	}
	if len(req.ExcelRows) == 0 {
		writeError(w, 400, "В радаре нет позиций для выгрузки")
		return
	}
	s.mu.RLock()
	if s.report == nil {
		s.mu.RUnlock()
		writeError(w, 400, "Сначала загрузите ведомость")
		return
	}
	byRow := make(map[int]model.CalculatedItem, len(s.report.Items))
	for _, it := range s.report.Items {
		if it.IsOverstock {
			byRow[it.ExcelRow] = it
		}
	}
	s.mu.RUnlock()
	items := make([]model.CalculatedItem, 0, len(req.ExcelRows))
	seen := map[int]bool{}
	for _, id := range req.ExcelRows {
		it, ok := byRow[id]
		if !ok {
			writeError(w, 400, "Выборка радара изменилась. Обновите ведомость и повторите выгрузку")
			return
		}
		if !seen[id] {
			items = append(items, it)
			seen[id] = true
		}
	}
	raw, err := xlsx.GenerateRadarXLSX(items)
	if err != nil {
		writeError(w, 500, "Не удалось сформировать Excel радара: "+err.Error())
		return
	}
	sendXLSXAttachment(w, "Радар неликвидов, "+time.Now().Format("02.01.2006")+".xlsx", raw)
}
