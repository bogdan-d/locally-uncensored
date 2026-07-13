; Guard rail for a Windows productName change, dormant today.
;
; tauri.windows.conf.json deliberately pins productName to "Locally Uncensored"
; (only the window title says "LU") because the stock NSIS template discovers a
; previous install ONLY under the CURRENT product name's registry key. If a
; future release ever ships a different Windows productName without migration,
; every updating user ends up with TWO entries in Apps & Features and stale
; shortcuts that keep launching the old build (which re-offers the update,
; forever). The 2.5.7 rebrand nearly did exactly that.
;
; The !if below compiles this hook away while the name is unchanged. The moment
; a build uses a new productName, the hook turns live: it finds the old-name
; install and removes it silently before the new files land. The old
; uninstaller only deletes app data when its confirm-page checkbox is ticked -
; that page never shows in silent mode - so chats, settings, and models under
; the com.purpledoubled.locally-uncensored app-data folders survive untouched
; (the bundle identifier must never change).

!macro LU_REMOVE_OLD_NSIS ROOT
  ClearErrors
  ReadRegStr $R7 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\Locally Uncensored" "UninstallString"
  ReadRegStr $R8 ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\Locally Uncensored" "InstallLocation"
  ${If} $R7 != ""
    ; both values are written quoted by the old installer - strip the quotes
    StrCpy $R9 $R7 1
    ${If} $R9 == '"'
      StrCpy $R7 $R7 "" 1
      StrCpy $R9 $R7 1 -1
      ${If} $R9 == '"'
        StrCpy $R7 $R7 -1
      ${EndIf}
    ${EndIf}
    StrCpy $R9 $R8 1
    ${If} $R9 == '"'
      StrCpy $R8 $R8 "" 1
      StrCpy $R9 $R8 1 -1
      ${If} $R9 == '"'
        StrCpy $R8 $R8 -1
      ${EndIf}
    ${EndIf}

    ; the old app can still be running (manual installs while 2.5.6 is open);
    ; stop it and its children (sidecars) so no file stays locked. Older
    ; releases shipped the exe under the cargo name, newer ones under the
    ; product name - kill both spellings.
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "locally-uncensored.exe"'
    Pop $R9
    nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "Locally Uncensored.exe"'
    Pop $R9

    ${If} ${FileExists} "$R7"
      ${If} $R8 != ""
        ; _?= keeps the uninstaller running in place so ExecWait really waits;
        ; it then can't delete itself, so we sweep the leftovers ourselves
        ExecWait '"$R7" /S _?=$R8' $R9
        Delete "$R7"
        ; only remove the folder when it really is the old install dir
        StrCpy $R9 $R8 "" -18
        ${If} $R9 == "Locally Uncensored"
          RMDir /r "$R8"
        ${EndIf}
      ${Else}
        ; no recorded location: let it uninstall from its temp copy
        ExecWait '"$R7" /S' $R9
        Sleep 2000
      ${EndIf}
    ${EndIf}

    ; belt and braces - harmless when the uninstaller already cleaned these
    DeleteRegKey ${ROOT} "Software\Microsoft\Windows\CurrentVersion\Uninstall\Locally Uncensored"
    DeleteRegKey ${ROOT} "Software\PurpleDoubleD\Locally Uncensored"
    DeleteRegKey /ifempty ${ROOT} "Software\PurpleDoubleD"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
!if "${PRODUCTNAME}" != "Locally Uncensored"
  !insertmacro LU_REMOVE_OLD_NSIS HKCU
  !insertmacro LU_REMOVE_OLD_NSIS HKLM

  ; orphaned shortcuts of the old name in the active shell context (the old
  ; uninstaller removes its own; this only catches leftovers)
  Delete "$DESKTOP\Locally Uncensored.lnk"
  Delete "$SMPROGRAMS\Locally Uncensored.lnk"

  ; an old per-machine MSI (WiX) install lives under a {GUID} key; match it by
  ; display name + publisher and remove it quietly. Best effort: without
  ; elevation msiexec fails and we are simply no worse off than before.
  StrCpy $R5 0
  lu_wix_scan:
    EnumRegKey $R6 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R5
    StrCmp $R6 "" lu_wix_done
    IntOp $R5 $R5 + 1
    StrCpy $R9 $R6 1
    StrCmp $R9 "{" 0 lu_wix_scan
    ReadRegStr $R7 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R6" "DisplayName"
    ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R6" "Publisher"
    StrCmp "$R7$R8" "Locally UncensoredPurpleDoubleD" 0 lu_wix_scan
    nsExec::Exec '"$SYSDIR\msiexec.exe" /x $R6 /qn'
    Pop $R9
    Goto lu_wix_scan
  lu_wix_done:
!endif
!macroend
