# DBD-Blocker WFP Direct API manager
# Called from the Electron main process via child_process.spawn.
# Requires Administrator privileges.
#
# Usage:
#   -Action block   -CidrsJson '["1.2.3.0/24","2.3.4.0/16"]'
#   -Action unblock -FilterIdsJson '[69252,69253]'
#   -Action check   -FilterIdsJson '[69252,69253]'
#
# Outputs a single value to stdout:
#   block   -> JSON array of filter IDs: [69252,69253,...]
#   unblock -> "true" or "false"
#   check   -> "true" or "false"

param(
    [Parameter(Mandatory=$true)] [string]$Action,
    [string]$CidrsJson     = '[]',
    [string]$FilterIdsJson = '[]'
)

if (-not ([System.Management.Automation.PSTypeName]'WfpMgr').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class WfpMgr {
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(IntPtr s, uint a, IntPtr i, IntPtr se, out IntPtr h);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr h);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr h, IntPtr sl, IntPtr sd);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr h, IntPtr f, IntPtr sd, out ulong fid);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteById0(IntPtr h, ulong fid);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterGetById0(IntPtr h, ulong fid, out IntPtr fp);
    [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr p);

    // FWPM_LAYER_ALE_AUTH_CONNECT_V4
    static Guid LAYER = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82");
    // DBD-Blocker persistent sublayer (fixed deterministic GUID)
    static Guid SUBLAYER = new Guid("dbd00001-dbd0-dbd0-dbd0-000000000001");
    // IP_REMOTE_ADDRESS field key on ALE_AUTH_CONNECT_V4 — binary GUID extracted
    // from WDF filter dump (matches what New-NetFirewallRule writes in WFP memory)
    static Guid FIELD_IP = new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045");

    // FWPM_FILTER_FLAG_PERSISTENT = 1  (survives engine close and reboots)
    const uint FLAG_PERSISTENT = 1;

    // ── Byte helpers ─────────────────────────────────────────────────────────

    static void WG(byte[] b, int o, Guid g) {
        Buffer.BlockCopy(g.ToByteArray(), 0, b, o, 16);
    }
    static void W4(byte[] b, int o, uint v) {
        b[o]=(byte)v; b[o+1]=(byte)(v>>8); b[o+2]=(byte)(v>>16); b[o+3]=(byte)(v>>24);
    }

    static uint IpToUint(string ip) {
        var p = ip.Split('.');
        return (uint.Parse(p[0])<<24)|(uint.Parse(p[1])<<16)|(uint.Parse(p[2])<<8)|uint.Parse(p[3]);
    }
    static uint PrefixToMask(int prefix) {
        if (prefix == 0) return 0;
        if (prefix >= 32) return 0xFFFFFFFFu;
        return (uint)(0xFFFFFFFFu << (32 - prefix));
    }

    // ── WFP engine ───────────────────────────────────────────────────────────

    static IntPtr OpenEngine() {
        IntPtr h;
        uint r = FwpmEngineOpen0(IntPtr.Zero, 0xFFFFFFFF, IntPtr.Zero, IntPtr.Zero, out h);
        if (r != 0) throw new Exception("FwpmEngineOpen0=0x" + r.ToString("X8"));
        return h;
    }

    static void EnsureSublayer(IntPtr eng) {
        // FWPM_SUBLAYER0 (72 bytes):
        //  [0-15]  sublayerKey
        //  [16-23] displayData.name (ptr)
        //  [24-31] displayData.description (ptr, null)
        //  [32-35] flags
        //  [36-39] pad
        //  [40-47] *providerKey (null)
        //  [48-63] providerData (all zero)
        //  [64-65] weight (UINT16)
        //  [66-71] pad
        byte[] sl = new byte[72];
        WG(sl, 0, SUBLAYER);
        sl[32] = 1;             // FWPM_SUBLAYER_FLAG_PERSISTENT
        sl[64] = 0xFF;
        sl[65] = 0xFF;          // weight = 0xFFFF (max priority)
        GCHandle sh = GCHandle.Alloc(sl, GCHandleType.Pinned);
        IntPtr sp = sh.AddrOfPinnedObject();
        IntPtr nm = Marshal.StringToHGlobalUni("DBD-Blocker");
        Marshal.WriteIntPtr(sp, 16, nm);
        uint r = FwpmSubLayerAdd0(eng, sp, IntPtr.Zero);
        sh.Free(); Marshal.FreeHGlobal(nm);
        // 0x80320009 = FWP_E_ALREADY_EXISTS — fine, sublayer is already there
        if (r != 0 && r != 0x80320009)
            throw new Exception("FwpmSubLayerAdd0=0x" + r.ToString("X8"));
    }

    static ulong AddCidrFilter(IntPtr eng, string cidr) {
        var slash = cidr.IndexOf('/');
        string ipStr = slash >= 0 ? cidr.Substring(0, slash) : cidr;
        int prefix   = slash >= 0 ? int.Parse(cidr.Substring(slash + 1)) : 32;

        uint addr = IpToUint(ipStr);
        uint mask = PrefixToMask(prefix);

        // FWP_V4_ADDR_AND_MASK struct: { uint addr; uint mask } = 8 bytes
        byte[] ms = new byte[8];
        W4(ms, 0, addr); W4(ms, 4, mask);
        GCHandle mh = GCHandle.Alloc(ms, GCHandleType.Pinned);

        // FWPM_FILTER_CONDITION0 (40 bytes):
        //  [0-15]  fieldKey
        //  [16-19] matchType = FWP_MATCH_EQUAL (0)
        //  [20-23] pad
        //  [24-27] conditionValue.type = FWP_V4_ADDR_AND_MASK (0x100)
        //  [28-31] pad
        //  [32-39] conditionValue.union = ptr to FWP_V4_ADDR_AND_MASK
        byte[] cond = new byte[40];
        WG(cond, 0, FIELD_IP);
        W4(cond, 16, 0);       // FWP_MATCH_EQUAL
        W4(cond, 24, 0x100);   // FWP_V4_ADDR_AND_MASK
        long mp = mh.AddrOfPinnedObject().ToInt64();
        for (int i = 0; i < 8; i++) cond[32+i] = (byte)((mp >> (i*8)) & 0xFF);
        GCHandle ch = GCHandle.Alloc(cond, GCHandleType.Pinned);

        // FWPM_FILTER0 (200 bytes) — layout from SDK + empirical validation:
        //  [0-15]  filterKey (unique GUID)
        //  [16-23] displayData.name (ptr)
        //  [24-31] displayData.description (ptr, null)
        //  [32-35] flags
        //  [36-39] pad
        //  [40-47] *providerKey (null)
        //  [48-63] providerData (zero)
        //  [64-79] layerKey
        //  [80-95] subLayerKey
        //  [96-99] weight.type = FWP_EMPTY (0)
        //  [100-103] pad
        //  [104-111] weight.value (0)
        //  [112-115] numFilterConditions
        //  [116-119] pad
        //  [120-127] *filterConditions (ptr)
        //  [128-131] action.type = FWP_ACTION_BLOCK (0x1001)
        //  [132-199] rest (zero)
        byte[] flt = new byte[200];
        WG(flt,   0, Guid.NewGuid());
        WG(flt,  64, LAYER);
        WG(flt,  80, SUBLAYER);
        W4(flt,  32, FLAG_PERSISTENT);
        W4(flt,  96, 0);       // weight.type = FWP_EMPTY
        W4(flt, 112, 1);       // numFilterConditions
        W4(flt, 128, 0x1001);  // FWP_ACTION_BLOCK
        GCHandle fh = GCHandle.Alloc(flt, GCHandleType.Pinned);
        IntPtr fp = fh.AddrOfPinnedObject();
        IntPtr nm = Marshal.StringToHGlobalUni("DBD-Block");
        Marshal.WriteIntPtr(fp, 16, nm);
        Marshal.WriteIntPtr(fp, 120, ch.AddrOfPinnedObject());

        ulong fid = 0;
        uint r = FwpmFilterAdd0(eng, fp, IntPtr.Zero, out fid);
        fh.Free(); ch.Free(); mh.Free(); Marshal.FreeHGlobal(nm);

        if (r != 0) throw new Exception("FwpmFilterAdd0(" + cidr + ")=0x" + r.ToString("X8"));
        return fid;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// <summary>Block a list of CIDRs. Returns JSON array of filter IDs.</summary>
    public static string Block(string cidrsJson) {
        var cidrs = ParseStringArray(cidrsJson);
        IntPtr eng = OpenEngine();
        var created = new List<ulong>();
        bool success = false;
        try {
            EnsureSublayer(eng);
            foreach (var cidr in cidrs)
                created.Add(AddCidrFilter(eng, cidr));
            success = true;
            return "[" + string.Join(",", created) + "]";
        } finally {
            if (!success)
                foreach (var fid in created)
                    FwpmFilterDeleteById0(eng, fid);
            FwpmEngineClose0(eng);
        }
    }

    /// <summary>Delete WFP filters by ID. Returns true if all OK (not-found is OK too).</summary>
    public static bool Unblock(string filterIdsJson) {
        var ids = ParseUlongArray(filterIdsJson);
        if (ids.Length == 0) return true;
        IntPtr eng = OpenEngine();
        try {
            bool ok = true;
            foreach (var fid in ids) {
                uint r = FwpmFilterDeleteById0(eng, fid);
                // 0x80320002 = FWP_E_FILTER_NOT_FOUND — already gone, that's fine
                if (r != 0 && r != 0x80320002) ok = false;
            }
            return ok;
        } finally {
            FwpmEngineClose0(eng);
        }
    }

    /// <summary>Returns true if ALL supplied filter IDs still exist in WFP.</summary>
    public static bool CheckExists(string filterIdsJson) {
        var ids = ParseUlongArray(filterIdsJson);
        if (ids.Length == 0) return false;
        IntPtr eng = OpenEngine();
        try {
            foreach (var fid in ids) {
                IntPtr fp = IntPtr.Zero;
                uint r = FwpmFilterGetById0(eng, fid, out fp);
                if (r != 0) return false;
                FwpmFreeMemory0(ref fp);
            }
            return true;
        } finally {
            FwpmEngineClose0(eng);
        }
    }

    // ── JSON parsing ──────────────────────────────────────────────────────────

    static string[] ParseStringArray(string json) {
        json = json.Trim().TrimStart('[').TrimEnd(']');
        if (json.Length == 0) return new string[0];
        var result = new List<string>();
        foreach (var tok in json.Split(',')) {
            var s = tok.Trim().Trim('"');
            if (s.Length > 0) result.Add(s);
        }
        return result.ToArray();
    }

    static ulong[] ParseUlongArray(string json) {
        json = json.Trim().TrimStart('[').TrimEnd(']');
        if (json.Length == 0) return new ulong[0];
        var result = new List<ulong>();
        foreach (var tok in json.Split(',')) {
            var s = tok.Trim();
            ulong v;
            if (s.Length > 0 && ulong.TryParse(s, out v)) result.Add(v);
        }
        return result.ToArray();
    }
}
'@
}

try {
    switch ($Action) {
        'block' {
            Write-Output ([WfpMgr]::Block($CidrsJson))
        }
        'unblock' {
            $ok = [WfpMgr]::Unblock($FilterIdsJson)
            Write-Output $ok.ToString().ToLower()
        }
        'check' {
            $ok = [WfpMgr]::CheckExists($FilterIdsJson)
            Write-Output $ok.ToString().ToLower()
        }
        default {
            Write-Error "Unknown action: $Action"
            exit 1
        }
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
