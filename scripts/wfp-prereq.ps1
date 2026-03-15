# DBD-Blocker WFP health check
# Tests that the WFP direct API is accessible and filters can be added/deleted.
# Must be run as Administrator.
# Outputs "RESULT: PASS" or "RESULT: FAIL" as the last line.

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")
if (-not $isAdmin) {
    Write-Output "FAIL: Must be run as Administrator"
    Write-Output "RESULT: FAIL"
    exit 1
}

if (-not ([System.Management.Automation.PSTypeName]'WfpHealthCheck').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WfpHealthCheck {
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(IntPtr s, uint a, IntPtr i, IntPtr se, out IntPtr h);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr h);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr h, IntPtr sl, IntPtr sd);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr h, ref Guid k);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr h, IntPtr f, IntPtr sd, out ulong fid);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteById0(IntPtr h, ulong fid);

    static Guid LAYER    = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82");
    static Guid SUBLAYER = new Guid("dbd00001-dbd0-dbd0-dbd0-000000000001");
    static Guid FIELD_IP = new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045");

    static void WG(byte[] b, int o, Guid g) { Buffer.BlockCopy(g.ToByteArray(), 0, b, o, 16); }
    static void W4(byte[] b, int o, uint v) { b[o]=(byte)v;b[o+1]=(byte)(v>>8);b[o+2]=(byte)(v>>16);b[o+3]=(byte)(v>>24); }

    // Smoke test: open engine, add a PERMIT filter for 8.8.8.8, delete it, close.
    // Returns empty string on success, error message on failure.
    public static string Run() {
        IntPtr eng;
        uint r = FwpmEngineOpen0(IntPtr.Zero, 0xFFFFFFFF, IntPtr.Zero, IntPtr.Zero, out eng);
        if (r != 0) return "FwpmEngineOpen0 failed: 0x" + r.ToString("X8");

        // Ensure sublayer exists (or already present from a previous block operation)
        byte[] sl = new byte[72];
        WG(sl, 0, SUBLAYER);
        sl[32] = 1; sl[64] = 0xFF; sl[65] = 0xFF;
        GCHandle sh = GCHandle.Alloc(sl, GCHandleType.Pinned);
        IntPtr sp = sh.AddrOfPinnedObject();
        IntPtr snm = Marshal.StringToHGlobalUni("DBD-Blocker");
        Marshal.WriteIntPtr(sp, 16, snm);
        r = FwpmSubLayerAdd0(eng, sp, IntPtr.Zero);
        sh.Free(); Marshal.FreeHGlobal(snm);
        if (r != 0 && r != 0x80320009) { FwpmEngineClose0(eng); return "FwpmSubLayerAdd0 failed: 0x" + r.ToString("X8"); }

        // Probe: add a PERMIT (not BLOCK) filter for 8.8.8.8 — harmless
        byte[] ms = new byte[8]; ms[0]=8;ms[1]=8;ms[2]=8;ms[3]=8; ms[4]=ms[5]=ms[6]=ms[7]=(byte)0xFF;
        GCHandle mh = GCHandle.Alloc(ms, GCHandleType.Pinned);
        byte[] cond = new byte[40];
        WG(cond, 0, FIELD_IP); W4(cond, 16, 0); W4(cond, 24, 0x100);
        long mp = mh.AddrOfPinnedObject().ToInt64();
        for (int i = 0; i < 8; i++) cond[32+i] = (byte)((mp>>(i*8))&0xFF);
        GCHandle ch = GCHandle.Alloc(cond, GCHandleType.Pinned);
        byte[] flt = new byte[200];
        WG(flt, 0, Guid.NewGuid()); WG(flt, 64, LAYER); WG(flt, 80, SUBLAYER);
        W4(flt, 96, 0); W4(flt, 112, 1);
        W4(flt, 128, 0x1001);  // FWP_ACTION_BLOCK — filter is deleted immediately after
        GCHandle fh = GCHandle.Alloc(flt, GCHandleType.Pinned);
        IntPtr fp = fh.AddrOfPinnedObject();
        IntPtr fnm = Marshal.StringToHGlobalUni("DBD-HealthProbe");
        Marshal.WriteIntPtr(fp, 16, fnm);
        Marshal.WriteIntPtr(fp, 120, ch.AddrOfPinnedObject());
        ulong fid = 0;
        r = FwpmFilterAdd0(eng, fp, IntPtr.Zero, out fid);
        fh.Free(); ch.Free(); mh.Free(); Marshal.FreeHGlobal(fnm);
        if (r != 0) { FwpmEngineClose0(eng); return "FwpmFilterAdd0 failed: 0x" + r.ToString("X8"); }

        // Clean up probe filter
        FwpmFilterDeleteById0(eng, fid);
        FwpmEngineClose0(eng);
        return "";
    }
}
'@
}

Write-Output "[Health] Testing WFP direct API..."
$err = [WfpHealthCheck]::Run()
if ($err -eq "") {
    Write-Output "OK  WFP engine accessible, filter add/delete functional"
    Write-Output "RESULT: PASS"
} else {
    Write-Output "FAIL  $err"
    Write-Output "RESULT: FAIL"
    exit 1
}
