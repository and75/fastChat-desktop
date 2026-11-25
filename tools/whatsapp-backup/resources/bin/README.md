# Binari esterni

Metti qui gli eseguibili che l'app lancia. Non sono inclusi nel repository.

## Windows (resources/bin/win/)
- `adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll` — da Android SDK Platform-Tools: https://developer.android.com/tools/releases/platform-tools
- `idevice_id.exe`, `ideviceinfo.exe`, `idevicebackup2.exe` e le relative DLL — da libimobiledevice per Windows (build di imobiledevice-net / libimobiledevice-win).

Se un binario manca, l'app lo segnala e disabilita la sorgente relativa.

In alternativa, se `adb` / `idevice*` sono già nel PATH di sistema, l'app li usa da lì.
