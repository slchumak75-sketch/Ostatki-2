// Package app — локальный HTTP-сервер с HTML GUI (встроен через go:embed).
//
// Контракт API описан в docs/ARCHITECTURE.md; тот же контракт реализует
// Python dev-сервер tools/dev_server.py (для разработки фронтенда без Go).
package app

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"ostatki/internal/forecast"
	"ostatki/internal/model"
	"ostatki/internal/xlsxio"
)

//go:embed web/index.html web/style.css web/app.js
var webFS embed.FS

// Server хранит текущее загруженное состояние (приложение однопользовательское, локальное).
type Server struct {
	mu         sync.Mutex
	items      []model.Item
	months     []model.Month
	state      *model.State
	Version    string
	OnShutdown func()
}

// NewServer создаёт сервер с указанной версией (для /api/health и шапки GUI).
func NewServer(version string) *Server {
	return &Server{Version: version}
}

// LoadData разбирает xlsx и считает состояние с параметрами по умолчанию.
func (s *Server) LoadData(fileName string, data []byte, p model.Params) (*model.State, error) {
	parsed, err := xlsxio.Parse(data)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = parsed.Items
	s.months = parsed.Months
	s.state = s.computeLocked(fileName, p)
	return s.state, nil
}

func (s *Server) computeLocked(fileName string, p model.Params) *model.State {
	st := forecast.Compute(s.items, s.months, p)
	st.FileName = fileName
	st.Version = s.Version
	st.LoadedAt = time.Now().Format("2006-01-02 15:04:05")
	return st
}

// Handler возвращает http.Handler со всеми маршрутами.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("web fs: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(web)))
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/state", s.handleState)
	mux.HandleFunc("/api/upload", s.handleUpload)
	mux.HandleFunc("/api/recalc", s.handleRecalc)
	mux.HandleFunc("/api/export.xlsx", s.handleExportXLSX)
	mux.HandleFunc("/api/purchase.csv", s.handlePurchaseCSV)
	mux.HandleFunc("/api/shutdown", s.handleShutdown)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.Version})
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == nil {
		writeJSON(w, http.StatusOK, map[string]any{"empty": true, "version": s.Version})
		return
	}
	writeJSON(w, http.StatusOK, s.state)
}

func paramsFromForm(r *http.Request) model.Params {
	p := model.DefaultParams()
	raw := r.FormValue("params")
	if raw == "" {
		return p
	}
	var got model.Params
	if json.Unmarshal([]byte(raw), &got) == nil {
		// Частичный JSON недопустим: фронтенд всегда шлёт полный набор.
		return normalizeParams(got)
	}
	return p
}

func normalizeParams(p model.Params) model.Params {
	if p.Horizon < 1 {
		p.Horizon = 1
	}
	if p.Horizon > 12 {
		p.Horizon = 12
	}
	if p.SafetyPercent < 0 {
		p.SafetyPercent = 0
	}
	if p.SafetyPercent > 300 {
		p.SafetyPercent = 300
	}
	if p.LeadDays < 0 {
		p.LeadDays = 0
	}
	if p.LeadDays > 180 {
		p.LeadDays = 180
	}
	if p.DeadMonths < 0 {
		p.DeadMonths = 0
	}
	if p.DeadMonths > 60 {
		p.DeadMonths = 60
	}
	if p.ShrinkageK < 0 {
		p.ShrinkageK = 0
	}
	return p
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "нужен POST")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "не удалось прочитать загруженный файл: "+err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "в запросе нет файла (поле file)")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 32<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "ошибка чтения файла: "+err.Error())
		return
	}
	st, err := s.LoadData(header.Filename, data, paramsFromForm(r))
	if err != nil {
		writeErr(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleRecalc(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "нужен POST")
		return
	}
	var body struct {
		Params model.Params `json:"params"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "некорректный JSON: "+err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state == nil {
		writeErr(w, http.StatusBadRequest, "сначала загрузите файл ведомости")
		return
	}
	s.state = s.computeLocked(s.state.FileName, normalizeParams(body.Params))
	writeJSON(w, http.StatusOK, s.state)
}

func (s *Server) handleExportXLSX(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	st := s.state
	s.mu.Unlock()
	if st == nil {
		writeErr(w, http.StatusBadRequest, "нет загруженных данных")
		return
	}
	data, err := xlsxio.Write(st)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "ошибка формирования xlsx: "+err.Error())
		return
	}
	name := "Ведомость_К_закупке.xlsx"
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))
	_, _ = w.Write(data)
}

func csvNum(v float64) string {
	s := fmt.Sprintf("%.2f", v)
	return strings.ReplaceAll(s, ".", ",")
}

func csvCell(s string) string {
	if strings.ContainsAny(s, ";\"\n\r") {
		return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
	}
	return s
}

func (s *Server) handlePurchaseCSV(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	st := s.state
	s.mu.Unlock()
	if st == nil {
		writeErr(w, http.StatusBadRequest, "нет загруженных данных")
		return
	}
	var b strings.Builder
	b.WriteString("\ufeff") // BOM: Excel RU корректно откроет UTF-8 с разделителем ';'
	b.WriteString("Поставщик;Артикул;Номенклатура;Ед.;Остаток;Прогноз на период;К закупке;Цена поставщика;Сумма заказа;Склад\r\n")
	rows := make([]*model.Row, 0)
	for i := range st.Rows {
		if st.Rows[i].Recommend > 0 {
			rows = append(rows, &st.Rows[i])
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Supplier != rows[j].Supplier {
			return rows[i].Supplier < rows[j].Supplier
		}
		return rows[i].OrderCost > rows[j].OrderCost
	})
	for _, row := range rows {
		pp := ""
		if row.PurchasePrice != nil {
			pp = csvNum(*row.PurchasePrice)
		}
		cols := []string{
			csvCell(row.Supplier), csvCell(row.Article), csvCell(row.Name), csvCell(row.Unit),
			csvNum(row.Stock), csvNum(row.ForecastTotal), csvNum(row.Recommend), pp,
			csvNum(row.OrderCost), csvCell(row.Warehouse),
		}
		b.WriteString(strings.Join(cols, ";") + "\r\n")
	}
	name := "Закупка_по_поставщикам.csv"
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	_, _ = w.Write([]byte(b.String()))
}

func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, "нужен POST")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	if s.OnShutdown != nil {
		go func() {
			time.Sleep(300 * time.Millisecond)
			s.OnShutdown()
		}()
	}
}
