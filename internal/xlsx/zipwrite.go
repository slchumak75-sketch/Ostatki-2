package xlsx

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"hash/crc32"
	"time"
)

// Совместимость ZIP-контейнера с Excel: стандартный потоковый Writer архива
// ставит у каждой записи флаг 0x8 (data descriptor) — размеры и CRC дописываются
// ПОСЛЕ данных. Excel (2010/2013) на таких файлах запускает «проверку на уровне
// файла» с восстановлением содержимого («некоторые фрагменты восстановлены или
// удалены»). addZipPart формирует заголовок записи с заранее известными CRC и
// размерами — как делает сам Excel — и не оставляет у частей флага 0x8.
//
// ВАЖНО: CreateRaw, в отличие от CreateHeader, НЕ заполняет ReaderVersion —
// в заголовках остаётся недопустимый 0 («version needed to extract»), и Excel
// снова считает файл повреждённым. Явно ставим версию 2.0 и там, и там.

// zipPartTimestamp — фиксированная метка времени частей: выгрузки детерминированы.
var zipPartTimestamp = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func addZipPart(zw *zip.Writer, name string, content []byte) error {
	var compressed bytes.Buffer
	fw, err := flate.NewWriter(&compressed, flate.DefaultCompression)
	if err != nil {
		return err
	}
	if _, err := fw.Write(content); err != nil {
		return err
	}
	if err := fw.Close(); err != nil {
		return err
	}
	h := &zip.FileHeader{
		Name:           name,
		Method:         zip.Deflate,
		Modified:       zipPartTimestamp,
		CreatorVersion: 20,
		ReaderVersion:  20,
	}
	h.UncompressedSize64 = uint64(len(content))
	h.CompressedSize64 = uint64(compressed.Len())
	h.CRC32 = crc32.ChecksumIEEE(content)
	w, err := zw.CreateRaw(h)
	if err != nil {
		return err
	}
	_, err = w.Write(compressed.Bytes())
	return err
}
