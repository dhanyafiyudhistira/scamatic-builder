!define SCAMATIC_SERVICE_NAME "SCAMATICRuntime"
!define SCAMATIC_SERVICE_DISPLAY_NAME "SCAMATIC Local Runtime"

Var ScamaticMongoUri
Var ScamaticAdminEmail
Var ScamaticAdminPassword
Var ScamaticAdminPasswordConfirm
Var ScamaticConnectorAllowedHosts
Var ScamaticConnectorAllowedPrivateHosts
Var ScamaticChartMongoAllowedHosts
Var ScamaticChartMongoAllowedPrivateHosts
Var ScamaticConfigureRuntime
Var ScamaticMasterKey
Var ScamaticMasterKeyConfirm
Var ScamaticDeploymentMode
Var ScamaticRuntimeDialog
Var ScamaticScrollBar
Var ScamaticScrollUpButton
Var ScamaticScrollDownButton
Var ScamaticScrollOffset
Var ScamaticScrollMax
Var ScamaticMongoInput
Var ScamaticNewDeploymentRadio
Var ScamaticExistingDatabaseRadio
Var ScamaticMasterKeyLabel
Var ScamaticMasterKeyInput
Var ScamaticMasterKeyConfirmLabel
Var ScamaticMasterKeyConfirmInput
Var ScamaticEmailInput
Var ScamaticPasswordInput
Var ScamaticPasswordConfirmInput
Var ScamaticConnectorHostsInput
Var ScamaticConnectorPrivateHostsInput
Var ScamaticChartMongoHostsInput
Var ScamaticChartMongoPrivateHostsInput
Var ScamaticIntroLabel
Var ScamaticMongoLabel
Var ScamaticEmailLabel
Var ScamaticPasswordLabel
Var ScamaticPasswordConfirmLabel
Var ScamaticAllowlistLabel
Var ScamaticConnectorHostsLabel
Var ScamaticConnectorPrivateHostsLabel
Var ScamaticChartMongoHostsLabel
Var ScamaticChartMongoPrivateHostsLabel
Var ScamaticFooterLabel

!macro SCAMATIC_SCROLL_CONTROL HANDLE
  System::Call 'USER32::GetWindowRect(p${HANDLE},@r2)'
  System::Call 'USER32::MapWindowPoints(p0,p$ScamaticRuntimeDialog,pr2,i2)'
  System::Call '*$2(i.r3,i.r4,i.r5,i.r6)'
  IntOp $4 $4 + $R1
  System::Call 'USER32::SetWindowPos(p${HANDLE},p0,i$3,i$4,i0,i0,i0x15)'
!macroend

!macro SCAMATIC_PAGE_RUNTIME_SETUP
  Page custom ScamaticRuntimeSetupCreate ScamaticRuntimeSetupLeave
!macroend

Function ScamaticRuntimeSetupCreate
  IfFileExists "$APPDATA\SCAMATIC\runtime.env" 0 +2
    Abort

  ${GetOptions} $CMDLINE "/P" $R0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}

  StrCmp $ScamaticMongoUri "" 0 +2
    StrCpy $ScamaticMongoUri "mongodb://127.0.0.1:27017/scamatic"
  StrCmp $ScamaticAdminEmail "" 0 +2
    StrCpy $ScamaticAdminEmail "admin@scada.local"
  StrCmp $ScamaticDeploymentMode "" 0 +2
    StrCpy $ScamaticDeploymentMode "new"

  !insertmacro MUI_HEADER_TEXT "Konfigurasi Runtime" "Setup awal untuk service SCAMATIC di perangkat ini."
  nsDialogs::Create 1018
  Pop $ScamaticRuntimeDialog
  ${If} $ScamaticRuntimeDialog == error
    Abort
  ${EndIf}
  StrCpy $ScamaticScrollOffset 0

  ${NSD_CreateLabel} 0 0 94% 28u "Pilih jenis deployment. Database yang sudah berisi Data Source/Chart wajib memakai master key lama agar secret tetap dapat dibuka."
  Pop $ScamaticIntroLabel

  ${NSD_CreateRadioButton} 0 34u 94% 12u "Deployment baru — buat master key baru"
  Pop $ScamaticNewDeploymentRadio
  ${NSD_OnClick} $ScamaticNewDeploymentRadio ScamaticRuntimeSetupModeChanged

  ${NSD_CreateRadioButton} 0 50u 94% 12u "Database existing — gunakan master key deployment lama"
  Pop $ScamaticExistingDatabaseRadio
  ${NSD_OnClick} $ScamaticExistingDatabaseRadio ScamaticRuntimeSetupModeChanged

  StrCmp $ScamaticDeploymentMode "existing" 0 scamatic_check_new_mode
    ${NSD_Check} $ScamaticExistingDatabaseRadio
    Goto scamatic_mode_checked
  scamatic_check_new_mode:
    ${NSD_Check} $ScamaticNewDeploymentRadio
  scamatic_mode_checked:

  ${NSD_CreateLabel} 0 72u 94% 10u "Master key lama (64 karakter hex atau 32-byte base64)"
  Pop $ScamaticMasterKeyLabel
  ${NSD_CreatePassword} 0 84u 94% 13u "$ScamaticMasterKey"
  Pop $ScamaticMasterKeyInput

  ${NSD_CreateLabel} 0 103u 94% 10u "Konfirmasi master key lama"
  Pop $ScamaticMasterKeyConfirmLabel
  ${NSD_CreatePassword} 0 115u 94% 13u "$ScamaticMasterKeyConfirm"
  Pop $ScamaticMasterKeyConfirmInput

  ${NSD_CreateLabel} 0 140u 94% 10u "MongoDB URI utama"
  Pop $ScamaticMongoLabel
  ${NSD_CreateText} 0 152u 94% 13u "$ScamaticMongoUri"
  Pop $ScamaticMongoInput

  ${NSD_CreateLabel} 0 171u 94% 10u "Email administrator"
  Pop $ScamaticEmailLabel
  ${NSD_CreateText} 0 183u 94% 13u "$ScamaticAdminEmail"
  Pop $ScamaticEmailInput

  ${NSD_CreateLabel} 0 202u 94% 10u "Password administrator (minimal 10 karakter)"
  Pop $ScamaticPasswordLabel
  ${NSD_CreatePassword} 0 214u 94% 13u "$ScamaticAdminPassword"
  Pop $ScamaticPasswordInput

  ${NSD_CreateLabel} 0 233u 94% 10u "Konfirmasi password"
  Pop $ScamaticPasswordConfirmLabel
  ${NSD_CreatePassword} 0 245u 94% 13u "$ScamaticAdminPasswordConfirm"
  Pop $ScamaticPasswordConfirmInput

  ${NSD_CreateLabel} 0 270u 94% 12u "ALLOWLIST HOSTNAME (pisahkan beberapa hostname dengan koma)"
  Pop $ScamaticAllowlistLabel

  ${NSD_CreateLabel} 0 289u 94% 10u "ThingsBoard hosts — contoh: demo.thingsboard.io"
  Pop $ScamaticConnectorHostsLabel
  ${NSD_CreateText} 0 301u 94% 13u "$ScamaticConnectorAllowedHosts"
  Pop $ScamaticConnectorHostsInput

  ${NSD_CreateLabel} 0 320u 94% 10u "ThingsBoard private hosts — opsional, kosongkan untuk keamanan"
  Pop $ScamaticConnectorPrivateHostsLabel
  ${NSD_CreateText} 0 332u 94% 13u "$ScamaticConnectorAllowedPrivateHosts"
  Pop $ScamaticConnectorPrivateHostsInput

  ${NSD_CreateLabel} 0 351u 94% 10u "Chart MongoDB hosts — hostname saja, bukan connection URI"
  Pop $ScamaticChartMongoHostsLabel
  ${NSD_CreateText} 0 363u 94% 13u "$ScamaticChartMongoAllowedHosts"
  Pop $ScamaticChartMongoHostsInput

  ${NSD_CreateLabel} 0 382u 94% 10u "Chart MongoDB private hosts — opsional, kosongkan untuk keamanan"
  Pop $ScamaticChartMongoPrivateHostsLabel
  ${NSD_CreateText} 0 394u 94% 13u "$ScamaticChartMongoAllowedPrivateHosts"
  Pop $ScamaticChartMongoPrivateHostsInput

  ${NSD_CreateLabel} 0 417u 94% 24u "Konfigurasi disimpan di ProgramData, dipertahankan saat upgrade, dan hanya dapat dibaca oleh SYSTEM serta Administrator."
  Pop $ScamaticFooterLabel

  Call ScamaticRuntimeSetupModeChanged

  ${NSD_CreateButton} 96% 0 4% 13u "▲"
  Pop $ScamaticScrollUpButton
  ${NSD_OnClick} $ScamaticScrollUpButton ScamaticRuntimeSetupScrollUp

  nsDialogs::CreateControl "${__NSD_VTrackBar_CLASS}" "${__NSD_VTrackBar_STYLE}|${TBS_DOWNISLEFT}|${TBS_NOTICKS}" "${__NSD_VTrackBar_EXSTYLE}" 96% 15u 4% -30u ""
  Pop $ScamaticScrollBar

  ${NSD_CreateButton} 96% -13u 4% 13u "▼"
  Pop $ScamaticScrollDownButton
  ${NSD_OnClick} $ScamaticScrollDownButton ScamaticRuntimeSetupScrollDown

  ${NSD_TrackBar_SetRangeMin} $ScamaticScrollBar 0
  System::Call 'USER32::GetWindowRect(p$ScamaticFooterLabel,@r2)'
  System::Call 'USER32::MapWindowPoints(p0,p$ScamaticRuntimeDialog,pr2,i2)'
  System::Call '*$2(i.r3,i.r4,i.r5,i.r6)'
  System::Call 'USER32::GetClientRect(p$ScamaticRuntimeDialog,@r2)'
  System::Call '*$2(i.r3,i.r4,i.r5,i.r7)'
  IntOp $ScamaticScrollMax $6 - $7
  IntOp $ScamaticScrollMax $ScamaticScrollMax + 8
  ${If} $ScamaticScrollMax < 1
    StrCpy $ScamaticScrollMax 1
  ${EndIf}
  ${NSD_TrackBar_SetRangeMax} $ScamaticScrollBar $ScamaticScrollMax
  ${NSD_TrackBar_SetLineSize} $ScamaticScrollBar 18
  ${NSD_TrackBar_SetPageSize} $ScamaticScrollBar 72
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar 0
  ${NSD_OnChange} $ScamaticScrollBar ScamaticRuntimeSetupScroll
  ${NSD_OnBack} ScamaticRuntimeSetupBack
  ${NSD_CreateTimer} ScamaticRuntimeSetupPollScroll 50

  ${NSD_SetFocus} $ScamaticMongoInput
  nsDialogs::Show
FunctionEnd

Function ScamaticRuntimeSetupPollScroll
  Call ScamaticRuntimeSetupScroll
FunctionEnd

Function ScamaticRuntimeSetupModeChanged
  SendMessage $ScamaticExistingDatabaseRadio ${BM_GETCHECK} 0 0 $R0
  StrCmp $R0 ${BST_CHECKED} scamatic_existing_mode 0
  StrCpy $ScamaticDeploymentMode "new"
  EnableWindow $ScamaticMasterKeyLabel 0
  EnableWindow $ScamaticMasterKeyInput 0
  EnableWindow $ScamaticMasterKeyConfirmLabel 0
  EnableWindow $ScamaticMasterKeyConfirmInput 0
  Return

  scamatic_existing_mode:
  StrCpy $ScamaticDeploymentMode "existing"
  EnableWindow $ScamaticMasterKeyLabel 1
  EnableWindow $ScamaticMasterKeyInput 1
  EnableWindow $ScamaticMasterKeyConfirmLabel 1
  EnableWindow $ScamaticMasterKeyConfirmInput 1
FunctionEnd

Function ScamaticRuntimeSetupBack
  ${NSD_KillTimer} ScamaticRuntimeSetupPollScroll
FunctionEnd

Function ScamaticRuntimeSetupScrollUp
  ${NSD_TrackBar_GetPos} $ScamaticScrollBar $R0
  IntOp $R0 $R0 - 54
  ${If} $R0 < 0
    StrCpy $R0 0
  ${EndIf}
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar $R0
  Call ScamaticRuntimeSetupScroll
FunctionEnd

Function ScamaticRuntimeSetupScrollDown
  ${NSD_TrackBar_GetPos} $ScamaticScrollBar $R0
  IntOp $R0 $R0 + 54
  ${If} $R0 > $ScamaticScrollMax
    StrCpy $R0 $ScamaticScrollMax
  ${EndIf}
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar $R0
  Call ScamaticRuntimeSetupScroll
FunctionEnd

Function ScamaticRuntimeSetupScroll
  ${NSD_TrackBar_GetPos} $ScamaticScrollBar $R0
  IntOp $R1 $ScamaticScrollOffset - $R0
  StrCmp $R1 0 scamatic_scroll_done
  StrCpy $ScamaticScrollOffset $R0
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticIntroLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticNewDeploymentRadio
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticExistingDatabaseRadio
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticMasterKeyLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticMasterKeyInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticMasterKeyConfirmLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticMasterKeyConfirmInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticMongoLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticMongoInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticEmailLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticEmailInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticPasswordLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticPasswordInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticPasswordConfirmLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticPasswordConfirmInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticAllowlistLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticConnectorHostsLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticConnectorHostsInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticConnectorPrivateHostsLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticConnectorPrivateHostsInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticChartMongoHostsLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticChartMongoHostsInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticChartMongoPrivateHostsLabel
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticChartMongoPrivateHostsInput
  !insertmacro SCAMATIC_SCROLL_CONTROL $ScamaticFooterLabel
  scamatic_scroll_done:
FunctionEnd

Function ScamaticValidateHostList
  Exch $R0
  Push $R1
  Push $R2
  StrCpy $R2 1
  StrLen $R1 $R0
  IntCmp $R1 1024 scamatic_host_list_protocol scamatic_host_list_protocol scamatic_host_list_invalid

  scamatic_host_list_protocol:
  ${StrLoc} $R1 $R0 "://" ">"
  StrCmp $R1 "" scamatic_host_list_credentials scamatic_host_list_invalid
  scamatic_host_list_credentials:
  ${StrLoc} $R1 $R0 "@" ">"
  StrCmp $R1 "" scamatic_host_list_path scamatic_host_list_invalid
  scamatic_host_list_path:
  ${StrLoc} $R1 $R0 "/" ">"
  StrCmp $R1 "" scamatic_host_list_query scamatic_host_list_invalid
  scamatic_host_list_query:
  ${StrLoc} $R1 $R0 "?" ">"
  StrCmp $R1 "" scamatic_host_list_fragment scamatic_host_list_invalid
  scamatic_host_list_fragment:
  ${StrLoc} $R1 $R0 "#" ">"
  StrCmp $R1 "" scamatic_host_list_port scamatic_host_list_invalid
  scamatic_host_list_port:
  ${StrLoc} $R1 $R0 ":" ">"
  StrCmp $R1 "" scamatic_host_list_space scamatic_host_list_invalid
  scamatic_host_list_space:
  ${StrLoc} $R1 $R0 " " ">"
  StrCmp $R1 "" scamatic_host_list_done scamatic_host_list_invalid

  scamatic_host_list_invalid:
  StrCpy $R2 0
  scamatic_host_list_done:
  StrCpy $R0 $R2
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

Function ScamaticRuntimeSetupLeave
  Call ScamaticRuntimeSetupModeChanged
  ${NSD_GetText} $ScamaticMasterKeyInput $ScamaticMasterKey
  ${NSD_GetText} $ScamaticMasterKeyConfirmInput $ScamaticMasterKeyConfirm
  ${NSD_GetText} $ScamaticMongoInput $ScamaticMongoUri
  ${NSD_GetText} $ScamaticEmailInput $ScamaticAdminEmail
  ${NSD_GetText} $ScamaticPasswordInput $ScamaticAdminPassword
  ${NSD_GetText} $ScamaticPasswordConfirmInput $ScamaticAdminPasswordConfirm
  ${NSD_GetText} $ScamaticConnectorHostsInput $ScamaticConnectorAllowedHosts
  ${NSD_GetText} $ScamaticConnectorPrivateHostsInput $ScamaticConnectorAllowedPrivateHosts
  ${NSD_GetText} $ScamaticChartMongoHostsInput $ScamaticChartMongoAllowedHosts
  ${NSD_GetText} $ScamaticChartMongoPrivateHostsInput $ScamaticChartMongoAllowedPrivateHosts

  StrCmp $ScamaticDeploymentMode "existing" 0 scamatic_master_key_valid
  StrLen $R0 $ScamaticMasterKey
  IntCmp $R0 1 scamatic_master_key_match 0 scamatic_master_key_match
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar 0
  Call ScamaticRuntimeSetupScroll
  ${NSD_SetFocus} $ScamaticMasterKeyInput
  MessageBox MB_ICONEXCLAMATION|MB_OK "Masukkan master key lama dari deployment yang membuat Data Source/Chart terenkripsi."
  Abort

  scamatic_master_key_match:
  StrCmp $ScamaticMasterKey $ScamaticMasterKeyConfirm scamatic_master_key_valid 0
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar 0
  Call ScamaticRuntimeSetupScroll
  ${NSD_SetFocus} $ScamaticMasterKeyConfirmInput
  MessageBox MB_ICONEXCLAMATION|MB_OK "Konfirmasi master key lama tidak sama."
  Abort

  scamatic_master_key_valid:

  StrCpy $R0 $ScamaticMongoUri 10
  StrCmp $R0 "mongodb://" scamatic_uri_valid 0
  StrCpy $R0 $ScamaticMongoUri 14
  StrCmp $R0 "mongodb+srv://" scamatic_uri_valid 0
  MessageBox MB_ICONEXCLAMATION|MB_OK "MongoDB URI harus dimulai dengan mongodb:// atau mongodb+srv://."
  Abort

  scamatic_uri_valid:
  StrLen $R0 $ScamaticMongoUri
  IntCmp $R0 2048 scamatic_uri_length_valid scamatic_uri_length_valid 0
  MessageBox MB_ICONEXCLAMATION|MB_OK "MongoDB URI terlalu panjang."
  Abort

  scamatic_uri_length_valid:
  StrLen $R0 $ScamaticAdminEmail
  IntCmp $R0 1 scamatic_email_length_valid 0 scamatic_email_length_valid
  MessageBox MB_ICONEXCLAMATION|MB_OK "Masukkan email administrator."
  Abort

  scamatic_email_length_valid:
  IntCmp $R0 120 scamatic_email_format scamatic_email_format 0
  MessageBox MB_ICONEXCLAMATION|MB_OK "Email administrator terlalu panjang."
  Abort

  scamatic_email_format:
  ${StrLoc} $R0 $ScamaticAdminEmail "@" ">"
  StrCmp $R0 "" 0 scamatic_email_has_at
  MessageBox MB_ICONEXCLAMATION|MB_OK "Masukkan email administrator yang valid."
  Abort

  scamatic_email_has_at:
  ${StrLoc} $R0 $ScamaticAdminEmail "." ">"
  StrCmp $R0 "" 0 scamatic_password_length
  MessageBox MB_ICONEXCLAMATION|MB_OK "Masukkan email administrator yang valid."
  Abort

  scamatic_password_length:
  StrLen $R0 $ScamaticAdminPassword
  IntCmp $R0 10 scamatic_password_max 0 scamatic_password_max
  MessageBox MB_ICONEXCLAMATION|MB_OK "Password administrator minimal 10 karakter."
  Abort

  scamatic_password_max:
  IntCmp $R0 256 scamatic_password_match scamatic_password_match 0
  MessageBox MB_ICONEXCLAMATION|MB_OK "Password administrator maksimal 256 karakter."
  Abort

  scamatic_password_match:
  StrCmp $ScamaticAdminPassword $ScamaticAdminPasswordConfirm scamatic_setup_valid 0
  MessageBox MB_ICONEXCLAMATION|MB_OK "Konfirmasi password tidak sama."
  Abort

  scamatic_setup_valid:
  Push $ScamaticConnectorAllowedHosts
  Call ScamaticValidateHostList
  Pop $R0
  StrCmp $R0 1 scamatic_connector_private_hosts_valid 0
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar $ScamaticScrollMax
  Call ScamaticRuntimeSetupScroll
  ${NSD_SetFocus} $ScamaticConnectorHostsInput
  MessageBox MB_ICONEXCLAMATION|MB_OK "ThingsBoard hosts hanya boleh berisi hostname yang dipisahkan koma, tanpa protokol, kredensial, port, path, query, atau spasi."
  Abort

  scamatic_connector_private_hosts_valid:
  Push $ScamaticConnectorAllowedPrivateHosts
  Call ScamaticValidateHostList
  Pop $R0
  StrCmp $R0 1 scamatic_chart_hosts_valid 0
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar $ScamaticScrollMax
  Call ScamaticRuntimeSetupScroll
  ${NSD_SetFocus} $ScamaticConnectorPrivateHostsInput
  MessageBox MB_ICONEXCLAMATION|MB_OK "ThingsBoard private hosts hanya boleh berisi hostname yang dipisahkan koma, tanpa protokol, kredensial, port, path, query, atau spasi."
  Abort

  scamatic_chart_hosts_valid:
  Push $ScamaticChartMongoAllowedHosts
  Call ScamaticValidateHostList
  Pop $R0
  StrCmp $R0 1 scamatic_chart_private_hosts_valid 0
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar $ScamaticScrollMax
  Call ScamaticRuntimeSetupScroll
  ${NSD_SetFocus} $ScamaticChartMongoHostsInput
  MessageBox MB_ICONEXCLAMATION|MB_OK "Chart MongoDB hosts hanya boleh berisi hostname yang dipisahkan koma, tanpa connection URI, kredensial, port, path, query, atau spasi."
  Abort

  scamatic_chart_private_hosts_valid:
  Push $ScamaticChartMongoAllowedPrivateHosts
  Call ScamaticValidateHostList
  Pop $R0
  StrCmp $R0 1 scamatic_setup_complete 0
  ${NSD_TrackBar_SetPos} $ScamaticScrollBar $ScamaticScrollMax
  Call ScamaticRuntimeSetupScroll
  ${NSD_SetFocus} $ScamaticChartMongoPrivateHostsInput
  MessageBox MB_ICONEXCLAMATION|MB_OK "Chart MongoDB private hosts hanya boleh berisi hostname yang dipisahkan koma, tanpa connection URI, kredensial, port, path, query, atau spasi."
  Abort

  scamatic_setup_complete:
  ${NSD_KillTimer} ScamaticRuntimeSetupPollScroll
  StrCpy $ScamaticConfigureRuntime 1
FunctionEnd

Function ScamaticWriteRuntimeConfig
  StrCmp $ScamaticConfigureRuntime 1 0 scamatic_config_done
  IfFileExists "$APPDATA\SCAMATIC\runtime.env" scamatic_config_done 0

  StrCmp $ScamaticDeploymentMode "existing" scamatic_config_write 0
  nsExec::ExecToStack '"$INSTDIR\scamatic-runtime-service.exe" generate-master-key'
  Pop $R0
  Pop $ScamaticMasterKey
  StrCmp $R0 0 0 scamatic_config_key_error
  StrLen $R0 $ScamaticMasterKey
  IntCmp $R0 64 scamatic_config_write scamatic_config_key_error scamatic_config_key_error

  scamatic_config_key_error:
  MessageBox MB_ICONSTOP|MB_OK "Master key tidak dapat dibuat. Instalasi dihentikan agar konfigurasi rahasia tidak tersimpan secara tidak aman."
  Abort

  scamatic_config_write:
  ClearErrors
  FileOpen $R0 "$APPDATA\SCAMATIC\runtime.env.new" w
  IfErrors scamatic_config_file_error 0
  FileWrite $R0 "# Generated by the SCAMATIC first-install setup wizard.$\r$\n"
  FileWrite $R0 "# Keep this file restricted to machine administrators.$\r$\n$\r$\n"
  FileWrite $R0 "MONGO_URI=$\"$ScamaticMongoUri$\"$\r$\n"
  FileWrite $R0 "SCADA_CONNECTOR_MASTER_KEY=$ScamaticMasterKey$\r$\n"
  FileWrite $R0 "SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS=$\r$\n"
  FileWrite $R0 "SCADA_ADMIN_EMAIL=$\"$ScamaticAdminEmail$\"$\r$\n"
  ; dotenv expands \n and \r escapes inside double quotes. Single quotes keep
  ; the password identical to what the operator entered and to Rust validation.
  FileWrite $R0 "SCADA_ADMIN_PASSWORD='$ScamaticAdminPassword'$\r$\n"
  FileWrite $R0 "SCADA_WORKSPACE_ID=local$\r$\n$\r$\n"
  FileWrite $R0 "CONNECTOR_ALLOWED_HOSTS=$ScamaticConnectorAllowedHosts$\r$\n"
  FileWrite $R0 "CONNECTOR_ALLOWED_PRIVATE_HOSTS=$ScamaticConnectorAllowedPrivateHosts$\r$\n"
  FileWrite $R0 "CHART_MONGO_ALLOWED_HOSTS=$ScamaticChartMongoAllowedHosts$\r$\n"
  FileWrite $R0 "CHART_MONGO_ALLOWED_PRIVATE_HOSTS=$ScamaticChartMongoAllowedPrivateHosts$\r$\n"
  FileWrite $R0 "CHART_MONGO_ALLOW_SHARED_CLUSTER=false$\r$\n"
  FileWrite $R0 "SCADA_RUST_SHADOW_ENABLED=true$\r$\n"
  FileWrite $R0 "SCADA_ISAAC_CANARY_ENABLED=false$\r$\n"
  FileClose $R0
  IfErrors scamatic_config_file_error 0

  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$APPDATA\SCAMATIC\runtime.env.new" /inheritance:r /grant:r "*S-1-5-18:(F)" "*S-1-5-32-544:(F)"'
  Pop $R0
  StrCmp $R0 0 0 scamatic_config_file_error
  ClearErrors
  Rename "$APPDATA\SCAMATIC\runtime.env.new" "$APPDATA\SCAMATIC\runtime.env"
  IfErrors scamatic_config_file_error 0

  nsExec::ExecToLog '"$INSTDIR\scamatic-runtime-service.exe" validate --config "$APPDATA\SCAMATIC\runtime.env"'
  Pop $R0
  StrCmp $R0 0 scamatic_config_done 0
  Delete "$APPDATA\SCAMATIC\runtime.env"
  MessageBox MB_ICONSTOP|MB_OK "Master key atau konfigurasi runtime tidak valid. File konfigurasi baru dihapus; periksa format key lalu jalankan installer kembali."
  Abort

  scamatic_config_file_error:
  Delete "$APPDATA\SCAMATIC\runtime.env.new"
  MessageBox MB_ICONSTOP|MB_OK "Konfigurasi runtime tidak dapat disimpan dengan izin file yang aman. Instalasi dihentikan."
  Abort

  scamatic_config_done:
FunctionEnd

Function ScamaticCleanupLegacyBrokenConfig
  IfFileExists "$APPDATA\SCAMATIC\runtime.env" 0 scamatic_legacy_cleanup_done
  Delete "$INSTDIR\$$COMMONAPPDATA\SCAMATIC\runtime.env"
  Delete "$INSTDIR\$$COMMONAPPDATA\SCAMATIC\runtime.env.example"
  RMDir "$INSTDIR\$$COMMONAPPDATA\SCAMATIC\logs"
  RMDir "$INSTDIR\$$COMMONAPPDATA\SCAMATIC"
  RMDir "$INSTDIR\$$COMMONAPPDATA"
  scamatic_legacy_cleanup_done:
FunctionEnd

!macro SCAMATIC_STOP_SERVICE
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop "${SCAMATIC_SERVICE_NAME}"'
  Pop $0
  Sleep 3000
!macroend

!macro NSIS_HOOK_PREINSTALL
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    IfFileExists "$APPDATA\SCAMATIC\runtime.env" scamatic_silent_config_ready 0
    SetErrorLevel 2
    Abort "Fresh silent or passive installation requires a pre-provisioned C:\ProgramData\SCAMATIC\runtime.env. Run the interactive installer once or provision the protected configuration first."
    scamatic_silent_config_ready:
  ${EndIf}
  !insertmacro SCAMATIC_STOP_SERVICE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$APPDATA\SCAMATIC"
  CreateDirectory "$APPDATA\SCAMATIC\logs"
  IfFileExists "$APPDATA\SCAMATIC\runtime.env.example" +2 0
    CopyFiles /SILENT "$INSTDIR\resources\runtime\runtime.env.example" "$APPDATA\SCAMATIC\runtime.env.example"

  Call ScamaticWriteRuntimeConfig
  Call ScamaticCleanupLegacyBrokenConfig

  nsExec::ExecToLog '"$INSTDIR\scamatic-runtime-service.exe" register-service'
  Pop $0
  StrCmp $0 0 0 scamatic_service_config_error

  DetailPrint "Checking SCAMATIC data-plane readiness..."
  nsExec::ExecToLog '"$INSTDIR\scamatic-runtime-service.exe" wait-ready --timeout-seconds 60'
  Pop $0
  StrCmp $0 0 scamatic_service_ready 0
  ${IfNot} ${Silent}
    MessageBox MB_ICONEXCLAMATION|MB_OK "SCAMATIC berhasil dipasang, tetapi data-plane belum ready. Periksa koneksi MongoDB dan log di C:\ProgramData\SCAMATIC\logs\runtime.log. Service akan tetap mencoba berjalan di background."
  ${EndIf}
  Goto scamatic_service_done

  scamatic_service_config_error:
  MessageBox MB_ICONSTOP|MB_OK "Windows Service SCAMATIC tidak dapat dijalankan. Pastikan port 3001 tidak dipakai server Node/manual lain, lalu periksa log installer dan hak administrator."
  Abort

  scamatic_service_ready:
  DetailPrint "SCAMATIC data-plane is ready."
  DetailPrint "Checking encrypted-secret master-key compatibility..."
  nsExec::ExecToLog '"$INSTDIR\scamatic-runtime-service.exe" check-key-compatible'
  Pop $0
  StrCmp $0 0 scamatic_key_compatible 0
  ${IfNot} ${Silent}
    MessageBox MB_ICONEXCLAMATION|MB_OK "Service SCAMATIC sudah berjalan, tetapi master key tidak cocok dengan satu atau lebih Data Source/Chart secret di database. Jangan membuat key baru. Pulihkan master key deployment lama atau lakukan prosedur rotasi key terkontrol sebelum memakai koneksi tersebut."
  ${EndIf}
  Goto scamatic_service_done

  scamatic_key_compatible:
  DetailPrint "Encrypted database records are compatible with the configured master key."

  scamatic_service_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro SCAMATIC_STOP_SERVICE
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete "${SCAMATIC_SERVICE_NAME}"'
  Pop $0
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Machine configuration and logs intentionally remain in ProgramData.
!macroend
