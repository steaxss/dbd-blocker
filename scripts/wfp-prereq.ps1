#Requires -Version 5.1
# WFP prerequisite check. Prints "OK ..." / "FAIL ..." lines and a final "RESULT: PASS" or "RESULT: FAIL".

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not [Environment]::Is64BitProcess) {
    Write-Output 'FAIL  64-bit PowerShell is required for WFP'
    Write-Output 'RESULT: FAIL'
    exit 1
}

if (-not ([System.Management.Automation.PSTypeName]'DbdWfpPrereq').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DbdWfpPrereq {
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(IntPtr s, uint a, IntPtr i, IntPtr se, out IntPtr h);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr h);

    // 0 on success, otherwise the WFP / Win32 error code.
    public static uint OpenEngine() {
        IntPtr h;
        uint r = FwpmEngineOpen0(IntPtr.Zero, 0xFFFFFFFF, IntPtr.Zero, IntPtr.Zero, out h);
        if (r == 0) FwpmEngineClose0(h);
        return r;
    }
}
'@
}

try {
    Write-Output '[Health] Checking Windows Filtering Platform...'
    $bfe = Get-Service -Name BFE -ErrorAction SilentlyContinue
    if (-not $bfe -or $bfe.Status -ne 'Running') {
        Write-Output 'FAIL  Base Filtering Engine service (BFE) is not running'
        Write-Output 'RESULT: FAIL'
        exit 1
    }
    Write-Output 'OK  Base Filtering Engine service running'

    $code = [DbdWfpPrereq]::OpenEngine()
    if ($code -eq 0) {
        Write-Output 'OK  WFP engine accessible'
        Write-Output 'RESULT: PASS'
    } else {
        Write-Output ('FAIL  WFP engine not accessible (0x{0:X8}). Run the app as Administrator.' -f $code)
        Write-Output 'RESULT: FAIL'
        exit 1
    }
} catch {
    Write-Output "FAIL  $($_.Exception.Message)"
    Write-Output 'RESULT: FAIL'
    exit 1
}
