package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
)

// Stable on-disk settings: desktop launches use a new HTTP port, so browser storage alone is insufficient.
func (s *AppServer) handleColumnWidths(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeError(w, 405, "требуется GET или POST")
		return
	}
	var req struct {
		Widths map[string][]float64 `json:"widths"`
	}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeError(w, 400, "неверные ширины столбцов")
			return
		}
		for key, widths := range req.Widths {
			if (key != "itemsTable" && key != "suppliersTable") || len(widths) == 0 || len(widths) > 64 {
				writeError(w, 400, "неверная таблица")
				return
			}
			for _, v := range widths {
				if v <= 0 || v > 100000 {
					writeError(w, 400, "неверная ширина")
					return
				}
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir, err := s.propertiesDirLocked()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	path := filepath.Join(dir, "column-widths.json")
	if r.Method == http.MethodPost {
		if err := os.MkdirAll(dir, 0700); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		raw, err := json.Marshal(req)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if err := os.WriteFile(path+".tmp", raw, 0600); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if err := os.Rename(path+".tmp", path); err != nil {
			writeError(w, 500, err.Error())
			return
		}
	} else {
		raw, err := os.ReadFile(path)
		if err != nil && !os.IsNotExist(err) {
			writeError(w, 500, err.Error())
			return
		}
		if err == nil {
			if err := json.Unmarshal(raw, &req); err != nil {
				writeError(w, 500, "повреждены настройки ширины столбцов")
				return
			}
		}
	}
	if req.Widths == nil {
		req.Widths = map[string][]float64{}
	}
	writeJSON(w, 200, req)
}
