package server

import (
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
	"net/http"
	"path/filepath"
	"time"
)

type etalonComparisonRow struct {
	Reason         string  `json:"reason"`
	EtalonChecked  bool    `json:"etalonChecked"`
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
	exported := []xlsx.ComparisonExportRow{}
	count := 0
	lookup := referenceLookup(s.etalon)
	for _, it := range s.report.Items {
		ref, ok := lookup(it)
		if !ok {
			continue
		}
		row := etalonComparisonRow{EtalonChecked: ref.Checked, ExcelRow: it.ExcelRow, EtalonStock: ref.Stock, EtalonRating: ref.Rating, CurrentRating: it.SalesSegment, StockIncreased: it.ClosingStock > ref.Stock, RatingDropped: ref.Rating > 0 && it.SalesSegment == 0}
		row.Matches = (ref.Checked && row.StockIncreased) || row.RatingDropped
		row.Reason = comparisonReason(row, it.ClosingStock)
		if row.Matches {
			exported = append(exported, xlsx.ComparisonExportRow{Warehouse: it.Warehouse, SKU: it.SKU, Name: it.Name, Reason: row.Reason, OldStock: ref.Stock, Stock: it.ClosingStock, OldRating: ref.Rating, Rating: it.SalesSegment})
			count++
		}
		rows = append(rows, row)
	}
	if r.URL.Path == "/api/etalon/compare/export" {
		raw, err := xlsx.GenerateComparisonXLSX(exported)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		sendXLSXAttachment(w, "Сравнение с эталоном, "+time.Now().Format("02.01.2006")+".xlsx", raw)
		return
	}
	writeJSON(w, 200, map[string]any{"rows": rows, "matchedCount": count})
}
