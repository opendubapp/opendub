; OpenDub for Windows, with everything inside it.
;
; The ordinary installer is a megabyte and fetches uv, a Python and a
; gigabyte of packages the first time it runs — three things that can fail on
; a machine none of us can see, and on Windows it also leaves out ffmpeg,
; which the system does not provide. This one installs all of it at once and
; has no first run.
;
;   makensis full.nsi
Unicode true
SetCompressor /SOLID lzma

!define NAME "OpenDub"
!define PUB "OpenDub"
!define EXE "OpenDub.exe"

Name "${NAME}"
OutFile "build/OpenDub-Setup-full.exe"
; Per user, under AppData: no administrator, no UAC prompt, and the same
; place the launcher already keeps everything.
InstallDir "$LOCALAPPDATA\OpenDub"
RequestExecutionLevel user
ShowInstDetails show

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  ; Everything: the program, its Python, its packages, ffmpeg, and the
  ; pipeline that runs in the page.
  File /r "build\full\payload\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${NAME}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${NAME}.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NAME}" "DisplayName" "${NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NAME}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NAME}" "Publisher" "${PUB}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NAME}" "UninstallString" "$INSTDIR\Uninstall.exe"

  ; So a page can ask the system to open OpenDub, the way the Mac app
  ; answers opendub:// — the card's "Start OpenDub" link depends on it.
  WriteRegStr HKCU "Software\Classes\opendub" "" "URL:OpenDub"
  WriteRegStr HKCU "Software\Classes\opendub" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\opendub\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${NAME}.lnk"
  Delete "$DESKTOP\${NAME}.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${NAME}"
  DeleteRegKey HKCU "Software\Classes\opendub"
  ; The models and any work folder are the person's, and are several
  ; gigabytes: say nothing and leave them, rather than deleting quietly.
  RMDir /r "$INSTDIR\python"
  RMDir /r "$INSTDIR\site-packages"
  RMDir /r "$INSTDIR\ffmpeg"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\Uninstall.exe"
SectionEnd
