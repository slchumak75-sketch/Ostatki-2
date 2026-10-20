package model

// PeriodColumn описывает один помесячный столбец статистики продаж из шапки Excel.
type PeriodColumn struct {
	ColIndex     int     `json:"colIndex"`     // 1-based номер столбца в Excel (напр. 12 = L)
	ColLetter    string  `json:"colLetter"`    // Буквенный адрес столбца (L..AV)
	Label        string  `json:"label"`        // Оригинальный заголовок ("Октябрь 2023 г.")
	Year         int     `json:"year"`         // Год (2023..2026)
	Month        int     `json:"month"`        // Номер месяца (1..12)
	Completeness float64 `json:"completeness"` // Доля завершённости месяца (0..1; напр. 19/31 для неполного последнего месяца)
}

// RawItem представляет исходную строку номенклатуры из Excel-ведомости 1С.
// Цветовая заливка ячеек 1С (в т.ч. красные поля) полностью игнорируется — учитываются только значения ячеек.
type RawItem struct {
	ExcelRow      int       `json:"excelRow"`      // Номер строки в листе Excel (начиная с 8)
	Warehouse     string    `json:"warehouse"`     // Столбец 1 (A): Склад
	Group         string    `json:"group"`         // Столбец 2 (B): Группа номенклатуры
	SKU           string    `json:"sku"`           // Столбец 3 (C): Артикул
	Name          string    `json:"name"`          // Столбец 4 (D): Номенклатура
	Unit          string    `json:"unit"`          // Столбец 5 (E): Ед. изм.
	TotalExpense  float64   `json:"totalExpense"`  // Столбец 6 (F): Расход за период отчёта
	ClosingStock  float64   `json:"closingStock"`  // Столбец 7 (G): Конечный остаток
	ExistingOrder *float64  `json:"existingOrder"` // Столбец 8 (H): Исходное значение в файле (если было)
	PurchasePrice float64   `json:"purchasePrice"` // Столбец 9 (I): Цена последнего поставщика
	RetailPrice   float64   `json:"retailPrice"`   // Столбец 10 (J): Розничная цена
	RetailRaw     string    `json:"retailRaw"`     // Исходная строка розничной цены (для многострочных партий 1С)
	Supplier      string    `json:"supplier"`      // Столбец 11 (K): Последний поставщик
	MonthlySales  []float64 `json:"monthlySales"`  // Помесячные продажи по столбцам PeriodColumn
}

// WorkbookData хранит загруженную книгу Excel и её метаданные.
type WorkbookData struct {
	FileName     string         `json:"fileName"`
	FilePath     string         `json:"filePath,omitempty"`
	SheetName    string         `json:"sheetName"`
	Title        string         `json:"title"`
	CreatedDate  string         `json:"createdDate"`  // YYYY-MM-DD из docProps/core.xml
	ModifiedDate string         `json:"modifiedDate"` // YYYY-MM-DD из docProps/core.xml
	HeaderRow    int            `json:"headerRow"`    // Строка шапки (7)
	OrderCol     int            `json:"orderCol"`     // Целевой столбец «К закупкам» (8 = H)
	OrderHeader  string         `json:"orderHeader"`  // Заголовок столбца 8
	Periods      []PeriodColumn `json:"periods"`
	Items        []RawItem      `json:"items"`
}

// SeasonMode определяет режим учёта сезонности.
type SeasonMode string

const (
	SeasonHybrid     SeasonMode = "hybrid" // Эмпирический Байес: сезонный индекс группы + индивидуальный профиль SKU
	SeasonGroupOnly  SeasonMode = "group"  // Только сезонный индекс товарной группы
	SeasonItemOnly   SeasonMode = "item"   // Только индивидуальная сезонность SKU по одноимённым месяцам
	SeasonFlatSimple SeasonMode = "flat"   // Без сезонности (среднемесячный темп)
)

// RoundingMode определяет правило округления дробной потребности до целых единиц закупки.
type RoundingMode string

const (
	RoundNearest RoundingMode = "nearest" // Стандартное математическое округление (>= 0.5 -> вверх)
	RoundCeil    RoundingMode = "ceil"    // Гарантированное покрытие (любой дефицит >= 0.15 округляется вверх)
	RoundFloor   RoundingMode = "floor"   // Экономное округление вниз (только полные единицы >= 1.0)
)

// ForecastParams задаёт все параметры алгоритма расчёта столбца 8 («К закупкам») в сборке «Вариант 4».
type ForecastParams struct {
	PlanStartDate        string       `json:"planStartDate"`        // Дата начала горизонта планирования YYYY-MM-DD
	NormalizePartialLast bool         `json:"normalizePartialLast"` // Нормализовать неполный последний месяц по дате выгрузки Excel
	LastMonthDaysElapsed int          `json:"lastMonthDaysElapsed"` // Кол-во прошедших дней в последнем месяце (0 = авто из CreatedDate)
	HorizonDays          int          `json:"horizonDays"`          // Горизонт покрытия запаса в днях (по умолч. 30)
	LeadTimeDays         int          `json:"leadTimeDays"`         // Срок поставки в днях (по умолч. 4)
	SafetyStockPct       float64      `json:"safetyStockPct"`       // Базовый страховой запас в % (по умолч. 10)
	SeasonMode           SeasonMode   `json:"seasonMode"`           // Режим учёта сезонности (hybrid / group / item / flat)
	RecencyDecay         float64      `json:"recencyDecay"`         // Годовой коэффициент затухания старых лет (0.3..1.0, по умолч. 0.65)
	ShrinkageK           float64      `json:"shrinkageK"`           // Параметр сглаживания Байеса K (по умолч. 12.0)
	MinDisplayStock      int          `json:"minDisplayStock"`      // Витринный минимум для ходовых товаров ABC A/B (0 = выкл.)
	Rounding             RoundingMode `json:"rounding"`             // Режим округления (nearest / ceil / floor)
	WriteZeroValues      bool         `json:"writeZeroValues"`      // Записывать 0 в пустые ячейки столбца 8
	ColumnHeader         string       `json:"columnHeader"`         // Текст заголовка в ячейке H7 ("К закупкам")

	// Расширения «Варианта 4» (PRO SCM):
	OutlierFilter     bool    `json:"outlierFilter"`     // Подавление разовых оптовых выбросов (Winsorization)
	UseCrostonZ       bool    `json:"useCrostonZ"`       // Метод Croston/SBA для редких позиций класса Z
	AdaptiveSafetySLA bool    `json:"adaptiveSafetySLA"` // Адаптивный страховой запас по матрице ABC-XYZ
	BudgetCap         float64 `json:"budgetCap"`         // Лимит бюджета закупки в руб. (0 = без ограничения)
	MinSupplierOrder  float64 `json:"minSupplierOrder"`  // Порог минимального заказа поставщику в руб. (для контроля рентабельности)
	PackMultiple      int     `json:"packMultiple"`      // Минимальная кратность заказа (1 = поштучно)
}

// DefaultParams возвращает оптимальные параметры сборки «Вариант 4» по умолчанию.
func DefaultParams() ForecastParams {
	return ForecastParams{
		PlanStartDate:        "",
		NormalizePartialLast: true,
		LastMonthDaysElapsed: 0,
		HorizonDays:          30,
		LeadTimeDays:         4,
		SafetyStockPct:       10.0,
		SeasonMode:           SeasonHybrid,
		RecencyDecay:         0.65,
		ShrinkageK:           12.0,
		MinDisplayStock:      0,
		Rounding:             RoundNearest,
		WriteZeroValues:      true,
		ColumnHeader:         "К закупкам",
		OutlierFilter:        true,
		UseCrostonZ:          true,
		AdaptiveSafetySLA:    true,
		BudgetCap:            0,
		MinSupplierOrder:     50.0,
		PackMultiple:         1,
	}
}

// MatrixCell представляет одну ячейку матрицы ABC × XYZ (3×3).
type MatrixCell struct {
	Code       string  `json:"code"`       // AX, AY, AZ, BX, BY, BZ, CX, CY, CZ
	ItemCount  int     `json:"itemCount"`  // Количество SKU в сегменте
	OrderItems int     `json:"orderItems"` // Сколько SKU заказано
	OrderUnits int     `json:"orderUnits"` // Единиц к закупке
	OrderCost  float64 `json:"orderCost"`  // Сумма закупки (руб.)
}

// CalculatedItem содержит все расчётные показатели «Варианта 4» по одной строке ведомости.
type CalculatedItem struct {
	RawItem
	ABCClass          string      `json:"abcClass"`          // A, B, C или D (без продаж)
	XYZClass          string      `json:"xyzClass"`          // X (стабильный), Y (колеблющийся), Z (эпизодический), D
	ABCXYZ            string      `json:"abcxyz"`            // Комбинированный класс AX..CZ / DD
	CV                float64     `json:"cv"`                // Коэффициент вариации спроса
	NonZeroMonths     int         `json:"nonZeroMonths"`     // Месяцев с продажами > 0
	OutlierMonths     int         `json:"outlierMonths"`     // Месяцев со сглаженными разовыми оптовыми выбросами
	CappedSales       []float64   `json:"cappedSales"`       // Очищенный от аномалий ряд продаж
	SumSalesAll       float64     `json:"sumSalesAll"`       // Сумма продаж за все 37 мес.
	SumSalesLast12M   float64     `json:"sumSalesLast12M"`   // Продажи за последние 12 мес.
	ActiveMonths      int         `json:"activeMonths"`      // Длительность активной истории SKU (мес.)
	BaseMonthlyRate   float64     `json:"baseMonthlyRate"`   // Десезонализированный базовый спрос (ед./мес.)
	HorizonSeasonIdx  float64     `json:"horizonSeasonIdx"`  // Эффективный сезонный индекс на выбранный горизонт
	BayesWeight       float64     `json:"bayesWeight"`       // Доля индивидуальной сезонности SKU theta (0..1)
	EffectiveSafety   float64     `json:"effectiveSafety"`   // Фактический % страхового запаса с учётом ABC-XYZ SLA
	ForecastDemand    float64     `json:"forecastDemand"`    // Ожидаемый спрос за (HorizonDays + LeadTimeDays)
	SafetyUnits       float64     `json:"safetyUnits"`       // Страховой запас в единицах
	TargetStock       float64     `json:"targetStock"`       // Целевой запас на горизонт
	AutoOrderQty      int         `json:"autoOrderQty"`      // Автоматически рассчитанное значение «Вариант 4»
	FinalOrderQty     int         `json:"finalOrderQty"`     // Итоговое «К закупкам» (с учётом бюджета и ручных правок)
	ManualOverride    *int        `json:"manualOverride"`    // Ручная правка пользователя (nil если авто)
	FlatComparisonQty int         `json:"flatComparisonQty"` // Сколько было бы заказано БЕЗ учёта сезонности
	BudgetTrimmedQty  int         `json:"budgetTrimmedQty"`  // Сокращено оптимизатором лимита бюджета (ед.)
	PriorityScore     float64     `json:"priorityScore"`     // Приоритет позиции для бюджета (0..100)
	OrderCost         float64     `json:"orderCost"`         // Сумма закупки по позиции
	OrderRetailValue  float64     `json:"orderRetailValue"`  // Розничная стоимость закупаемой партии
	DaysOfSupply      float64     `json:"daysOfSupply"`      // Запас текущего остатка в днях
	IsOverstock       bool        `json:"isOverstock"`       // Признак неликвида / замороженного запаса (>365 дн.)
	OverstockValue    float64     `json:"overstockValue"`    // Замороженный капитал сверх годовой нормы (руб.)
	MonthlyForecast12 [12]float64 `json:"monthlyForecast12"` // Прогноз спроса SKU для каждого месяца 1..12
	Explanation       string      `json:"explanation"`       // Человекочитаемое объяснение расчёта
}

// GroupSeasonality описывает сезонный профиль товарной группы.
type GroupSeasonality struct {
	Group          string      `json:"group"`
	ItemCount      int         `json:"itemCount"`
	OrderItemCount int         `json:"orderItemCount"`
	TotalUnits     int         `json:"totalUnits"`
	TotalCost      float64     `json:"totalCost"`
	MonthlyIndices [12]float64 `json:"monthlyIndices"` // Индексы сезонности Янв(0)..Дек(11), среднее = 1.0
	PeriodTotals   []float64   `json:"periodTotals"`   // Фактические продажи группы по всем 37 периодам
	HorizonIndex   float64     `json:"horizonIndex"`   // Средний индекс группы на выбранный горизонт
	OverstockCost  float64     `json:"overstockCost"`  // Сумма неликвидов в группе
}

// WarehouseSummary агрегирует итоги по складу.
type WarehouseSummary struct {
	Warehouse      string  `json:"warehouse"`
	TotalItems     int     `json:"totalItems"`
	OrderItems     int     `json:"orderItems"`
	ZeroStockItems int     `json:"zeroStockItems"`
	TotalOrderQty  int     `json:"totalOrderQty"`
	TotalOrderCost float64 `json:"totalOrderCost"`
	TotalRetailVal float64 `json:"totalRetailVal"`
	OverstockItems int     `json:"overstockItems"`
	OverstockCost  float64 `json:"overstockCost"`
}

// SupplierSummary агрегирует заказ по поставщику.
type SupplierSummary struct {
	Supplier       string  `json:"supplier"`
	TotalItems     int     `json:"totalItems"`
	OrderItems     int     `json:"orderItems"`
	TotalOrderQty  int     `json:"totalOrderQty"`
	TotalOrderCost float64 `json:"totalOrderCost"`
	TotalRetailVal float64 `json:"totalRetailVal"`
	ShareOfBudget  float64 `json:"shareOfBudget"`
	BelowMinOrder  bool    `json:"belowMinOrder"` // Сумма заказа > 0, но ниже порога рентабельной доставки
}

// CalculationReport объединяет все расчёты сборки «Вариант 4».
type CalculationReport struct {
	BuildVariant          string             `json:"buildVariant"`
	FileName              string             `json:"fileName"`
	Title                 string             `json:"title"`
	CreatedDate           string             `json:"createdDate"`
	EffectiveStartDate    string             `json:"effectiveStartDate"`
	EffectiveEndDate      string             `json:"effectiveEndDate"`
	LastMonthCompleteness float64            `json:"lastMonthCompleteness"`
	Params                ForecastParams     `json:"params"`
	Periods               []PeriodColumn     `json:"periods"`
	PeriodTotals          []float64          `json:"periodTotals"`
	TotalItems            int                `json:"totalItems"`
	OrderItemsCount       int                `json:"orderItemsCount"`
	ZeroStockCount        int                `json:"zeroStockCount"`
	ManualOverrideCount   int                `json:"manualOverrideCount"`
	OutlierItemsCount     int                `json:"outlierItemsCount"`
	OverstockItemsCount   int                `json:"overstockItemsCount"`
	OverstockFrozenCost   float64            `json:"overstockFrozenCost"`
	UncappedOrderCost     float64            `json:"uncappedOrderCost"`
	BudgetTrimmedUnits    int                `json:"budgetTrimmedUnits"`
	TotalOrderUnits       int                `json:"totalOrderUnits"`
	TotalOrderCost        float64            `json:"totalOrderCost"`
	TotalRetailValue      float64            `json:"totalRetailValue"`
	ExpectedMargin        float64            `json:"expectedMargin"`
	FlatOrderUnits        int                `json:"flatOrderUnits"`
	FlatOrderCost         float64            `json:"flatOrderCost"`
	MatrixABCXYZ          [3][3]MatrixCell   `json:"matrixABCXYZ"`
	Groups                []GroupSeasonality `json:"groups"`
	Warehouses            []WarehouseSummary `json:"warehouses"`
	Suppliers             []SupplierSummary  `json:"suppliers"`
	Items                 []CalculatedItem   `json:"items"`
}
