// Package model описывает структуры данных, общие для парсера XLSX,
// алгоритма прогноза и JSON-API веб-интерфейса.
//
// JSON-имена полей (camelCase) — контракт с фронтендом (internal/app/web/app.js)
// и с Python dev-сервером (tools/dev_server.py). Не переименовывать без правок там.
package model

// Month — один помесячный столбец исходной ведомости.
type Month struct {
	Year  int    `json:"year"`
	Month int    `json:"month"` // 1..12
	Label string `json:"label"` // "Октябрь 2023"
}

// ForecastMonth — месяц периода прогноза. Remainder=true для остатка неполного месяца.
type ForecastMonth struct {
	Year      int    `json:"year"`
	Month     int    `json:"month"`
	Label     string `json:"label"`
	Remainder bool   `json:"remainder"`
}

// Params — параметры алгоритма «К закупке». См. docs/ALGORITHM.md.
type Params struct {
	Horizon       int     `json:"horizon"`       // на сколько ПОЛНЫХ месяцев вперёд закупаем
	SafetyPercent float64 `json:"safetyPercent"` // страховой запас, % от прогноза
	LeadDays      float64 `json:"leadDays"`      // срок поставки, дней
	DeadMonths    int     `json:"deadMonths"`    // нет продаж N мес. -> не закупать
	PartialLast   bool    `json:"partialLast"`   // последний месячный столбец неполный
	UseTrend      bool    `json:"useTrend"`      // затухающий тренд для крупных SKU
	ShrinkageK    float64 `json:"shrinkageK"`    // сглаживание сезонности товара к группе
}

// DefaultParams — значения по умолчанию (совпадают с tools/forecast.py).
func DefaultParams() Params {
	return Params{
		Horizon:       3,
		SafetyPercent: 20,
		LeadDays:      14,
		DeadMonths:    12,
		PartialLast:   true,
		UseTrend:      true,
		ShrinkageK:    30,
	}
}

// Item — одна строка ведомости как прочитана из файла (без расчётов).
type Item struct {
	Warehouse     string    `json:"warehouse"`
	Group         string    `json:"group"`
	Article       string    `json:"article"`
	Name          string    `json:"name"`
	Unit          string    `json:"unit"`
	Rashod        *float64  `json:"rashod"`        // столбец «Расход» (как в файле)
	Stock         float64   `json:"stock"`         // конечный остаток
	PurchasePrice *float64  `json:"purchasePrice"` // цена последнего поставщика
	RetailPrice   *float64  `json:"retailPrice"`   // nil, если пусто (в файле — когда остаток 0)
	Supplier      string    `json:"supplier"`
	Sales         []float64 `json:"sales"` // по месяцам, длина == len(Months)
}

// Row — Item плюс все расчётные показатели.
type Row struct {
	Item
	ID              int       `json:"id"`
	Sales12         float64   `json:"sales12"`
	Sales36         float64   `json:"sales36"` // фактически: продажи за все полные месяцы
	AvgMonthly12    float64   `json:"avgMonthly12"`
	Seasonal        []float64 `json:"seasonal"` // 12 индексов товара
	BaseLevel       float64   `json:"baseLevel"`
	TrendFactor     float64   `json:"trendFactor"`
	Forecast        []float64 `json:"forecast"` // по месяцам прогноза
	ForecastTotal   float64   `json:"forecastTotal"`
	LeadDemand      float64   `json:"leadDemand"`
	SafetyStock     float64   `json:"safetyStock"`
	Need            float64   `json:"need"`
	Recommend       float64   `json:"recommend"` // К ЗАКУПКЕ
	RetailEstimated bool      `json:"retailEstimated"`
	RetailEffective *float64  `json:"retailEffective"`
	MarginPct       *float64  `json:"marginPct"`
	MarkupPct       *float64  `json:"markupPct"`
	ProfitPerUnit   float64   `json:"profitPerUnit"`
	StockPurchase   float64   `json:"stockPurchase"`
	StockRetail     float64   `json:"stockRetail"`
	OrderCost       float64   `json:"orderCost"`
	ExpectedProfit  float64   `json:"expectedProfit"`
	MonthsOfStock   *float64  `json:"monthsOfStock"`
	LastSaleLabel   *string   `json:"lastSaleLabel"`
	MonthsSinceSale *int      `json:"monthsSinceSale"`
	Status          string    `json:"status"` // urgent|order|ok|excess|dead
	Regularity      string    `json:"regularity"`
	ABC             string    `json:"abc"`
	GrossProfit12   float64   `json:"grossProfit12"`
}

// Summary — KPI для шапки интерфейса.
type Summary struct {
	SKU                 int      `json:"sku"`
	Warehouses          int      `json:"warehouses"`
	Groups              int      `json:"groups"`
	Suppliers           int      `json:"suppliers"`
	StockUnits          float64  `json:"stockUnits"`
	StockPurchase       float64  `json:"stockPurchase"`
	StockRetail         float64  `json:"stockRetail"`
	PotentialProfit     float64  `json:"potentialProfit"`
	AvgMarginPct        *float64 `json:"avgMarginPct"`
	MedianMarkupPct     *float64 `json:"medianMarkupPct"`
	OrderSKU            int      `json:"orderSku"`
	OrderUnits          float64  `json:"orderUnits"`
	OrderBudget         float64  `json:"orderBudget"`
	OrderExpectedProfit float64  `json:"orderExpectedProfit"`
	UrgentSKU           int      `json:"urgentSku"`
	DeadSKU             int      `json:"deadSku"` // только с остатком > 0
	DeadValue           float64  `json:"deadValue"`
	ZeroActiveSKU       int      `json:"zeroActiveSku"`
	ExcessSKU           int      `json:"excessSku"`
	Sales12Units        float64  `json:"sales12Units"`
	Sales36Units        float64  `json:"sales36Units"`
}

// Agg — агрегат по группе / поставщику / складу.
type Agg struct {
	Name          string  `json:"name"`
	SKU           int     `json:"sku"`
	StockUnits    float64 `json:"stockUnits"`
	StockPurchase float64 `json:"stockPurchase"`
	StockRetail   float64 `json:"stockRetail"`
	Sales12       float64 `json:"sales12"`
	OrderSKU      int     `json:"orderSku"`
	OrderUnits    float64 `json:"orderUnits"`
	OrderBudget   float64 `json:"orderBudget"`
	GrossProfit12 float64 `json:"grossProfit12"`
}

// State — полное состояние, которое API отдаёт фронтенду.
type State struct {
	FileName          string              `json:"fileName"`
	Version           string              `json:"version"`
	LoadedAt          string              `json:"loadedAt"`
	Params            Params              `json:"params"`
	Months            []Month             `json:"months"`
	ForecastMonths    []ForecastMonth     `json:"forecastMonths"`
	SeasonalGlobal    []float64           `json:"seasonalGlobal"`
	SeasonalByGroup   map[string][]float64 `json:"seasonalByGroup"`
	Rows              []Row               `json:"rows"`
	Summary           Summary             `json:"summary"`
	GroupsAgg         []Agg               `json:"groupsAgg"`
	SuppliersAgg      []Agg               `json:"suppliersAgg"`
	WarehousesAgg     []Agg               `json:"warehousesAgg"`
	Warnings          []string            `json:"warnings"`
}
