package model

// NomenclatureRecord is a warehouse-scoped snapshot. Stock is informational:
// importing a catalog or reference must never replace the stock received from 1C.
type NomenclatureRecord struct {
	// ReferenceRows preserves distinct duplicate 1C lines in hidden metadata.
	// Kept as JSON text so the public six-column spreadsheet remains unchanged.
	ReferenceRows string  `json:"referenceRows,omitempty"`
	Warehouse     string  `json:"warehouse"`
	SKU           string  `json:"sku"`
	Name          string  `json:"name"`
	Checked       bool    `json:"checked"`
	Rating        int     `json:"rating"`
	Stock         float64 `json:"stock"`
	// Group preserves the identity of legacy items without an article number.
	Group string `json:"group,omitempty"`
}

type NomenclatureCatalog struct {
	FileName     string                        `json:"fileName,omitempty"`
	StoredAt     string                        `json:"storedAt,omitempty"`
	SavedAt      string                        `json:"savedAt,omitempty"`
	Version      int                           `json:"version"`
	Properties   map[string]bool               `json:"properties"`
	Nomenclature map[string]NomenclatureRecord `json:"nomenclature"`
}
