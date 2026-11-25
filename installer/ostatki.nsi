; Батч-83: установщик программы «Остатки 2» (Вариант 7.x).
; Собирается в CI на Ubuntu: makensis -DVERSION=7.27 -DSRCEXE=... -DOUTFILE=...
; Установка — в профиль пользователя, без прав администратора:
;   %LOCALAPPDATA%\Programs\Ostatki2\OstatkiZakupki.exe
; Ярлыки на рабочем столе и в меню «Пуск», удаление — через «Программы
; и компоненты». Данные программы живут в %APPDATA%\Ostatki2 и
; переустановкой/обновлением не трогаются.
Unicode true

!ifndef VERSION
  !define VERSION "0.0"
!endif
!ifndef SRCEXE
  !define SRCEXE "OstatkiZakupki.exe"
!endif
!ifndef OUTFILE
  !define OUTFILE "OstatkiZakupki_Setup.exe"
!endif

Name "Остатки 2 — Вариант ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Ostatki2"
InstallDirRegKey HKCU "Software\Ostatki2" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0.0"
VIAddVersionKey "ProductName" "Остатки 2"
VIAddVersionKey "FileDescription" "Установка программы «Остатки 2» (Вариант ${VERSION})"
VIAddVersionKey "FileVersion" "${VERSION}"

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Section "Основная программа"
  SetOutPath "$INSTDIR"
  ; Если программа сейчас запущена, её EXE занят: честно просим закрыть
  ; окно и повторяем, а не падаем с непонятной ошибкой копирования.
  IfFileExists "$INSTDIR\OstatkiZakupki.exe" 0 file_free
  StrCpy $0 0
  retry_delete:
    ClearErrors
    Delete "$INSTDIR\OstatkiZakupki.exe"
    IfErrors 0 file_free
    IntOp $0 $0 + 1
    IntCmp $0 1 0 ask_user ask_user
    Sleep 800 ; только что закрытая программа освобождает файл не мгновенно
    Goto retry_delete
  ask_user:
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Программа «Остатки 2» сейчас запущена, и её файл занят.$\n$\nЗакройте окно программы и нажмите «Повторить»." IDRETRY retry_delete
    Abort "Установка отменена: программа «Остатки 2» запущена."
  file_free:
  File "/oname=OstatkiZakupki.exe" "${SRCEXE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Остатки 2"
  CreateShortcut "$SMPROGRAMS\Остатки 2\Остатки 2.lnk" "$INSTDIR\OstatkiZakupki.exe"
  CreateShortcut "$DESKTOP\Остатки 2.lnk" "$INSTDIR\OstatkiZakupki.exe"
  WriteRegStr HKCU "Software\Ostatki2" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "DisplayName" "Остатки 2 — Вариант ${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "Publisher" "Ostatki 2"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "DisplayIcon" "$INSTDIR\OstatkiZakupki.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "EstimatedSize" 12500
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Остатки 2.lnk"
  Delete "$SMPROGRAMS\Остатки 2\Остатки 2.lnk"
  RMDir "$SMPROGRAMS\Остатки 2"
  Delete "$INSTDIR\OstatkiZakupki.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Ostatki2"
  DeleteRegKey HKCU "Software\Ostatki2"
SectionEnd
