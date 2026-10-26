# Иконка Варианта 6

Красный квадрат с белым контуром домика подготовлен из предоставленного пользователем
образца. Внешнее светлое поле обрезано; углы имеют прозрачность.

- `icon.png`: мастер 256×256.
- `icon.ico`: 16, 20, 24, 32, 40, 48, 64, 128 и 256 пикселей.
- `../../../internal/server/web/app-icon.png`: значок вкладки 64×64.
- `winres.json`: использует ICO **строкой**, чтобы включать все его размеры,
  а не как массив из одного изображения (это встроило бы только один кадр).
- `../rsrc_windows_amd64.syso`: готовые ресурсы для `go build` Windows amd64,
  включая неизменённые манифест и сведения о версии.

При изменении `icon.png` ICO и favicon можно обновить с помощью Pillow:

```python
from PIL import Image
im = Image.open('cmd/ostatki/winres/icon.png')
im.save('cmd/ostatki/winres/icon.ico', format='ICO',
        sizes=[(n, n) for n in [16, 20, 24, 32, 40, 48, 64, 128, 256]])
im.resize((64, 64), Image.Resampling.LANCZOS).save('internal/server/web/app-icon.png')
```

После этого обязательно пересобрать отслеживаемый ресурс:

```sh
go install github.com/tc-hib/go-winres@v0.3.3
cd cmd/ostatki
go-winres make --in winres/winres.json --arch amd64 --out rsrc
```

Сохранённые Варианты 1–5 не изменяются. Windows может временно показывать старую иконку
из кэша Проводника; новая сборка EXE уже содержит новый значок.
