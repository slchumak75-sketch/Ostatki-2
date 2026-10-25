package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// Read-only inspection; never changes the active workbook, reference or properties.
func (s *AppServer) handleWorkbookCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, 405, "требуется POST")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	var raw []byte
	var name string
	var err error
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var req struct {
			FileName string `json:"fileName"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil || filepath.Base(req.FileName) != req.FileName || req.FileName == "" {
			writeError(w, 400, "неверное имя")
			return
		}
		name = req.FileName
		raw, err = os.ReadFile(filepath.Join(s.SaveDir(), name))
	} else {
		if r.ParseMultipartForm(64<<20) != nil {
			writeError(w, 400, "неверный файл")
			return
		}
		defer r.MultipartForm.RemoveAll()
		f, h, e := r.FormFile("file")
		if e != nil {
			writeError(w, 400, "выберите файл")
			return
		}
		defer f.Close()
		name = h.Filename
		raw, err = io.ReadAll(f)
	}
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	wb, err := xlsx.ParseBytes(raw, name)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	warehouses := map[string]bool{}
	identities := map[string]int{}
	duplicates, noPrices := 0, 0
	for _, it := range wb.Items {
		warehouses[it.Warehouse] = true
		key := xlsx.NomenclaturePropertyKey(it.SKU, it.Group, it.Name, it.Warehouse)
		identities[key]++
		if identities[key] > 1 {
			duplicates++
		}
		if it.PurchasePrice <= 0 {
			noPrices++
		}
	}
	names := []string{}
	for wh := range warehouses {
		names = append(names, wh)
	}
	sort.Strings(names)
	first, last := "нет", "нет"
	if len(wb.Periods) > 0 {
		first = wb.Periods[0].Label
		last = wb.Periods[len(wb.Periods)-1].Label
	}
	writeJSON(w, 200, map[string]any{"fileName": name, "items": len(wb.Items), "warehouses": names, "first": first, "last": last, "duplicates": duplicates, "noPrices": noPrices})
}
