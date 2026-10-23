package xlsx

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/model"
)

// SavedStateZipEntry — путь к встроенному JSON-снимку полного состояния внутри .xlsx архива.
const SavedStateZipEntry = "docProps/ostatki_v4_state.json"

// SavedDatabaseTitleMarker — фиксированная часть имени файла сохранённой базы.
const SavedDatabaseTitleMarker = "Ведомость сохранена"

// FormatSavedDatabaseFilename не включает склад. Полноширинное двоеточие U+FF1A
// визуально разделяет время и, в отличие от ASCII-двоеточия, допустимо в имени Windows.
func FormatSavedDatabaseFilename(_ string, saveDate time.Time) string {
	return fmt.Sprintf("%s, %s.xlsx", SavedDatabaseTitleMarker, saveDate.Format("02.01.2006, 15：04：05"))
}

// BuildSavedDatabaseXLSX записывает актуальный столбец 8 («К закупкам») без потерь структуры 1С
// и встраивает внутрь .xlsx архива полный снимок состояния базы (docProps/ostatki_v4_state.json).
func BuildSavedDatabaseXLSX(
	rawXLSX []byte,
	headerRow int,
	orderCol int,
	headerText string,
	ordersByRow map[int]int,
	writeZeroValues bool,
	snapshot *model.SavedDatabaseSnapshot,
) ([]byte, error) {
	filledBytes, err := WriteOrderColumnLossless(rawXLSX, headerRow, orderCol, headerText, ordersByRow, writeZeroValues)
	if err != nil {
		return nil, err
	}
	if snapshot == nil {
		return filledBytes, nil
	}

	stateBytes, err := json.Marshal(snapshot)
	if err != nil {
		return nil, fmt.Errorf("сериализация состояния базы: %w", err)
	}

	zr, err := zip.NewReader(bytes.NewReader(filledBytes), int64(len(filledBytes)))
	if err != nil {
		return nil, fmt.Errorf("чтение подготовленного XLSX: %w", err)
	}

	var outBuf bytes.Buffer
	outBuf.Grow(len(filledBytes) + len(stateBytes) + 1024)
	zw := zip.NewWriter(&outBuf)

	for _, f := range zr.File {
		if f.Name == SavedStateZipEntry {
			continue
		}
		hdr := f.FileHeader
		hdr.Method = zip.Deflate
		w, err := zw.CreateHeader(&hdr)
		if err != nil {
			return nil, err
		}
		data, err := readZipEntry(f)
		if err != nil {
			return nil, err
		}
		if f.Name == "[Content_Types].xml" {
			data = ensureJSONContentTypeXML(data)
		}
		if _, err := w.Write(data); err != nil {
			return nil, err
		}
	}

	sw, err := zw.CreateHeader(&zip.FileHeader{
		Name:   SavedStateZipEntry,
		Method: zip.Deflate,
	})
	if err != nil {
		return nil, err
	}
	if _, err := sw.Write(stateBytes); err != nil {
		return nil, err
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}
	return outBuf.Bytes(), nil
}

// ExtractSavedDatabaseSnapshot извлекает сохранённое состояние приложения из байтов .xlsx архива.
// Если загружен обычный Excel-файл без встроенного состояния, возвращает (nil, nil).
func ExtractSavedDatabaseSnapshot(rawXLSX []byte) (*model.SavedDatabaseSnapshot, error) {
	zr, err := zip.NewReader(bytes.NewReader(rawXLSX), int64(len(rawXLSX)))
	if err != nil {
		return nil, fmt.Errorf("чтение XLSX архива: %w", err)
	}
	for _, f := range zr.File {
		if f.Name == SavedStateZipEntry {
			data, err := readZipEntry(f)
			if err != nil {
				return nil, err
			}
			var snap model.SavedDatabaseSnapshot
			if err := json.Unmarshal(data, &snap); err != nil {
				return nil, fmt.Errorf("разбор снимка состояния базы: %w", err)
			}
			return &snap, nil
		}
	}
	return nil, nil
}

// ReadSavedDatabaseMetadataFromFile быстро читает метаданные снимка базы с диска без распаковки листов.
func ReadSavedDatabaseMetadataFromFile(filePath string) (*model.SavedDatabaseSnapshot, error) {
	zr, err := zip.OpenReader(filePath)
	if err != nil {
		return nil, err
	}
	defer zr.Close()

	for _, f := range zr.File {
		if f.Name == SavedStateZipEntry {
			data, err := readZipEntry(f)
			if err != nil {
				return nil, err
			}
			var snap model.SavedDatabaseSnapshot
			if err := json.Unmarshal(data, &snap); err != nil {
				return nil, err
			}
			return &snap, nil
		}
	}
	return nil, nil
}

func ensureJSONContentTypeXML(raw []byte) []byte {
	s := string(raw)
	if strings.Contains(strings.ToLower(s), `extension="json"`) {
		return raw
	}
	closeIdx := strings.LastIndex(s, "</Types>")
	if closeIdx < 0 {
		return raw
	}
	injected := s[:closeIdx] + `<Default Extension="json" ContentType="application/json"/>` + s[closeIdx:]
	return []byte(injected)
}
