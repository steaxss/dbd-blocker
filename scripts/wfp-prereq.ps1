# WFP direct API prerequisite test — logs result to console only
# Outputs: RESULT: PASS or RESULT: FAIL

if (-not ([System.Management.Automation.PSTypeName]'WfpPrereq').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WfpPrereq {
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(IntPtr s, uint a, IntPtr i, IntPtr se, out IntPtr h);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr h);

    public static bool Test() {
        IntPtr h;
        uint r = FwpmEngineOpen0(IntPtr.Zero, 0xFFFFFFFF, IntPtr.Zero, IntPtr.Zero, out h);
        if (r != 0) return false;
        FwpmEngineClose0(h);
        return true;
    }
}
'@
}

try {
    Write-Output "[Health] Testing WFP direct API..."
    if ([WfpPrereq]::Test()) {
        Write-Output "OK  WFP engine accessible"
        Write-Output "RESULT: PASS"
    } else {
        Write-Output "FAIL  WFP engine not accessible (0x{0:X8})" -f 0
        Write-Output "RESULT: FAIL"
    }
} catch {
    Write-Output "FAIL  $_"
    Write-Output "RESULT: FAIL"
}
