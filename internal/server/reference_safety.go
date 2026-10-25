package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

func (s *AppServer) referenceTokenLocked() string {
	raw, _ := json.Marshal([]any{s.etalon, s.etalonSavedAt, s.report, s.properties})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (s *AppServer) handleReferencePreview(w http.ResponseWriter, r *http.Request) {
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

	marks, stocks, ratings, added := 0, 0, 0, 0
	lookup := referenceLookup(s.etalon)
	items := []model.CalculatedItem{}
	source := ""
	if s.report != nil {
		items = s.report.Items
		source = s.report.FileName
	}
	for _, it := range items {
		old, ok := lookup(it)
		if !ok {
			added++
			continue
		}
		if old.Checked != s.properties[xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)] {
			marks++
		}
		if old.Stock != it.ClosingStock {
			stocks++
		}
		if old.Rating != it.SalesSegment {
			ratings++
		}
	}
	writeJSON(w, 200, map[string]any{"token": s.referenceTokenLocked(), "savedAt": s.etalonStoredAt, "source": s.etalonSource, "newSource": source, "marks": marks, "stocks": stocks, "ratings": ratings, "added": added, "total": len(items), "hasReference": len(s.etalon) > 0})
}

// Archive the previous frozen snapshot before every explicit replacement.
func archiveReference(dir string) error {
	raw, err := os.ReadFile(filepath.Join(dir, "etalon.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	folder := filepath.Join(dir, "reference-history")
	if err = os.MkdirAll(folder, 0700); err != nil {
		return err
	}
	return writeVerifiedProperties(filepath.Join(folder, time.Now().UTC().Format("20060102T150405.000000000")+".json"), raw)
}
func trimReferenceHistory(dir string) {
	files, _ := filepath.Glob(filepath.Join(dir, "reference-history", "*.json"))
	sort.Strings(files)
	for len(files) > 10 {
		_ = os.Remove(files[0])
		files = files[1:]
	}
}
func (s *AppServer) handleReferenceHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "POST" {
		writeError(w, 405, "требуется GET или POST")
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
	if r.Method == "GET" {
		entries := []map[string]any{}
		files, _ := filepath.Glob(filepath.Join(dir, "reference-history", "*.json"))
		sort.Sort(sort.Reverse(sort.StringSlice(files)))
		for _, path := range files {
			raw, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			var c model.NomenclatureCatalog
			if json.Unmarshal(raw, &c) != nil {
				continue
			}
			entries = append(entries, map[string]any{"id": filepath.Base(path), "savedAt": c.StoredAt, "source": c.FileName, "items": len(c.Nomenclature)})
		}
		writeJSON(w, 200, map[string]any{"entries": entries})
		return
	}
	var req struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req) != nil || filepath.Base(req.ID) != req.ID || !strings.HasSuffix(req.ID, ".json") {
		writeError(w, 400, "неверная версия")
		return
	}
	if req.Token != s.referenceTokenLocked() {
		writeError(w, 409, "Данные изменились. Откройте подтверждение заново.")
		return
	}
	raw, err := os.ReadFile(filepath.Join(dir, "reference-history", req.ID))
	if err != nil {
		writeError(w, 404, "версия не найдена")
		return
	}
	c, err := xlsx.DecodeNomenclatureCatalog(raw)
	if err != nil || len(c.Nomenclature) == 0 {
		writeError(w, 400, "неверный эталон")
		return
	}
	if err = s.commitEtalonLocked(dir, c); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"etalonLoaded": true, "etalonProperties": etalonProperties(s.etalon), "fileName": etalonFileName(s.etalonSavedAt), "savedAt": s.etalonStoredAt})
}

func comparisonReason(row etalonComparisonRow, currentStock float64) string {
	parts := []string{}
	if row.Matches && row.StockIncreased && row.EtalonChecked {
		parts = append(parts, fmt.Sprintf("Остаток вырос: %g → %g", row.EtalonStock, currentStock))
	}
	if row.RatingDropped {
		parts = append(parts, fmt.Sprintf("Рейтинг снизился: %d → 0", row.EtalonRating))
	}
	return strings.Join(parts, "; ")
}
