; Extra installer steps (see "nsis.include" in package.json).
;  - An optional page that offers to erase the existing data and start from zero.
;    For unattended installs the same thing is available as the switch  /WIPE  (and  /WIPEBACKUPS  to include backup copies).
;  - On uninstall, a question whether to keep or delete the data.
; Silent installs (the in-app updater, /S) never show these pages and never erase anything unless /WIPE is given.

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
Var WipeData
Var WipeBackups
Var WipeCheck
Var WipeBackupsCheck

Function WipePageCreate
  StrCpy $WipeData "0"
  StrCpy $WipeBackups "0"
  ${If} ${Silent}
    Abort
  ${EndIf}
  ; offer the choice only when there is something to erase
  ${IfNot} ${FileExists} "$APPDATA\${APP_FILENAME}\finance.db"
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "${PRODUCT_NAME} found data from an earlier installation on this computer.$\r$\n$\r$\nYour data is kept by default. Tick the box below only if you want to start again from zero."
  Pop $0
  ${NSD_CreateCheckbox} 0 46u 100% 12u "Erase my existing data and start from zero"
  Pop $WipeCheck
  ${NSD_CreateCheckbox} 12u 62u 95% 12u "Also delete my backup copies"
  Pop $WipeBackupsCheck
  EnableWindow $WipeBackupsCheck 0
  ${NSD_OnClick} $WipeCheck WipeCheckClicked
  ${NSD_CreateLabel} 0 82u 100% 36u "Erasing deletes the database (every account, transaction, budget and goal) and cannot be undone. Files you imported from, such as Excel workbooks or bank statements, are never touched. Backup copies are kept unless you tick the second box."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function WipeCheckClicked
  ${NSD_GetState} $WipeCheck $0
  ${If} $0 == ${BST_CHECKED}
    EnableWindow $WipeBackupsCheck 1
  ${Else}
    ${NSD_SetState} $WipeBackupsCheck ${BST_UNCHECKED}
    EnableWindow $WipeBackupsCheck 0
  ${EndIf}
FunctionEnd

Function WipePageLeave
  ${NSD_GetState} $WipeCheck $WipeData
  ${NSD_GetState} $WipeBackupsCheck $WipeBackups
  ${If} $WipeData == ${BST_CHECKED}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "This permanently erases all ${PRODUCT_NAME} data on this computer.$\r$\n$\r$\nAre you sure?" IDYES +2
    Abort
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  Page custom WipePageCreate WipePageLeave
!macroend
!endif

; Runs after the files are installed. $WipeData is "1" (ticked) or set by the /WIPE switch.
!macro customInstall
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/WIPE" $R1
  ${IfNot} ${Errors}
    StrCpy $WipeData "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/WIPEBACKUPS" $R1
  ${IfNot} ${Errors}
    StrCpy $WipeBackups "1"
  ${EndIf}
  ${If} $WipeData == "1"
    SetShellVarContext current
    Delete "$APPDATA\${APP_FILENAME}\finance.db"
    Delete "$APPDATA\${APP_FILENAME}\finance.db-wal"
    Delete "$APPDATA\${APP_FILENAME}\finance.db-shm"
    Delete "$APPDATA\${APP_FILENAME}\sample.db"
    Delete "$APPDATA\${APP_FILENAME}\sample.db-wal"
    Delete "$APPDATA\${APP_FILENAME}\sample.db-shm"
    Delete "$APPDATA\${APP_FILENAME}\app-state.json"
    Delete "$APPDATA\${APP_FILENAME}\finance.db.bak-*"
    ${If} $WipeBackups == "1"
      RMDir /r "$APPDATA\${APP_FILENAME}\backups"
    ${EndIf}
  ${EndIf}
!macroend

; Uninstall: ask whether to keep the data. Skipped for silent runs and for the automatic uninstall that happens during an update.
!macro customUnInstall
  ${IfNot} ${Silent}
  ${IfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your ${PRODUCT_NAME} data (database and backup copies) from this computer?$\r$\n$\r$\nChoose No to keep it, for example if you plan to install again later." IDNO keepdata
    SetShellVarContext current
    RMDir /r "$APPDATA\${APP_FILENAME}"
    keepdata:
  ${EndIf}
  ${EndIf}
!macroend
