!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
Var SetupDialog
Var SetupFfmpeg
Var SetupWinget
Var SetupSongs
Var SetupSongsInput
Var SetupDownload
Var SetupDownloadState
Var SetupBusy

LangString setupTitle 1033 "First-time setup"
LangString setupTitle 1054 "ตั้งค่าครั้งแรก"
LangString setupTitle 2052 "首次设置"
LangString setupSubtitle 1033 "Check audio tools and choose your default osu! Songs folder."
LangString setupSubtitle 1054 "ตรวจสอบเครื่องมือเสียงและเลือกโฟลเดอร์ Songs ของ osu!"
LangString setupSubtitle 2052 "检查音频工具并选择默认的 osu! Songs 文件夹。"
LangString setupChecking 1033 "Checking FFmpeg and osu!…"
LangString setupChecking 1054 "กำลังตรวจสอบ FFmpeg และ osu!…"
LangString setupChecking 2052 "正在检查 FFmpeg 和 osu!…"
LangString setupFound 1033 "FFmpeg detected; no download needed."
LangString setupFound 1054 "พบ FFmpeg แล้ว ไม่ต้องดาวน์โหลด"
LangString setupFound 2052 "已检测到 FFmpeg，无需下载。"
LangString setupMissing 1033 "FFmpeg not found. Optional for normal-speed preview and original samples."
LangString setupMissing 1054 "ไม่พบ FFmpeg ตัวอย่างความเร็วปกติและเสียงรูปแบบเดิมยังใช้ได้"
LangString setupMissing 2052 "未找到 FFmpeg。正常速度预览及原格式样本无需安装。"
LangString setupDownload 1033 "Install FFmpeg with winget if missing (internet required)"
LangString setupDownload 1054 "ติดตั้ง FFmpeg ด้วย winget ถ้ายังไม่มี (ต้องใช้อินเทอร์เน็ต)"
LangString setupDownload 2052 "缺少 FFmpeg 时通过 winget 安装（需要联网）"
LangString setupNoWinget 1033 "winget is unavailable; the app can show manual installation instructions."
LangString setupNoWinget 1054 "ไม่พบ winget แอปสามารถแสดงวิธีติดตั้งด้วยตนเองได้"
LangString setupNoWinget 2052 "winget 不可用；应用内可查看手动安装说明。"
LangString setupSongs 1033 "Default osu! Songs folder (leave blank to choose later):"
LangString setupSongs 1054 "โฟลเดอร์ Songs ของ osu! เริ่มต้น (เว้นว่างเพื่อเลือกภายหลัง):"
LangString setupSongs 2052 "默认 osu! Songs 文件夹（留空可稍后选择）："
LangString setupBrowse 1033 "Browse…"
LangString setupBrowse 1054 "เลือก…"
LangString setupBrowse 2052 "浏览…"
LangString setupInvalid 1033 "Choose an existing Songs folder, or leave the field blank."
LangString setupInvalid 1054 "เลือกโฟลเดอร์ Songs ที่มีอยู่ หรือเว้นว่างไว้"
LangString setupInvalid 2052 "请选择已有的 Songs 文件夹，或留空。"
LangString setupFailed 1033 "FFmpeg installation did not complete. The app is installed; retry FFmpeg from its install prompt."
LangString setupFailed 1054 "ติดตั้ง FFmpeg ไม่สำเร็จ แอปติดตั้งแล้ว สามารถลอง FFmpeg อีกครั้งในแอปได้"
LangString setupFailed 2052 "FFmpeg 安装未完成。应用已安装，可在应用提示中重试。"

!macro customInstallMode
  StrCpy $isForceCurrentInstall 1
!macroend

!macro customInit
  ; This installer supports only the current user; no scope-selection page.
  ${If} ${isForAllUsers}
    MessageBox MB_OK "This installer installs for the current user only." /SD IDOK
    Quit
  ${EndIf}
  StrCpy $hasPerMachineInstallation 0
  !insertmacro setInstallModePerUser
  StrCpy $SetupDownloadState ${BST_UNCHECKED}
  StrCpy $SetupBusy 0
!macroend

!macro customPageAfterChangeDir
  Page custom SetupPage SetupLeave
!macroend

Function SetupPage
  StrCpy $SetupBusy 0
  !insertmacro MUI_HEADER_TEXT "$(setupTitle)" "$(setupSubtitle)"
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 0
  InitPluginsDir
  File /oname=$PLUGINSDIR\detect-environment.ps1 "${PROJECT_DIR}\build\detect-environment.ps1"
  nsExec::ExecToStack /TIMEOUT=18000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\detect-environment.ps1" -OutputFile "$PLUGINSDIR\environment.ini" -AppDirectory "$INSTDIR"'
  Pop $0
  Pop $1
  ReadINIStr $SetupFfmpeg "$PLUGINSDIR\environment.ini" "environment" "ffmpeg"
  ReadINIStr $SetupWinget "$PLUGINSDIR\environment.ini" "environment" "winget"
  ReadINIStr $SetupSongs "$PLUGINSDIR\environment.ini" "environment" "songs"
  ; A previous explicit choice wins over fresh discovery.
  ReadRegStr $0 HKCU "Software\KarinistakenXD\BMS-to-osu-mania-Hitsound" "OsuSongsFolder"
  ${If} $0 != ""
    IfFileExists "$0\*" 0 +2
    StrCpy $SetupSongs $0
  ${EndIf}
  nsDialogs::Create 1018
  Pop $SetupDialog
  ${If} $SetupDialog == error
    Abort
  ${EndIf}
  ${If} $SetupFfmpeg != ""
    ${NSD_CreateLabel} 0 0 100% 32u "$(setupFound)"
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 32u "$(setupMissing)"
  ${EndIf}
  Pop $0
  ${NSD_CreateCheckbox} 0 36u 100% 24u "$(setupDownload)"
  Pop $SetupDownload
  ${NSD_SetState} $SetupDownload $SetupDownloadState
  ${If} $SetupFfmpeg != ""
  ${OrIf} $SetupWinget == ""
    ${NSD_SetState} $SetupDownload ${BST_UNCHECKED}
    EnableWindow $SetupDownload 0
  ${EndIf}
  ${If} $SetupWinget == ""
    ${NSD_CreateLabel} 0 62u 100% 24u "$(setupNoWinget)"
    Pop $0
  ${EndIf}
  ${NSD_CreateLabel} 0 92u 100% 24u "$(setupSongs)"
  Pop $0
  ${NSD_CreateText} 0 119u 78% 14u "$SetupSongs"
  Pop $SetupSongsInput
  ${NSD_CreateButton} 80% 119u 20% 14u "$(setupBrowse)"
  Pop $0
  ${NSD_OnClick} $0 SetupBrowse
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  nsDialogs::Show
FunctionEnd

Function SetupBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "$(setupSongs)" "$SetupSongs"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $SetupSongsInput $0
  ${EndIf}
FunctionEnd

Function SetupLeave
  ${If} $SetupBusy == 1
    Abort
  ${EndIf}
  ${NSD_GetText} $SetupSongsInput $SetupSongs
  ${If} $SetupSongs != ""
    IfFileExists "$SetupSongs\*" validSongs
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(setupInvalid)"
    Abort
  ${EndIf}
  validSongs:
  ${NSD_GetState} $SetupDownload $SetupDownloadState
  StrCpy $SetupBusy 1
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 0
FunctionEnd

!macro customInstall
  StrCpy $0 "en"
  ${If} $LANGUAGE == 1054
    StrCpy $0 "th"
  ${ElseIf} $LANGUAGE == 2052
    StrCpy $0 "zh"
  ${EndIf}
  WriteRegStr HKCU "Software\KarinistakenXD\BMS-to-osu-mania-Hitsound" "Language" $0
  ${If} $SetupSongs != ""
    WriteRegStr HKCU "Software\KarinistakenXD\BMS-to-osu-mania-Hitsound" "OsuSongsFolder" "$SetupSongs"
  ${EndIf}
  ${If} $SetupDownloadState == ${BST_CHECKED}
  ${AndIf} $SetupFfmpeg == ""
  ${AndIf} $SetupWinget != ""
    DetailPrint "Installing FFmpeg with winget…"
    nsExec::ExecToLog /TIMEOUT=300000 '"$SetupWinget" install --id Gyan.FFmpeg -e --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(setupFailed)" /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
!endif
