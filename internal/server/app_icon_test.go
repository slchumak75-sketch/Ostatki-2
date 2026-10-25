package server

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestApplicationIconAssets(t *testing.T) {
	master, err := os.ReadFile(filepath.Join("..", "..", "cmd", "ostatki", "winres", "icon.png"))
	if err != nil {
		t.Fatal(err)
	}
	im, err := png.Decode(bytes.NewReader(master))
	if err != nil {
		t.Fatal(err)
	}
	if im.Bounds().Dx() != 256 || im.Bounds().Dy() != 256 {
		t.Fatal("Windows master icon must be 256 square")
	}
	r, g, b, _ := im.At(128, 20).RGBA()
	if r <= g*2 || r <= b*2 {
		t.Fatal("expected red icon background")
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "cmd", "ostatki", "winres", "icon.ico"))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 6 || binary.LittleEndian.Uint16(raw[2:4]) != 1 {
		t.Fatal("invalid ICO")
	}
	count := int(binary.LittleEndian.Uint16(raw[4:6]))
	if count != 9 || len(raw) < 6+16*count {
		t.Fatal("missing Windows icon sizes")
	}
	sizes := map[int]bool{}
	for i := 0; i < count; i++ {
		e := raw[6+16*i : 6+16*(i+1)]
		size := int(e[0])
		if size == 0 {
			size = 256
		}
		sizes[size] = true
		n := uint64(binary.LittleEndian.Uint32(e[8:12]))
		offset := uint64(binary.LittleEndian.Uint32(e[12:16]))
		if offset+n > uint64(len(raw)) {
			t.Fatal("ICO entry out of bounds")
		}
		cfg, err := png.DecodeConfig(bytes.NewReader(raw[offset : offset+n]))
		if err != nil || cfg.Width != size || cfg.Height != size {
			t.Fatalf("invalid %dpx ICO entry: %v", size, err)
		}
	}
	for _, size := range []int{16, 20, 24, 32, 40, 48, 64, 128, 256} {
		if !sizes[size] {
			t.Fatalf("missing %dpx icon", size)
		}
	}
	rec := httptest.NewRecorder()
	New(false).Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/app-icon.png", nil))
	if rec.Code != 200 {
		t.Fatal("favicon not served", rec.Code)
	}
	if _, err := png.Decode(bytes.NewReader(rec.Body.Bytes())); err != nil {
		t.Fatal("invalid favicon", err)
	}
}
