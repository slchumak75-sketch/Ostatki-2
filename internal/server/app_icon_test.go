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
	if r <= b || g <= b {
		t.Fatal("expected warm cream icon background")
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
	// Регрессия батча-26: web/app-icon.png — вторая копия иконки (favicon GUI),
	// которую при замене дизайна забыли обновить; из неё браузер --app-окна берёт
	// иконку для панели задач. Старая иконка была бирюзовой (teal: g>r, b~149),
	// новая — тёплой кремовой (r>240, g>230, b>150).
	fav, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatal("decode favicon", err)
	}
	fr, fg, fb, _ := fav.At(32, 3).RGBA()
	fr8, fg8, fb8 := uint8(fr>>8), uint8(fg>>8), uint8(fb>>8)
	if !(fr8 > 200 && fg8 > 180 && fb8 > 150) {
		t.Fatalf("favicon must be the new warm icon, got RGB(%d,%d,%d) at (32,3)", fr8, fg8, fb8)
	}
}
