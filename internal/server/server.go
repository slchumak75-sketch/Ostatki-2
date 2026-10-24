package server

import (
	"compress/gzip"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

//go:embed web/*
var embeddedWeb embed.FS

// AppServer управляет состоянием открытой книги Excel, расчётами и HTTP GUI.
type AppServer struct {
	properties              map[string]bool
	nomenclature            map[string]model.NomenclatureRecord
	etalon                  map[string]model.NomenclatureRecord
	propertiesLoaded        bool
	mu                      sync.RWMutex
	epoch                   atomic.Uint64
	wb                      *model.WorkbookData
	rawXLSX                 []byte
	params                  model.ForecastParams
	overrides               map[int]int
	selectedSuppliers       map[string]bool
	supplierSelectionActive bool
	sourceFileName          string
	savedDBPath             string
	savedDBName             string
	lastSavedAt             string
	customSaveDir           string
	uiState                 model.SavedUIState
	report                  *model.CalculationReport
	desktopMode             bool

	hbMu             sync.Mutex
	hasSeenClient    bool
	lastBeat         time.Time
	clientDetachedAt time.Time
	shutdownCh       chan struct{}
	shutdownOnce     sync.Once
}

type stateEnvelope struct {
	HasWorkbook             bool                     `json:"hasWorkbook"`
	CanSaveInPlace          bool                     `json:"canSaveInPlace"`
	DesktopMode             bool                     `json:"desktopMode"`
	FilePath                string                   `json:"filePath,omitempty"`
	SourceFileName          string                   `json:"sourceFileName,omitempty"`
	SavedFileName           string                   `json:"savedFileName,omitempty"`
	LastSavedAt             string                   `json:"lastSavedAt,omitempty"`
	Overrides               map[int]int              `json:"overrides,omitempty"`
	SupplierSelectionActive bool                     `json:"supplierSelectionActive"`
	SelectedSuppliers       []string                 `json:"selectedSuppliers,omitempty"`
	UIState                 model.SavedUIState       `json:"uiState"`
	Report                  *model.CalculationReport `json:"report,omitempty"`
}

// New создаёт новый экземпляр AppServer.
func New(desktopMode bool) *AppServer {
	s := &AppServer{
		params:            model.DefaultParams(),
		overrides:         make(map[int]int),
		selectedSuppliers: make(map[string]bool),
		uiState:           defaultSavedUIState(),
		desktopMode:       desktopMode,
		lastBeat:          time.Now(),
		shutdownCh:        make(chan struct{}),
	}
	return s
}

func (s *AppServer) buildStateEnvelopeLocked() stateEnvelope {
	overridesCopy := make(map[int]int, len(s.overrides))
	for k, v := range s.overrides {
		overridesCopy[k] = v
	}
	env := stateEnvelope{
		HasWorkbook:             s.wb != nil && s.report != nil,
		CanSaveInPlace:          s.wb != nil && s.wb.FilePath != "",
		DesktopMode:             s.desktopMode,
		SourceFileName:          s.sourceFileName,
		SavedFileName:           s.savedDBName,
		LastSavedAt:             s.lastSavedAt,
		Overrides:               overridesCopy,
		SupplierSelectionActive: s.supplierSelectionActive,
		SelectedSuppliers:       s.sortedSelectedSuppliersLocked(),
		UIState:                 s.uiState,
		Report:                  s.etalonReportLocked(s.report),
	}
	if s.wb != nil {
		env.FilePath = s.wb.FilePath
	}
	return env
}

// LoadWorkbookFromPath загружает ведомость с диска и выполняет первичный расчёт
// (если открыт файл сохранённой базы, автоматически восстанавливает всё её состояние).
func (s *AppServer) LoadWorkbookFromPath(filePath string) error {
	wb, raw, err := xlsx.ReadFile(filePath)
	if err != nil {
		return err
	}
	if snap, snapErr := xlsx.ExtractSavedDatabaseSnapshot(raw); snapErr == nil && snap != nil {
		if err := s.restoreSavedDatabaseBytes(raw, filepath.Base(filePath), filePath); err != nil {
			return err
		}
		s.mu.Lock()
		if s.wb != nil {
			s.wb.FilePath = filePath
		}
		s.mu.Unlock()
		return nil
	}

	excludedRows := s.orderExclusions(wb)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.catalogLocked()
	s.wb = wb
	s.rawXLSX = raw
	s.overrides = make(map[int]int)
	s.selectedSuppliers = make(map[string]bool)
	s.supplierSelectionActive = false
	s.uiState = defaultSavedUIState()
	s.sourceFileName = wb.FileName
	s.savedDBPath = ""
	s.savedDBName = ""
	s.lastSavedAt = ""
	s.params = model.DefaultParams()
	s.report = forecast.Calculate(s.wb, s.params, s.overrides, excludedRows)
	return nil
}

// LoadWorkbookFromBytes загружает новую ведомость из памяти (кнопка «Загрузить новую базу»).
// Парсинг и тяжёлый расчёт выполняются вне глобальной блокировки, чтобы кнопка «Очистить базу»
// срабатывала мгновенно даже при загрузке очень больших ведомостей.
func (s *AppServer) LoadWorkbookFromBytes(raw []byte, fileName string) error {
	startEpoch := s.epoch.Load()
	wb, err := xlsx.ParseBytes(raw, fileName)
	if err != nil {
		return err
	}
	if s.epoch.Load() != startEpoch {
		return nil
	}

	p := model.DefaultParams()
	emptyOverrides := make(map[int]int)
	rep := forecast.Calculate(wb, p, emptyOverrides, s.orderExclusions(wb))

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.epoch.Load() != startEpoch {
		return nil
	}
	s.catalogLocked()
	s.wb = wb
	s.rawXLSX = raw
	s.overrides = emptyOverrides
	s.selectedSuppliers = make(map[string]bool)
	s.supplierSelectionActive = false
	s.uiState = defaultSavedUIState()
	s.sourceFileName = fileName
	s.savedDBPath = ""
	s.savedDBName = ""
	s.lastSavedAt = ""
	s.params = p
	s.report = rep
	return nil
}

// ClearDatabase мгновенно очищает загруженную базу ведомости, отменяет фоновые расчёты старой эпохи
// и возвращает освобождённую оперативную память системе.
func (s *AppServer) ClearDatabase() {
	s.epoch.Add(1)
	s.mu.Lock()
	s.catalogLocked()
	s.wb = nil
	s.rawXLSX = nil
	s.overrides = make(map[int]int)
	s.selectedSuppliers = make(map[string]bool)
	s.supplierSelectionActive = false
	s.uiState = defaultSavedUIState()
	s.sourceFileName = ""
	s.savedDBPath = ""
	s.savedDBName = ""
	s.lastSavedAt = ""
	s.params = model.DefaultParams()
	s.report = nil
	s.mu.Unlock()

	go debug.FreeOSMemory()
}

// ShutdownChan закрывается, когда десктопное окно на Windows закрыто пользователем.
func (s *AppServer) ShutdownChan() <-chan struct{} {
	return s.shutdownCh
}

// StartDesktopWatchdog завершает неподключившийся запуск или подтверждённое
// отсоединение страницы без последующего подключения.
// После подключения молчание браузера не означает закрытие: таймеры могут быть
// приостановлены сворачиванием, сном Windows или фоновым ограничением Chromium.
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
				detachedAt := s.clientDetachedAt
				s.hbMu.Unlock()

				if !detachedAt.IsZero() && time.Since(detachedAt) > idleTimeout {
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
		s.mu.Lock()
		if s.propertiesLoaded {
			dir, err := s.propertiesDirLocked()
			if err == nil {
				_, err = s.savePropertiesLocked(dir)
			}
			if err != nil {
				fmt.Fprintf(os.Stderr, "Сохранение свойств при выходе: %v\n", err)
			}
		}
		s.mu.Unlock()
		close(s.shutdownCh)
	})
}

// Handler возвращает настроенный HTTP-маршрутизатор со встроенным HTML GUI и REST API.
func (s *AppServer) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})
	mux.HandleFunc("/api/column-widths", s.handleColumnWidths)
	mux.HandleFunc("/api/properties", s.handleProperties)
	mux.HandleFunc("/api/properties/export", s.handleExportProperties)
	mux.HandleFunc("/api/properties/import", s.handleImportProperties)
	mux.HandleFunc("/api/etalon/save", s.handleSaveEtalon)
	mux.HandleFunc("/api/etalon/export", s.handleExportEtalon)
	mux.HandleFunc("/api/etalon/import", s.handleImportEtalon)
	mux.HandleFunc("/api/state", s.handleGetState)
	mux.HandleFunc("/api/params", s.handleUpdateParams)
	mux.HandleFunc("/api/override", s.handleOverride)
	mux.HandleFunc("/api/selected-suppliers", s.handleSelectedSuppliers)
	mux.HandleFunc("/api/upload", s.handleUpload)
	mux.HandleFunc("/api/clear", s.handleClearDatabase)
	mux.HandleFunc("/api/db/save", s.handleSaveDatabase)
	mux.HandleFunc("/api/db/list", s.handleListSavedDatabases)
	mux.HandleFunc("/api/db/load", s.handleLoadSavedDatabaseFromDisk)
	mux.HandleFunc("/api/db/upload", s.handleUploadSavedDatabase)
	mux.HandleFunc("/api/db/download", s.handleDownloadSavedDatabase)
	mux.HandleFunc("/api/save-inplace", s.handleSaveInPlace)
	mux.HandleFunc("/api/export/xlsx", s.handleExportFilledXLSX)
	mux.HandleFunc("/api/export/orders", s.handleExportOrdersXLSX)
	mux.HandleFunc("/api/export/supplier-order", s.handleExportSingleSupplierOrderXLSX)
	mux.HandleFunc("/api/export/staryo", s.handleExportStaryoXLSX)
	mux.HandleFunc("/api/heartbeat", s.handleHeartbeat)
	mux.HandleFunc("/api/client-detach", s.handleClientDetach)
	mux.HandleFunc("/api/shutdown", s.handleShutdown)

	subFS, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(subFS))
	mux.Handle("/", fileServer)

	return withPermissiveHeaders(mux)
}

var gzipWriterPool = sync.Pool{
	New: func() any {
		gw, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return gw
	},
}

func (s *AppServer) handleGetState(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()
	s.mu.RLock()
	env := s.buildStateEnvelopeLocked()
	s.mu.RUnlock()

	writeJSONForRequest(w, r, http.StatusOK, env)
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

	normParams := forecast.NormalizeParams(incoming)

	s.mu.Lock()
	startEpoch := s.epoch.Load()
	s.params = normParams
	wb := s.wb
	excludedRows := s.orderExclusionsLocked(wb)
	var overridesCopy map[int]int
	if wb != nil {
		overridesCopy = make(map[int]int, len(s.overrides))
		for k, v := range s.overrides {
			overridesCopy[k] = v
		}
	}
	s.mu.Unlock()

	var rep *model.CalculationReport
	if wb != nil {
		rep = forecast.Calculate(wb, normParams, overridesCopy, excludedRows)
	}

	s.mu.Lock()
	if s.epoch.Load() != startEpoch {
		// Во время расчёта пользователь нажал «Очистить базу» или загрузил другой файл
		env := s.buildStateEnvelopeLocked()
		s.mu.Unlock()
		writeJSONForRequest(w, r, http.StatusOK, env)
		return
	}
	s.report = rep
	env := s.buildStateEnvelopeLocked()
	s.mu.Unlock()

	writeJSONForRequest(w, r, http.StatusOK, env)
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
	if s.wb == nil {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "файл Excel не загружен")
		return
	}
	startEpoch := s.epoch.Load()
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
	wb := s.wb
	params := s.params
	excludedRows := s.orderExclusionsLocked(wb)
	overridesCopy := make(map[int]int, len(s.overrides))
	for k, v := range s.overrides {
		overridesCopy[k] = v
	}
	s.mu.Unlock()

	rep := forecast.Calculate(wb, params, overridesCopy, excludedRows)

	s.mu.Lock()
	if s.epoch.Load() != startEpoch || s.wb == nil {
		env := s.buildStateEnvelopeLocked()
		s.mu.Unlock()
		writeJSONForRequest(w, r, http.StatusOK, env)
		return
	}
	s.report = rep
	env := s.buildStateEnvelopeLocked()
	s.mu.Unlock()

	writeJSONForRequest(w, r, http.StatusOK, env)
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
		return s.etalonReportLocked(s.report)
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
	rep := forecast.Calculate(s.wb, s.params, effOverrides, s.orderExclusionsLocked(s.wb))
	return s.etalonReportLocked(rep)
}

func (s *AppServer) handleClearDatabase(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST или GET")
		return
	}
	s.touchHeartbeat()
	s.ClearDatabase()
	s.mu.RLock()
	env := s.buildStateEnvelopeLocked()
	s.mu.RUnlock()
	writeJSONForRequest(w, r, http.StatusOK, env)
}

func (s *AppServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()
	if err := r.ParseMultipartForm(512 << 20); err != nil {
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

func (s *AppServer) handleExportStaryoXLSX(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()

	var requestedRows []int
	ct := r.Header.Get("Content-Type")
	if r.Method == http.MethodPost && strings.Contains(ct, "application/json") {
		var payload struct {
			ExcelRows []int `json:"excelRows"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, "некорректный список строк: "+err.Error())
			return
		}
		requestedRows = payload.ExcelRows
	} else {
		_ = r.ParseForm()
		rawRows := strings.TrimSpace(r.FormValue("rows"))
		if rawRows != "" {
			for _, part := range strings.Split(rawRows, ",") {
				n, err := strconv.Atoi(strings.TrimSpace(part))
				if err == nil && n > 0 {
					requestedRows = append(requestedRows, n)
				}
			}
		}
	}

	if len(requestedRows) == 0 {
		writeError(w, http.StatusBadRequest, "не отмечено галочкой ни одной строки в столбце «+»")
		return
	}

	s.mu.RLock()
	rep := s.report
	s.mu.RUnlock()

	if rep == nil {
		writeError(w, http.StatusBadRequest, "нет загруженной ведомости")
		return
	}

	byExcelRow := make(map[int]model.CalculatedItem, len(rep.Items))
	for _, it := range rep.Items {
		byExcelRow[it.ExcelRow] = it
	}

	seen := make(map[int]bool, len(requestedRows))
	marked := make([]model.CalculatedItem, 0, len(requestedRows))
	for _, rNum := range requestedRows {
		if seen[rNum] {
			continue
		}
		if it, ok := byExcelRow[rNum]; ok {
			seen[rNum] = true
			marked = append(marked, it)
		}
	}
	if len(marked) == 0 {
		writeError(w, http.StatusBadRequest, "выбранные строки с «+» не найдены в текущей базе")
		return
	}

	outBytes, err := xlsx.GenerateStaryoExportXLSX(marked)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка формирования файла Старьё: "+err.Error())
		return
	}

	dlName := fmt.Sprintf("Старьё — %s.xlsx", time.Now().Format("02.01.2006"))
	sendXLSXAttachment(w, dlName, outBytes)
}

func (s *AppServer) handleClientDetach(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	s.hbMu.Lock()
	s.clientDetachedAt = time.Now()
	s.hbMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
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
	s.clientDetachedAt = time.Time{}
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
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeJSONForRequest(w http.ResponseWriter, r *http.Request, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	if r != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		w.WriteHeader(status)
		gw := gzipWriterPool.Get().(*gzip.Writer)
		gw.Reset(w)
		_ = json.NewEncoder(gw).Encode(payload)
		_ = gw.Close()
		gw.Reset(io.Discard)
		gzipWriterPool.Put(gw)
		return
	}
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
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
