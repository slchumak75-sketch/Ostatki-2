package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/userpaths"
	"github.com/slchumak75-sketch/Ostatki-2/internal/xlsx"
)

// Caller holds s.mu; an explicit custom directory is retained for integrations/tests.
func (s *AppServer) outputDirLocked(folder string) (string, error) {
	root := s.customSaveDir
	if root == "" {
		var err error
		root, err = userpaths.DownloadsDir()
		if err != nil {
			return "", err
		}
	}
	return filepath.Join(root, folder), nil
}

// Export a copy only. This must never update the stored reference or catalog.
func (s *AppServer) saveExport(w http.ResponseWriter, folder, name string, raw []byte) {
	s.mu.RLock()
	desktop := s.desktopMode
	dir, err := s.outputDirLocked(folder)
	s.mu.RUnlock()
	if !desktop {
		writeError(w, 400, "Сохранение в папку Загрузки доступно в настольной программе")
		return
	}
	if err == nil {
		err = os.MkdirAll(dir, 0700)
	}
	if err == nil {
		err = writeVerifiedProperties(filepath.Join(dir, name), raw)
	}
	if err != nil {
		writeError(w, 500, "Не удалось сохранить выгрузку: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"fileName": name, "directory": dir, "saved": true})
}

// The browser supplies its in-memory snapshot so even unacknowledged marks survive.
func (s *AppServer) handleBackupProperties(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, 405, "требуется POST")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<20))
	if err != nil {
		writeError(w, 400, "не удалось прочитать резервную копию")
		return
	}
	catalog, err := xlsx.DecodeNomenclatureCatalog(raw)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	raw, err = json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	name := "Свойства Номенклатуры, резервная копия, " + time.Now().Format("02.01.2006, 15：04：05") + ".json"
	s.saveExport(w, "Номенклатура", name, raw)
}
