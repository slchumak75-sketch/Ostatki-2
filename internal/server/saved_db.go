package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/forecast"
	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// SetSaveDir задаёт каталог для сохранения и автосохранения баз данных.
func (s *AppServer) SetSaveDir(dir string) {
	s.mu.Lock()
	s.customSaveDir = strings.TrimSpace(dir)
	s.mu.Unlock()
}

// SaveDir возвращает каталог, в который сохраняются файлы «Ведомость сохраненная».
func (s *AppServer) SaveDir() string {
	s.mu.RLock()
	dir := s.resolveSaveDirLocked()
	s.mu.RUnlock()
	return dir
}

func (s *AppServer) resolveSaveDirLocked() string {
	if s.customSaveDir != "" {
		return s.customSaveDir
	}
	if s.savedDBPath != "" {
		return filepath.Dir(s.savedDBPath)
	}
	// В десктопном режиме Windows сохраняем рядом с исполняемым файлом программы (если не temp),
	// иначе в текущем рабочем каталоге или домашнем каталоге пользователя.
	if exePath, err := os.Executable(); err == nil && exePath != "" {
		exeDir := filepath.Clean(filepath.Dir(exePath))
		tmpDir := filepath.Clean(os.TempDir())
		if exeDir != tmpDir && !strings.HasPrefix(exeDir, tmpDir+string(filepath.Separator)) {
			if isWritableDir(exeDir) {
				return exeDir
			}
		}
	}
	if wd, err := os.Getwd(); err == nil && wd != "" && isWritableDir(wd) {
		return wd
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		dl := filepath.Join(home, "Downloads")
		if isWritableDir(dl) {
			return dl
		}
		if isWritableDir(home) {
			return home
		}
	}
	return os.TempDir()
}

func isWritableDir(dir string) bool {
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	f, err := os.CreateTemp(dir, ".ostatki_probe_*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

func resolveWarehouseLabel(wb *model.WorkbookData, ui model.SavedUIState) string {
	if wh := strings.TrimSpace(ui.FltWarehouse); wh != "" {
		return wh
	}
	if wb == nil {
		return "Все склады"
	}
	var whList []string
	seen := make(map[string]bool)
	for _, it := range wb.Items {
		w := strings.TrimSpace(it.Warehouse)
		if w != "" && !seen[w] {
			seen[w] = true
			whList = append(whList, w)
		}
	}
	if len(whList) == 0 {
		return "Все склады"
	}
	return strings.Join(whList, " + ")
}

type saveDatabaseRequest struct {
	UI                      *model.SavedUIState `json:"ui"`
	SelectedSuppliers       []string            `json:"selectedSuppliers"`
	SupplierSelectionActive *bool               `json:"supplierSelectionActive"`
	PendingOverrides        map[int]int         `json:"pendingOverrides"`
	Reason                  string              `json:"reason"`
}

func (s *AppServer) handleSaveDatabase(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()

	var req saveDatabaseRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	s.mu.Lock()
	if s.wb == nil || s.report == nil || len(s.rawXLSX) == 0 {
		s.mu.Unlock()
		writeError(w, http.StatusBadRequest, "нет активной загруженной базы для сохранения")
		return
	}

	if req.UI != nil {
		s.uiState = *req.UI
	}
	if req.SupplierSelectionActive != nil {
		s.supplierSelectionActive = *req.SupplierSelectionActive
	}
	if req.SelectedSuppliers != nil {
		s.supplierSelectionActive = true
		s.selectedSuppliers = make(map[string]bool, len(req.SelectedSuppliers))
		for _, sup := range req.SelectedSuppliers {
			trimmed := strings.TrimSpace(sup)
			if trimmed == "" {
				trimmed = "(Поставщик не указан)"
			}
			s.selectedSuppliers[trimmed] = true
		}
	}

	overridesChanged := false
	for rowNum, val := range req.PendingOverrides {
		if rowNum <= 0 {
			continue
		}
		if val < 0 {
			val = 0
		}
		if prev, ok := s.overrides[rowNum]; !ok || prev != val {
			s.overrides[rowNum] = val
			overridesChanged = true
		}
	}
	if overridesChanged {
		s.report = forecast.Calculate(s.wb, s.params, s.overrides, s.orderExclusionsLocked(s.wb))
	}

	now := time.Now()
	whLabel := resolveWarehouseLabel(s.wb, s.uiState)
	fileName := xlsx.FormatSavedDatabaseFilename(whLabel, now)
	saveDir := s.resolveSaveDirLocked()
	if err := os.MkdirAll(saveDir, 0o755); err != nil {
		s.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "не удалось подготовить каталог сохранения: "+err.Error())
		return
	}
	targetPath := filepath.Join(saveDir, fileName)

	overridesCopy := make(map[int]int, len(s.overrides))
	for k, v := range s.overrides {
		overridesCopy[k] = v
	}
	suppliersSlice := s.sortedSelectedSuppliersLocked()

	sourceName := s.sourceFileName
	if sourceName == "" {
		sourceName = s.wb.FileName
	}

	snap := &model.SavedDatabaseSnapshot{
		Version:                 1,
		SavedAt:                 now.Format("02.01.2006 15:04:05"),
		SavedFileName:           fileName,
		SourceFileName:          sourceName,
		WarehouseLabel:          whLabel,
		Params:                  s.params,
		Overrides:               overridesCopy,
		SupplierSelectionActive: s.supplierSelectionActive,
		SelectedSuppliers:       suppliersSlice,
		UI:                      s.uiState,
	}

	exportRep := s.reportForExportLocked()
	orders := forecast.ExtractOrdersMap(exportRep)
	outBytes, err := xlsx.BuildSavedDatabaseXLSX(
		s.rawXLSX,
		s.wb.HeaderRow,
		s.wb.OrderCol,
		s.params.ColumnHeader,
		orders,
		s.params.WriteZeroValues,
		snap,
	)
	if err != nil {
		s.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "ошибка формирования файла базы: "+err.Error())
		return
	}

	tmpPath := targetPath + ".tmp"
	if err := os.WriteFile(tmpPath, outBytes, 0o644); err != nil {
		s.mu.Unlock()
		writeError(w, http.StatusInternalServerError, "ошибка записи файла базы: "+err.Error())
		return
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		_ = os.Remove(tmpPath)
		if err2 := os.WriteFile(targetPath, outBytes, 0o644); err2 != nil {
			s.mu.Unlock()
			writeError(w, http.StatusInternalServerError, "не удалось перезаписать сохранённую базу (возможно, файл открыт в Excel): "+err2.Error())
			return
		}
	}

	// Перезапись / удаление устаревших файлов сохранённой базы для этого же склада или сессии
	prevSavedPath := s.savedDBPath
	if prevSavedPath != "" && filepath.Clean(prevSavedPath) != filepath.Clean(targetPath) {
		_ = os.Remove(prevSavedPath)
	}
	whCleanPrefix := xlsx.CleanFilenamePart(whLabel)
	if whCleanPrefix == "" {
		whCleanPrefix = "Все склады"
	}
	sameWhPrefix := whCleanPrefix + ", Ведомость сохраненная, "
	if entries, err := os.ReadDir(saveDir); err == nil {
		for _, ent := range entries {
			if ent.IsDir() {
				continue
			}
			entName := ent.Name()
			if strings.HasPrefix(entName, sameWhPrefix) && strings.HasSuffix(strings.ToLower(entName), ".xlsx") {
				candPath := filepath.Join(saveDir, entName)
				if filepath.Clean(candPath) != filepath.Clean(targetPath) {
					_ = os.Remove(candPath)
				}
			}
		}
	}

	s.rawXLSX = outBytes
	s.savedDBPath = targetPath
	s.savedDBName = fileName
	s.lastSavedAt = snap.SavedAt
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"fileName":       fileName,
		"filePath":       targetPath,
		"savedAt":        snap.SavedAt,
		"warehouseLabel": whLabel,
	})
}

func (s *AppServer) handleListSavedDatabases(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()
	saveDir := s.SaveDir()

	entries, err := os.ReadDir(saveDir)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"saveDir": saveDir,
			"files":   []model.SavedDatabaseFileInfo{},
		})
		return
	}

	type scoredEntry struct {
		modTime time.Time
		info    model.SavedDatabaseFileInfo
	}
	var list []scoredEntry
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		lower := strings.ToLower(name)
		if !strings.HasSuffix(lower, ".xlsx") || strings.HasPrefix(name, "~$") {
			continue
		}
		fullPath := filepath.Join(saveDir, name)
		stat, err := ent.Info()
		if err != nil {
			continue
		}
		hasMarker := strings.Contains(name, xlsx.SavedDatabaseTitleMarker)
		snap, snapErr := xlsx.ReadSavedDatabaseMetadataFromFile(fullPath)
		if !hasMarker && (snapErr != nil || snap == nil) {
			continue
		}
		item := model.SavedDatabaseFileInfo{
			FileName:  name,
			SavedAt:   stat.ModTime().Format("02.01.2006 15:04:05"),
			SizeBytes: stat.Size(),
		}
		if snap != nil {
			if snap.SavedAt != "" {
				item.SavedAt = snap.SavedAt
			}
			item.WarehouseLabel = snap.WarehouseLabel
			item.SourceFileName = snap.SourceFileName
		}
		list = append(list, scoredEntry{modTime: stat.ModTime(), info: item})
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].modTime.After(list[j].modTime)
	})

	out := make([]model.SavedDatabaseFileInfo, len(list))
	for i := range list {
		out[i] = list[i].info
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"saveDir": saveDir,
		"files":   out,
	})
}

func (s *AppServer) handleLoadSavedDatabaseFromDisk(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "требуется метод POST")
		return
	}
	s.touchHeartbeat()

	var req struct {
		FileName string `json:"fileName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "некорректный запрос: "+err.Error())
		return
	}
	baseName := filepath.Base(strings.TrimSpace(req.FileName))
	if baseName == "" || baseName == "." || baseName == "/" {
		writeError(w, http.StatusBadRequest, "не указано имя файла сохранённой базы")
		return
	}

	saveDir := s.SaveDir()
	fullPath := filepath.Join(saveDir, baseName)
	raw, err := os.ReadFile(fullPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "не удалось прочитать файл сохранённой базы: "+err.Error())
		return
	}

	if err := s.restoreSavedDatabaseBytes(raw, baseName, fullPath); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.handleGetState(w, r)
}

func (s *AppServer) handleUploadSavedDatabase(w http.ResponseWriter, r *http.Request) {
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
		writeError(w, http.StatusBadRequest, "не передан файл сохранённой базы: "+err.Error())
		return
	}
	defer file.Close()

	raw, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ошибка чтения файла: "+err.Error())
		return
	}
	if err := s.restoreSavedDatabaseBytes(raw, hdr.Filename, ""); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.handleGetState(w, r)
}

func (s *AppServer) handleDownloadSavedDatabase(w http.ResponseWriter, r *http.Request) {
	s.touchHeartbeat()
	baseName := filepath.Base(strings.TrimSpace(r.URL.Query().Get("name")))
	if baseName == "" || baseName == "." || baseName == "/" {
		writeError(w, http.StatusBadRequest, "не указано имя файла")
		return
	}
	fullPath := filepath.Join(s.SaveDir(), baseName)
	raw, err := os.ReadFile(fullPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "файл не найден")
		return
	}
	sendXLSXAttachment(w, baseName, raw)
}

func (s *AppServer) restoreSavedDatabaseBytes(raw []byte, displayName string, diskPath string) error {
	startEpoch := s.epoch.Load()
	wb, err := xlsx.ParseBytes(raw, displayName)
	if err != nil {
		return fmt.Errorf("не удалось разобрать файл базы: %w", err)
	}
	snap, err := xlsx.ExtractSavedDatabaseSnapshot(raw)
	if err != nil {
		return fmt.Errorf("ошибка чтения сохранённого состояния: %w", err)
	}
	if s.epoch.Load() != startEpoch {
		return nil
	}

	params := model.DefaultParams()
	overrides := make(map[int]int)
	selSuppliers := make(map[string]bool)
	selActive := false
	ui := defaultSavedUIState()
	savedAt := ""
	sourceName := displayName

	if snap != nil {
		params = forecast.NormalizeParams(snap.Params)
		if snap.Overrides != nil {
			for k, v := range snap.Overrides {
				overrides[k] = v
			}
		}
		selActive = snap.SupplierSelectionActive
		for _, sup := range snap.SelectedSuppliers {
			trimmed := strings.TrimSpace(sup)
			if trimmed == "" {
				trimmed = "(Поставщик не указан)"
			}
			selSuppliers[trimmed] = true
		}
		ui = snap.UI
		savedAt = snap.SavedAt
		if snap.SourceFileName != "" {
			sourceName = snap.SourceFileName
		}
	} else {
		// Если загружен обычный Excel с уже заполненным столбцом 8, восстановим значения столбца 8
		for _, it := range wb.Items {
			if it.ExistingOrder != nil {
				v := int(*it.ExistingOrder)
				if v > 0 {
					overrides[it.ExcelRow] = v
				}
			}
		}
	}

	rep := forecast.Calculate(wb, params, overrides, s.orderExclusions(wb))

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.epoch.Load() != startEpoch {
		return nil
	}
	s.wb = wb
	s.rawXLSX = raw
	s.params = params
	s.overrides = overrides
	s.selectedSuppliers = selSuppliers
	s.supplierSelectionActive = selActive
	s.uiState = ui
	s.sourceFileName = sourceName
	s.savedDBPath = diskPath
	s.savedDBName = displayName
	s.lastSavedAt = savedAt
	s.report = rep
	return nil
}

func defaultSavedUIState() model.SavedUIState {
	return model.SavedUIState{
		ActiveTab:      "table",
		ActivePreset:   "standard",
		SortKey:        "finalOrderQty",
		SortDir:        "desc",
		FltStatus:      "all",
		OvSortKey:      "overstockValue",
		OvSortDir:      "desc",
		OverstockLimit: 500,
	}
}

func (s *AppServer) sortedSelectedSuppliersLocked() []string {
	out := make([]string, 0, len(s.selectedSuppliers))
	for sup, ok := range s.selectedSuppliers {
		if ok {
			out = append(out, sup)
		}
	}
	sort.Strings(out)
	return out
}
