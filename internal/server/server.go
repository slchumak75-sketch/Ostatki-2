package server

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

//go:embed web/*
var embeddedWeb embed.FS

// AppServer управляет состоянием открытой книги Excel, расчётами и HTTP GUI.
type AppServer struct {
	mu                      sync.RWMutex
	wb                      *model.WorkbookData
	rawXLSX                 []byte
	params                  model.ForecastParams
	overrides               map[int]int
	selectedSuppliers       map[string]bool
	supplierSelectionActive bool
	report                  *model.CalculationReport
	desktopMode             bool

	hbMu          sync.Mutex
	hasSeenClient bool
	lastBeat      time.Time
	shutdownCh    chan struct{}
	shutdownOnce  sync.Once
}

type stateEnvelope struct {
	HasWorkbook    bool                     `json:"hasWorkbook"`
	CanSaveInPlace bool                     `json:"canSaveInPlace"`
	DesktopMode    bool                     `json:"desktopMode"`
	FilePath       string                   `json:"filePath,omitempty"`
	Report         *model.CalculationReport `json:"report,omitempty"`
}

// New создаёт новый экземпляр AppServer.
func New(desktopMode bool) *AppServer {
	s := &AppServer{
		params:            model.DefaultParams(),
		overrides:         make(map[int]int),
		selectedSuppliers: make(map[string]bool),
		desktopMode:       desktopMode,
		lastBeat:          time.Now(),
		shutdownCh:        make(chan struct{}),
	}
	return s
}

// LoadWorkbookFromPath загружает ведомость с диска и выполняет первичный расчёт.
func (s *AppServer) LoadWorkbookFromPath(filePath string) error {
	wb, raw, err := xlsx.ReadFile(filePath)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wb = wb
	s.rawXLSX = raw
	s.overrides = make(map[int]int)
	s.selectedSuppliers = make(map[string]bool)
	s.supplierSelectionActive = false
	s.params = model.DefaultParams()
	s.report = forecast.Calculate(s.wb, s.params, s.overrides)
	return nil
}

// LoadWorkbookFromBytes загружает ведомость из памяти (например, при загрузке через браузер).
func (s *AppServer) LoadWorkbookFromBytes(raw []byte, fileName string) error {
	wb, err := xlsx.ParseBytes(raw, fileName)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wb = wb
	s.rawXLSX = raw
	s.overrides = make(map[int]int)
	s.selectedSuppliers = make(map[string]bool)
	s.supplierSelectionActive = false
	// Сохраняем текущие настройки пользователя, но сбрасываем жёсткую дату на авто из нового файла
	p := s.params
	p.PlanStartDate = ""
	p.LastMonthDaysElapsed = 0
	s.params = p
	s.report = forecast.Calculate(s.wb, s.params, s.overrides)
	return nil
}

// ClearDatabase полностью очищает загруженную базу ведомости и сбрасывает расчёт в пустое состояние.
func (s *AppServer) ClearDatabase() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.wb = nil
	s.rawXLSX = nil
	s.overrides = make(map[int]int)
	s.selectedSuppliers = make(map[string]bool)
	s.supplierSelectionActive = false
	s.params = model.DefaultParams()
	s.report = nil
}

// ShutdownChan закрывается, когда десктопное окно на Windows закрыто пользователем.
func (s *AppServer) ShutdownChan() <-chan struct{} {
	return s.shutdownCh
}

// StartDesktopWatchdog отслеживает закрытие окна приложения в десктопном режиме.
func (s *AppServer) StartDesktopWatchdog(idleTimeout time.Duration) {
	if !s.desktopMode {
		return
	}
	started := time.Now()
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.shutdownCh:
				return
			case <-ticker.C:
				s.hbMu.Lock()
				seen := s.hasSeenClient
				elapsed := time.Since(s.lastBeat)
				s.hbMu.Unlock()

				if seen && elapsed > idleTimeout {
					s.triggerShutdown()
					return
				}
				// Если окно не подключилось вообще в течение 90 секунд
				if !seen && time.Since(started) > 90*time.Second {
					s.triggerShutdown()
					return
				}
			}
		}
	}()
}

func (s *AppServer) triggerShutdown() {
	s.shutdownOnce.Do(func() {
		close(s.shutdownCh)
	})
}

// Handler возвращает настроенный HTTP-маршрутизатор со встроенным HTML GUI и REST API.
func (s *AppServer) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})
	mux.HandleFunc("/api/state", s.handleGetState)
	mux.HandleFunc("/api/params", s.handleUpdateParams)
	mux.HandleFunc("/api/override", s.handleOverride)
	mux.HandleFunc("/api/selected-suppliers", s.handleSelectedSuppliers)
	mux.HandleFunc("/api/upload", s.handleUpload)
	mux.HandleFunc("/api/clear", s.handleClearDatabase)
	mux.HandleFunc("/api/save-inplace", s.handleSaveInPlace)
	mux.HandleFunc("/api/export/xlsx", s.handleExportFilledXLSX)
	mux.HandleFunc("/api/export/orders", s.handleExportOrdersXLSX)
	mux.HandleFunc("/api/export/supplier-order", s.handleExportSingleSupplierOrderXLSX)
	mux.HandleFunc("/api/heartbeat", s.handleHeartbeat)
	mux.HandleFunc("/api/shutdown", s.handleShutdown)

	subFS, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(subFS))
	mux.Handle("/", fileServer)

	return withPermissiveHeaders(mux)
}

func (s *AppServer) handleGetState(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()
	s.mu.RLock()
	defer s.mu.RUnlock()

	env := stateEnvelope{
		HasWorkbook:    s.wb != nil && s.report != nil,
		CanSaveInPlace: s.wb != nil && s.wb.FilePath != "",
		DesktopMode:    s.desktopMode,
		Report:         s.report,
	}
	if s.wb != nil {
		env.FilePath = s.wb.FilePath
	}
	writeJSON(w, http.StatusOK, env)
}

func (s *AppServer) handleUpdateParams(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()
	var incoming model.ForecastParams
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		writeError(w, http.StatusBadRequest, "некорректный JSON параметров: "+err.Error())
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.params = forecast.NormalizeParams(incoming)
	if s.wb != nil {
		s.report = forecast.Calculate(s.wb, s.params, s.overrides)
	}
	writeJSON(w, http.StatusOK, stateEnvelope{
		HasWorkbook:    s.wb != nil,
		CanSaveInPlace: s.wb != nil && s.wb.FilePath != "",
		DesktopMode:    s.desktopMode,
		Report:         s.report,
	})
}

func (s *AppServer) handleOverride(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()
	var req struct {
		ExcelRow int  `json:"excelRow"`
		Value    int  `json:"value"`
		Clear    bool `json:"clear"`
		ClearAll bool `json:"clearAll"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "некорректный запрос: "+err.Error())
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wb == nil {
		writeError(w, http.StatusBadRequest, "файл Excel не загружен")
		return
	}
	if req.ClearAll {
		s.overrides = make(map[int]int)
	} else if req.Clear {
		delete(s.overrides, req.ExcelRow)
	} else if req.ExcelRow > 0 {
		if req.Value < 0 {
			req.Value = 0
		}
		s.overrides[req.ExcelRow] = req.Value
	}
	s.report = forecast.Calculate(s.wb, s.params, s.overrides)
	writeJSON(w, http.StatusOK, stateEnvelope{
		HasWorkbook:    true,
		CanSaveInPlace: s.wb.FilePath != "",
		DesktopMode:    s.desktopMode,
		Report:         s.report,
	})
}

func (s *AppServer) handleSelectedSuppliers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()
	var req struct {
		Suppliers []string `json:"suppliers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "некорректный запрос: "+err.Error())
		return
	}

	s.mu.Lock()
	s.supplierSelectionActive = true
	s.selectedSuppliers = make(map[string]bool, len(req.Suppliers))
	for _, sup := range req.Suppliers {
		trimmed := strings.TrimSpace(sup)
		if trimmed == "" {
			trimmed = "(Поставщик не указан)"
		}
		s.selectedSuppliers[trimmed] = true
	}
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"count": len(req.Suppliers),
	})
}

// reportForExportLocked строит срез расчёта для выгрузки в Excel с учётом
// отмеченных галочками поставщиков (не меняя авторасчёт в самой ведомости).
func (s *AppServer) reportForExportLocked() *model.CalculationReport {
	if s.wb == nil || s.report == nil {
		return nil
	}
	if !s.supplierSelectionActive {
		return s.report
	}
	effOverrides := make(map[int]int, len(s.wb.Items))
	for k, v := range s.overrides {
		effOverrides[k] = v
	}
	for _, item := range s.wb.Items {
		supKey := strings.TrimSpace(item.Supplier)
		if supKey == "" {
			supKey = "(Поставщик не указан)"
		}
		if !s.selectedSuppliers[supKey] {
			effOverrides[item.ExcelRow] = 0
		}
	}
	return forecast.Calculate(s.wb, s.params, effOverrides)
}

func (s *AppServer) handleClearDatabase(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()
	s.ClearDatabase()
	writeJSON(w, http.StatusOK, stateEnvelope{
		HasWorkbook:    false,
		CanSaveInPlace: false,
		DesktopMode:    s.desktopMode,
		Report:         nil,
	})
}

func (s *AppServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "ошибка чтения формы: "+err.Error())
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "не передан файл Excel: "+err.Error())
		return
	}
	defer file.Close()

	raw, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка чтения потока: "+err.Error())
		return
	}
	if err := s.LoadWorkbookFromBytes(raw, hdr.Filename); err != nil {
		writeError(w, http.StatusBadRequest, "не удалось разобрать Excel-файл: "+err.Error())
		return
	}
	s.handleGetState(w, r)
}

func (s *AppServer) handleSaveInPlace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wb == nil || s.report == nil || len(s.rawXLSX) == 0 {
		writeError(w, http.StatusBadRequest, "нет активной книги для сохранения")
		return
	}
	if s.wb.FilePath == "" {
		writeError(w, http.StatusBadRequest, "файл был загружен через браузер — используйте «Скачать Excel»")
		return
	}

	exportRep := s.reportForExportLocked()
	orders := forecast.ExtractOrdersMap(exportRep)
	outBytes, err := xlsx.WriteOrderColumnLossless(
		s.rawXLSX,
		s.wb.HeaderRow,
		s.wb.OrderCol,
		s.params.ColumnHeader,
		orders,
		s.params.WriteZeroValues,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка формирования XLSX: "+err.Error())
		return
	}

	tmpPath := s.wb.FilePath + ".tmp"
	if err := os.WriteFile(tmpPath, outBytes, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка записи файла (возможно, файл открыт в Excel): "+err.Error())
		return
	}
	if err := os.Rename(tmpPath, s.wb.FilePath); err != nil {
		_ = os.Remove(tmpPath)
		if err2 := os.WriteFile(s.wb.FilePath, outBytes, 0o644); err2 != nil {
			writeError(w, http.StatusInternalServerError, "не удалось перезаписать файл (закройте его в Excel): "+err2.Error())
			return
		}
	}
	s.rawXLSX = outBytes

	writeJSON(w, http.StatusOK, map[string]any{
		"saved":     true,
		"filePath":  s.wb.FilePath,
		"updatedAt": time.Now().Format("15:04:05"),
		"units":     exportRep.TotalOrderUnits,
		"items":     exportRep.OrderItemsCount,
	})
}

func (s *AppServer) handleExportFilledXLSX(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()
	s.mu.RLock()
	wb := s.wb
	raw := s.rawXLSX
	rep := s.reportForExportLocked()
	params := s.params
	s.mu.RUnlock()

	if wb == nil || rep == nil || len(raw) == 0 {
		writeError(w, http.StatusBadRequest, "нет загруженной ведомости")
		return
	}

	orders := forecast.ExtractOrdersMap(rep)
	outBytes, err := xlsx.WriteOrderColumnLossless(
		raw,
		wb.HeaderRow,
		wb.OrderCol,
		params.ColumnHeader,
		orders,
		params.WriteZeroValues,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка генерации файла: "+err.Error())
		return
	}

	base := strings.TrimSuffix(filepath.Base(wb.FileName), filepath.Ext(wb.FileName))
	dlName := fmt.Sprintf("%s — К закупкам (%s).xlsx", base, rep.EffectiveStartDate)
	sendXLSXAttachment(w, dlName, outBytes)
}

func (s *AppServer) handleExportOrdersXLSX(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()
	s.mu.RLock()
	rep := s.reportForExportLocked()
	s.mu.RUnlock()

	if rep == nil {
		writeError(w, http.StatusBadRequest, "нет данных расчёта")
		return
	}
	filterWarehouse := strings.TrimSpace(r.URL.Query().Get("warehouse"))
	filterSupplier := strings.TrimSpace(r.URL.Query().Get("supplier"))

	outBytes, err := xlsx.GenerateSupplierOrdersXLSX(rep, filterWarehouse, filterSupplier)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка генерации отчёта поставщикам: "+err.Error())
		return
	}

	suffix := "выбранные поставщики"
	if filterSupplier != "" {
		suffix = sanitizeFilePart(filterSupplier)
	} else if filterWarehouse != "" {
		suffix = sanitizeFilePart(filterWarehouse)
	}
	dlName := fmt.Sprintf("Заявки поставщикам — %s (%s).xlsx", suffix, rep.EffectiveStartDate)
	sendXLSXAttachment(w, dlName, outBytes)
}

func (s *AppServer) handleExportSingleSupplierOrderXLSX(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()
	filterWarehouse := strings.TrimSpace(r.URL.Query().Get("warehouse"))
	filterSupplier := strings.TrimSpace(r.URL.Query().Get("supplier"))

	s.mu.RLock()
	selActive := s.supplierSelectionActive
	supAllowed := true
	if selActive && filterSupplier != "" {
		supAllowed = s.selectedSuppliers[filterSupplier]
	}
	rep := s.reportForExportLocked()
	s.mu.RUnlock()

	if rep == nil {
		writeError(w, http.StatusBadRequest, "нет данных расчёта")
		return
	}
	if !supAllowed {
		writeError(w, http.StatusBadRequest, "поставщик не отмечен галочкой для формирования заказа")
		return
	}

	whForName := filterWarehouse
	if whForName == "" {
		var whList []string
		seenWh := make(map[string]bool)
		for _, it := range rep.Items {
			if it.FinalOrderQty <= 0 {
				continue
			}
			supName := strings.TrimSpace(it.Supplier)
			if filterSupplier != "" && supName != filterSupplier && !(filterSupplier == "(Поставщик не указан)" && supName == "") {
				continue
			}
			if it.Warehouse != "" && !seenWh[it.Warehouse] {
				seenWh[it.Warehouse] = true
				whList = append(whList, it.Warehouse)
			}
		}
		whForName = strings.Join(whList, " + ")
	}

	outBytes, err := xlsx.GenerateSingleSupplierOrderXLSX(rep, filterWarehouse, filterSupplier)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка генерации заказа поставщику: "+err.Error())
		return
	}

	dlName := xlsx.FormatSupplierOrderFilename(whForName, filterSupplier, time.Now())
	sendXLSXAttachment(w, dlName, outBytes)
}

func (s *AppServer) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()
	w.WriteHeader(http.StatusNoContent)
}

func (s *AppServer) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if !s.desktopMode {
		writeJSON(w, http.StatusOK, map[string]any{"ignored": true, "reason": "server mode"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"shuttingDown": true})
	go func() {
		time.Sleep(150 * time.Millisecond)
		s.triggerShutdown()
	}()
}

func (s *AppServer) touchHeartbeat() {
	s.hbMu.Lock()
	s.hasSeenClient = true
	s.lastBeat = time.Now()
	s.hbMu.Unlock()
}

func sendXLSXAttachment(w http.ResponseWriter, fileName string, data []byte) {
	encoded := url.PathEscape(fileName)
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="zakupki.xlsx"; filename*=UTF-8''%s`, encoded))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func sanitizeFilePart(s string) string {
	replacer := strings.NewReplacer(`"`, "", `'`, "", `/`, "_", `\`, "_", `:`, "-", `*`, "", `?`, "", `<`, "", `>`, "", `|`, "")
	out := strings.TrimSpace(replacer.Replace(s))
	if len([]rune(out)) > 40 {
		out = string([]rune(out)[:40])
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func withPermissiveHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
