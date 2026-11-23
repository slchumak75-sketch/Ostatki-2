package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// Stable on-disk settings: desktop launches use a new HTTP port, so browser storage alone is insufficient.

// Б78: клиент сохраняет ширины всех таблиц одним запросом и добавляет
// служебный флаг __plusFirst (bool). Раньше декодирование в
// map[string][]float64 падало на этом флаге, а ключи «Неликвидов» и
// предпросмотра отклонялись проверкой — сохранение всегда завершалось
// ошибкой 400 и файл с ширинами не писался.
var columnWidthTables = map[string]bool{
	"itemsTable": true, "suppliersTable": true,
	"overstockTable": true, "orderPreviewTable": true,
}

type columnWidthsPayload struct {
	Widths map[string]json.RawMessage `json:"widths"`
}

func parseColumnWidths(raw []byte) (map[string]json.RawMessage, error) {
	var req columnWidthsPayload
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("неверные ширины столбцов")
	}
	if req.Widths == nil {
		req.Widths = map[string]json.RawMessage{}
	}
	for key, rawVal := range req.Widths {
		if key == "__plusFirst" {
			var flag bool
			if err := json.Unmarshal(rawVal, &flag); err != nil {
				return nil, fmt.Errorf("неверные ширины столбцов")
			}
			continue
		}
		if !columnWidthTables[key] {
			return nil, fmt.Errorf("неверная таблица")
		}
		var widths []float64
		if err := json.Unmarshal(rawVal, &widths); err != nil {
			return nil, fmt.Errorf("неверные ширины столбцов")
		}
		if len(widths) == 0 || len(widths) > 64 {
			return nil, fmt.Errorf("неверная таблица")
		}
		for _, v := range widths {
			if v <= 0 || v > 100000 {
				return nil, fmt.Errorf("неверная ширина")
			}
		}
	}
	return req.Widths, nil
}

func (s *AppServer) handleColumnWidths(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		writeError(w, 405, "требуется GET или POST")
		return
	}
	var widths map[string]json.RawMessage
	if r.Method == http.MethodPost {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			writeError(w, 400, "неверные ширины столбцов")
			return
		}
		parsed, err := parseColumnWidths(raw)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		widths = parsed
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
		raw, err := json.Marshal(columnWidthsPayload{Widths: widths})
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
			parsed, perr := parseColumnWidths(raw)
			if perr != nil {
				writeError(w, 500, "повреждены настройки ширины столбцов")
				return
			}
			widths = parsed
		}
	}
	if widths == nil {
		widths = map[string]json.RawMessage{}
	}
	writeJSON(w, 200, columnWidthsPayload{Widths: widths})
}
