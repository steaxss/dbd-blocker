; DBD Server Blocker - NSIS hooks (electron-builder `nsis.include`).
;
; Uninstall must not leave anything active on the machine: the WFP filters (permanent blocks are
; persistent and survive reboots), the WFP sublayer/provider and the ETW tracking session.
; Skipped during auto-updates (${isUpdated}) so permanent blocks survive an upgrade.

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing DBD Server Blocker firewall filters..."
    StrCpy $0 "$WINDIR\SysNative\WindowsPowerShell\v1.0\powershell.exe"
    IfFileExists "$0" +2 0
      StrCpy $0 "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
    IfFileExists "$INSTDIR\resources\scripts\wfp-block.ps1" 0 +3
      nsExec::ExecToLog '"$0" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\wfp-block.ps1" -Action purge'
      Pop $1
    nsExec::ExecToLog '"$SYSDIR\logman.exe" stop DBD-Blocker-ETW -ets'
    Pop $1
  ${endIf}
!macroend
