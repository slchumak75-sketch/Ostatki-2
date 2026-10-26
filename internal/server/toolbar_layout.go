package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Toolbar preferences live on disk, independently of workbook and desktop port.
func (s *AppServer) handleToolbarLayout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeError(w, 405, "требуется GET или POST")
		return
	}

	var req struct {
		Order  []string            `json:"order"`
		Widths map[string]float64  `json:"widths"`
		Groups map[string][]string `json:"groups,omitempty"`
	}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
			writeError(w, 400, "неверные настройки панели")
			return
		}
		if len(req.Order) > 128 || len(req.Widths) > 128 || len(req.Groups) > 32 {
			writeError(w, 400, "слишком много кнопок")
			return
		}
		seen := map[string]bool{}
		for _, id := range req.Order {
			if !strings.HasPrefix(id, "btn") || len(id) > 100 || seen[id] {
				writeError(w, 400, "неверный идентификатор кнопки")
				return
			}
			seen[id] = true
		}
		grouped := map[string]bool{}
		for key, ids := range req.Groups {
			if (key != "topbar" && key != "statement" && !strings.HasPrefix(key, "params-")) || len(key) > 50 || len(ids) > 128 {
				writeError(w, 400, "неверная группа кнопок")
				return
			}
			for _, id := range ids {
				if !seen[id] || grouped[id] {
					writeError(w, 400, "неверная группа кнопок")
					return
				}
				grouped[id] = true
			}
		}
		for id, width := range req.Widths {
			if !seen[id] || width < 40 || width > 1200 {
				writeError(w, 400, "неверная ширина кнопки")
				return
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
	path := filepath.Join(dir, "toolbar-layout.json")
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
				writeError(w, 500, "повреждены настройки панели")
				return
			}
		}
	}
	if req.Widths == nil {
		req.Widths = map[string]float64{}
	}
	writeJSON(w, 200, req)
}
