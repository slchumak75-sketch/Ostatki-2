package server

import (
	"net/http"
	"path/filepath"
)

type etalonComparisonRow struct {
	ExcelRow       int     `json:"excelRow"`
	EtalonStock    float64 `json:"etalonStock"`
	EtalonRating   int     `json:"etalonRating"`
	CurrentRating  int     `json:"currentRating"`
	StockIncreased bool    `json:"stockIncreased"`
	RatingDropped  bool    `json:"ratingDropped"`
	Matches        bool    `json:"matches"`
}

// Read only. Use the real calculated rating, not the frozen display overlay.
// Reference membership is frozen too: live checkbox edits must not change comparison.
func (s *AppServer) handleCompareEtalon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, 405, "требуется GET")
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
		writeError(w, 400, "Сначала загрузите текущую ведомость")
		return
	}
	if len(s.etalon) == 0 {
		writeError(w, 400, "Сначала сохраните или загрузите эталон")
		return
	}
	rows := make([]etalonComparisonRow, 0)
	count := 0
	lookup := referenceLookup(s.etalon)
	for _, it := range s.report.Items {
		ref, ok := lookup(it)
		if !ok {
			continue
		}
		row := etalonComparisonRow{ExcelRow: it.ExcelRow, EtalonStock: ref.Stock, EtalonRating: ref.Rating, CurrentRating: it.SalesSegment, StockIncreased: it.ClosingStock > ref.Stock, RatingDropped: ref.Rating > 0 && it.SalesSegment == 0}
		row.Matches = (ref.Checked && row.StockIncreased) || row.RatingDropped
		if row.Matches {
			count++
		}
		rows = append(rows, row)
	}
	writeJSON(w, 200, map[string]any{"rows": rows, "matchedCount": count})
}
