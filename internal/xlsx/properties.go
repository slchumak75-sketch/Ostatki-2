package xlsx

import (
	"bytes"
	"encoding/json"
	"strings"
)

func NomenclaturePropertyKey(sku, group, name string, warehouse ...string) string {
	parts := []string{"sku", strings.TrimSpace(sku)}
	if parts[1] == "" {
		parts = []string{"name", strings.TrimSpace(group), strings.TrimSpace(name)}
	}
	if len(warehouse) > 0 {
		parts = append(parts, strings.TrimSpace(warehouse[0]))
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(parts)
	return strings.TrimSuffix(b.String(), "\n")
}
