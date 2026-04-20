# DBD-Blocker WFP direct API manager
# Called from the Electron main process via child_process.spawn.
# Requires Administrator privileges.
#
# Usage:
#   -Action block   -CidrsJson '["1.2.3.0/24","2.3.4.0/16"]'
#   -Action block   -CidrsJson '["1.2.3.0/24"]' -ProcessPath "C:\...\DeadByDaylight-Win64-Shipping.exe"
#   -Action unblock -FilterIdsJson '[69252,69253]'
#   -Action check   -FilterIdsJson '[69252,69253]'
#
# Outputs a single value to stdout:
#   block   -> JSON array of filter IDs: [69252,69253,...]
#   unblock -> "true" or "false"
#   check   -> "true" or "false"

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('block', 'unblock', 'check', 'purge')]
    [string]$Action,
    [string]$CidrsJson     = '[]',
    [string]$CidrsJsonBase64 = '',
    [string]$FilterIdsJson = '[]',
    [string]$FilterIdsJsonBase64 = '',
    [string]$ProcessPath   = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-64BitProcess {
    if (-not [Environment]::Is64BitProcess) {
        throw '64-bit PowerShell is required for the WFP layout used by this script.'
    }
}

function Normalize-StringArrayJson([string]$json, [string]$label) {
    try {
        $parsed = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    } catch {
        throw "Invalid $label JSON. Expected a JSON array."
    }

    if ($parsed -is [string] -or $null -eq $parsed) {
        throw "Invalid $label JSON. Expected an array of strings."
    }

    $arr = @()
    foreach ($item in $parsed) {
        $arr += ,$item
    }

    foreach ($item in $arr) {
        if ($null -eq $item -or -not ($item -is [string])) {
            throw "Invalid $label JSON. Expected an array of strings."
        }
    }

    return ($arr | ConvertTo-Json -Compress)
}

function Normalize-UlongArrayJson([string]$json, [string]$label) {
    try {
        $parsed = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    } catch {
        throw "Invalid $label JSON. Expected a JSON array."
    }

    if ($parsed -is [string] -or $null -eq $parsed) {
        throw "Invalid $label JSON. Expected a JSON array."
    }

    $normalized = New-Object System.Collections.Generic.List[string]
    foreach ($item in $parsed) {
        if ($null -eq $item) {
            throw "Invalid $label JSON. Null values are not allowed."
        }

        $text = [string]$item
        [UInt64]$value = 0
        if (-not [UInt64]::TryParse($text, [ref]$value)) {
            throw "Invalid $label JSON. Expected unsigned integer filter IDs."
        }
        $normalized.Add($value.ToString()) | Out-Null
    }

    return ($normalized | ConvertTo-Json -Compress)
}

function Decode-Base64Json([string]$base64Value, [string]$label) {
    if ([string]::IsNullOrWhiteSpace($base64Value)) {
        return $null
    }

    try {
        $bytes = [Convert]::FromBase64String($base64Value)
        return [System.Text.Encoding]::UTF8.GetString($bytes)
    } catch {
        throw "Invalid $label base64 payload."
    }
}

Assert-64BitProcess

if (-not ([System.Management.Automation.PSTypeName]'WfpMgr').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class WfpMgr {
    const uint RPC_C_AUTHN_DEFAULT = 0xFFFFFFFF;
    const uint FWPM_FILTER_FLAG_PERSISTENT = 0x00000001;
    const uint FWPM_SUBLAYER_FLAG_PERSISTENT = 0x00000001;
    const uint FWP_EMPTY = 0;
    const uint FWP_ACTION_BLOCK = 0x00001001;
    const uint FWP_BYTE_BLOB_TYPE = 12;
    const uint FWP_V4_ADDR_MASK = 0x100;
    const int FWP_MATCH_EQUAL = 0;
    const uint FWP_E_ALREADY_EXISTS = 0x80320009;
    const uint FWP_E_FILTER_NOT_FOUND = 0x80320002;

    static readonly Guid LAYER = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82");
    static readonly Guid SUBLAYER = new Guid("dbd00001-dbd0-dbd0-dbd0-000000000001");
    static readonly Guid FIELD_IP = new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045");
    static readonly Guid FIELD_APP = new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971");

    [StructLayout(LayoutKind.Sequential)]
    struct FWPM_DISPLAY_DATA0 {
        public IntPtr name;
        public IntPtr description;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FWP_BYTE_BLOB {
        public uint size;
        public IntPtr data;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FWP_V4_ADDR_AND_MASK {
        public uint addr;
        public uint mask;
    }

    [StructLayout(LayoutKind.Explicit, Size = 16)]
    struct FWP_VALUE0 {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public ulong uint64;
        [FieldOffset(8)] public IntPtr ptr;
    }

    [StructLayout(LayoutKind.Explicit, Size = 16)]
    struct FWP_CONDITION_VALUE0 {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public ulong uint64;
        [FieldOffset(8)] public IntPtr ptr;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FWPM_FILTER_CONDITION0 {
        public Guid fieldKey;
        public int matchType;
        public FWP_CONDITION_VALUE0 conditionValue;
    }

    [StructLayout(LayoutKind.Explicit, Size = 20)]
    struct FWPM_ACTION0 {
        [FieldOffset(0)] public uint type;
        [FieldOffset(4)] public Guid filterType;
        [FieldOffset(4)] public Guid calloutKey;
    }

    [StructLayout(LayoutKind.Explicit, Size = 16)]
    struct FWPM_CONTEXT0 {
        [FieldOffset(0)] public ulong rawContext;
        [FieldOffset(0)] public Guid providerContextKey;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FWPM_SUBLAYER0 {
        public Guid subLayerKey;
        public FWPM_DISPLAY_DATA0 displayData;
        public uint flags;
        public IntPtr providerKey;
        public FWP_BYTE_BLOB providerData;
        public ushort weight;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FWPM_FILTER0 {
        public Guid filterKey;
        public FWPM_DISPLAY_DATA0 displayData;
        public uint flags;
        public IntPtr providerKey;
        public FWP_BYTE_BLOB providerData;
        public Guid layerKey;
        public Guid subLayerKey;
        public FWP_VALUE0 weight;
        public uint numFilterConditions;
        public IntPtr filterCondition;
        public FWPM_ACTION0 action;
        public FWPM_CONTEXT0 context;
        public IntPtr reserved;
        public ulong filterId;
        public FWP_VALUE0 effectiveWeight;
    }

    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(IntPtr s, uint a, IntPtr i, IntPtr se, out IntPtr h);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr h);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr h, ref FWPM_SUBLAYER0 sl, IntPtr sd);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr h, ref FWPM_FILTER0 f, IntPtr sd, out ulong fid);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteById0(IntPtr h, ulong fid);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterGetById0(IntPtr h, ulong fid, out IntPtr fp);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterCreateEnumHandle0(IntPtr h, IntPtr tmpl, out IntPtr eh);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterEnum0(IntPtr h, IntPtr eh, uint req, out IntPtr entries, out uint ret);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDestroyEnumHandle0(IntPtr h, IntPtr eh);
    [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr p);
    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)] static extern uint FwpmGetAppIdFromFileName0(string fileName, out IntPtr appId);
    [DllImport("kernel32.dll", EntryPoint = "RtlZeroMemory")] static extern void ZeroMemory(IntPtr dest, IntPtr size);

    static WfpMgr() {
        AssertLayouts();
    }

    static int OffsetOf(Type t, string fieldName) {
        return Marshal.OffsetOf(t, fieldName).ToInt32();
    }

    static void AssertLayout(string label, int actual, int expected) {
        if (actual != expected)
            throw new Exception(label + " expected " + expected + " but got " + actual);
    }

    static void AssertLayouts() {
        if (IntPtr.Size != 8)
            throw new Exception("64-bit process required for WFP struct layout.");

        AssertLayout("FWP_VALUE0.size", Marshal.SizeOf(typeof(FWP_VALUE0)), 16);
        AssertLayout("FWP_CONDITION_VALUE0.size", Marshal.SizeOf(typeof(FWP_CONDITION_VALUE0)), 16);
        AssertLayout("FWPM_ACTION0.size", Marshal.SizeOf(typeof(FWPM_ACTION0)), 20);
        AssertLayout("FWPM_SUBLAYER0.size", Marshal.SizeOf(typeof(FWPM_SUBLAYER0)), 72);
        AssertLayout("FWPM_SUBLAYER0.weight", OffsetOf(typeof(FWPM_SUBLAYER0), "weight"), 64);
        AssertLayout("FWPM_FILTER_CONDITION0.size", Marshal.SizeOf(typeof(FWPM_FILTER_CONDITION0)), 40);
        AssertLayout("FWPM_FILTER_CONDITION0.conditionValue", OffsetOf(typeof(FWPM_FILTER_CONDITION0), "conditionValue"), 24);
        AssertLayout("FWPM_FILTER0.size", Marshal.SizeOf(typeof(FWPM_FILTER0)), 200);
        AssertLayout("FWPM_FILTER0.layerKey", OffsetOf(typeof(FWPM_FILTER0), "layerKey"), 64);
        AssertLayout("FWPM_FILTER0.subLayerKey", OffsetOf(typeof(FWPM_FILTER0), "subLayerKey"), 80);
        AssertLayout("FWPM_FILTER0.weight", OffsetOf(typeof(FWPM_FILTER0), "weight"), 96);
        AssertLayout("FWPM_FILTER0.numFilterConditions", OffsetOf(typeof(FWPM_FILTER0), "numFilterConditions"), 112);
        AssertLayout("FWPM_FILTER0.filterCondition", OffsetOf(typeof(FWPM_FILTER0), "filterCondition"), 120);
        AssertLayout("FWPM_FILTER0.action", OffsetOf(typeof(FWPM_FILTER0), "action"), 128);
        AssertLayout("FWPM_FILTER0.reserved", OffsetOf(typeof(FWPM_FILTER0), "reserved"), 168);
        AssertLayout("FWPM_FILTER0.filterId", OffsetOf(typeof(FWPM_FILTER0), "filterId"), 176);
        AssertLayout("FWPM_FILTER0.effectiveWeight", OffsetOf(typeof(FWPM_FILTER0), "effectiveWeight"), 184);
    }

    static uint IpToUint(string ip) {
        var p = ip.Split('.');
        if (p.Length != 4) throw new Exception("Invalid IPv4 address: " + ip);

        byte b0, b1, b2, b3;
        if (!byte.TryParse(p[0], out b0) || !byte.TryParse(p[1], out b1) ||
            !byte.TryParse(p[2], out b2) || !byte.TryParse(p[3], out b3))
            throw new Exception("Invalid IPv4 address: " + ip);

        return (uint)(b0 << 24) | (uint)(b1 << 16) | (uint)(b2 << 8) | b3;
    }

    static uint PrefixToMask(int prefix) {
        if (prefix < 0 || prefix > 32)
            throw new Exception("Invalid CIDR prefix length: " + prefix);
        if (prefix == 0) return 0;
        if (prefix >= 32) return 0xFFFFFFFFu;
        return (uint)(0xFFFFFFFFu << (32 - prefix));
    }

    static string ValidateProcessPath(string processPath) {
        if (string.IsNullOrWhiteSpace(processPath))
            throw new Exception("ProcessPath is required.");
        if (!Path.IsPathRooted(processPath))
            throw new Exception("ProcessPath must be an absolute path.");
        if (!processPath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            throw new Exception("ProcessPath must point to an .exe file.");
        if (!File.Exists(processPath))
            throw new Exception("ProcessPath does not exist: " + processPath);
        return Path.GetFullPath(processPath);
    }

    static IntPtr OpenEngine() {
        IntPtr h;
        uint r = FwpmEngineOpen0(IntPtr.Zero, RPC_C_AUTHN_DEFAULT, IntPtr.Zero, IntPtr.Zero, out h);
        if (r != 0) throw new Exception("FwpmEngineOpen0=0x" + r.ToString("X8"));
        return h;
    }

    static IntPtr GetAppIdForProcess(string processPath) {
        string validatedPath = ValidateProcessPath(processPath);
        IntPtr appId;
        uint r = FwpmGetAppIdFromFileName0(validatedPath, out appId);
        if (r != 0 || appId == IntPtr.Zero)
            throw new Exception("FwpmGetAppIdFromFileName0=0x" + r.ToString("X8"));
        return appId;
    }

    static void EnsureSublayer(IntPtr eng) {
        IntPtr namePtr = Marshal.StringToHGlobalUni("DBD-Blocker");
        try {
            FWPM_SUBLAYER0 subLayer = new FWPM_SUBLAYER0();
            subLayer.subLayerKey = SUBLAYER;
            subLayer.displayData.name = namePtr;
            subLayer.displayData.description = IntPtr.Zero;
            subLayer.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
            subLayer.providerKey = IntPtr.Zero;
            subLayer.providerData = default(FWP_BYTE_BLOB);
            subLayer.weight = 0xFFFF;

            uint r = FwpmSubLayerAdd0(eng, ref subLayer, IntPtr.Zero);
            if (r != 0 && r != FWP_E_ALREADY_EXISTS)
                throw new Exception("FwpmSubLayerAdd0=0x" + r.ToString("X8"));
        } finally {
            Marshal.FreeHGlobal(namePtr);
        }
    }

    static void WriteCondition(IntPtr buffer, int index, FWPM_FILTER_CONDITION0 condition) {
        int size = Marshal.SizeOf(typeof(FWPM_FILTER_CONDITION0));
        IntPtr dest = new IntPtr(buffer.ToInt64() + (index * size));
        Marshal.StructureToPtr(condition, dest, false);
    }

    static ulong AddCidrFilter(IntPtr eng, string cidr, IntPtr appId) {
        var slash = cidr.IndexOf('/');
        string ipStr = slash >= 0 ? cidr.Substring(0, slash) : cidr;
        int prefix = slash >= 0 ? int.Parse(cidr.Substring(slash + 1)) : 32;

        uint addr = IpToUint(ipStr);
        uint mask = PrefixToMask(prefix);
        bool hasApp = appId != IntPtr.Zero;
        int numConds = 1 + (hasApp ? 1 : 0);

        IntPtr ipMaskPtr = IntPtr.Zero;
        IntPtr condsPtr = IntPtr.Zero;
        IntPtr namePtr = IntPtr.Zero;

        try {
            FWP_V4_ADDR_AND_MASK ipMask = new FWP_V4_ADDR_AND_MASK();
            ipMask.addr = addr;
            ipMask.mask = mask;
            ipMaskPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FWP_V4_ADDR_AND_MASK)));
            Marshal.StructureToPtr(ipMask, ipMaskPtr, false);

            int condSize = Marshal.SizeOf(typeof(FWPM_FILTER_CONDITION0));
            condsPtr = Marshal.AllocHGlobal(condSize * numConds);
            ZeroMemory(condsPtr, (IntPtr)(condSize * numConds));

            FWPM_FILTER_CONDITION0 ipCondition = new FWPM_FILTER_CONDITION0();
            ipCondition.fieldKey = FIELD_IP;
            ipCondition.matchType = FWP_MATCH_EQUAL;
            ipCondition.conditionValue.type = FWP_V4_ADDR_MASK;
            ipCondition.conditionValue.ptr = ipMaskPtr;
            WriteCondition(condsPtr, 0, ipCondition);

            if (hasApp) {
                FWPM_FILTER_CONDITION0 appCondition = new FWPM_FILTER_CONDITION0();
                appCondition.fieldKey = FIELD_APP;
                appCondition.matchType = FWP_MATCH_EQUAL;
                appCondition.conditionValue.type = FWP_BYTE_BLOB_TYPE;
                appCondition.conditionValue.ptr = appId;
                WriteCondition(condsPtr, 1, appCondition);
            }

            FWPM_FILTER0 filter = new FWPM_FILTER0();
            filter.filterKey = Guid.NewGuid();
            filter.displayData.name = namePtr = Marshal.StringToHGlobalUni("DBD-Block");
            filter.displayData.description = IntPtr.Zero;
            filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
            filter.providerKey = IntPtr.Zero;
            filter.providerData = default(FWP_BYTE_BLOB);
            filter.layerKey = LAYER;
            filter.subLayerKey = SUBLAYER;
            filter.weight.type = FWP_EMPTY;
            filter.numFilterConditions = (uint)numConds;
            filter.filterCondition = condsPtr;
            filter.action.type = FWP_ACTION_BLOCK;
            filter.context = default(FWPM_CONTEXT0);
            filter.reserved = IntPtr.Zero;
            filter.filterId = 0;
            filter.effectiveWeight = default(FWP_VALUE0);

            ulong fid = 0;
            uint r = FwpmFilterAdd0(eng, ref filter, IntPtr.Zero, out fid);
            if (r != 0)
                throw new Exception("FwpmFilterAdd0(" + cidr + ")=0x" + r.ToString("X8"));
            return fid;
        } finally {
            if (namePtr != IntPtr.Zero) Marshal.FreeHGlobal(namePtr);
            if (condsPtr != IntPtr.Zero) Marshal.FreeHGlobal(condsPtr);
            if (ipMaskPtr != IntPtr.Zero) Marshal.FreeHGlobal(ipMaskPtr);
        }
    }

    public static string Block(string cidrsJson, string processPath) {
        var cidrs = ParseStringArray(cidrsJson);
        if (cidrs.Length == 0) throw new Exception("At least one CIDR is required.");

        IntPtr appId = IntPtr.Zero;
        IntPtr eng = IntPtr.Zero;
        var created = new List<ulong>();
        bool success = false;
        try {
            appId = GetAppIdForProcess(processPath);
            eng = OpenEngine();
            EnsureSublayer(eng);
            foreach (var cidr in cidrs) {
                created.Add(AddCidrFilter(eng, cidr, appId));
            }
            success = true;
            return "[" + string.Join(",", created) + "]";
        } finally {
            if (!success && eng != IntPtr.Zero) {
                foreach (var fid in created)
                    FwpmFilterDeleteById0(eng, fid);
            }
            if (appId != IntPtr.Zero) FwpmFreeMemory0(ref appId);
            if (eng != IntPtr.Zero) FwpmEngineClose0(eng);
        }
    }

    public static int Purge() {
        IntPtr eng = OpenEngine();
        IntPtr eh = IntPtr.Zero;
        var toDelete = new List<ulong>();
        try {
            uint r = FwpmFilterCreateEnumHandle0(eng, IntPtr.Zero, out eh);
            if (r != 0) return -1;

            while (true) {
                IntPtr entries = IntPtr.Zero;
                uint returned = 0;
                r = FwpmFilterEnum0(eng, eh, 200, out entries, out returned);
                if (r != 0 || returned == 0) {
                    if (entries != IntPtr.Zero) FwpmFreeMemory0(ref entries);
                    break;
                }

                for (uint i = 0; i < returned; i++) {
                    IntPtr fp = Marshal.ReadIntPtr(entries, (int)(i * IntPtr.Size));
                    FWPM_FILTER0 filter = (FWPM_FILTER0)Marshal.PtrToStructure(fp, typeof(FWPM_FILTER0));
                    if (filter.subLayerKey == SUBLAYER) {
                        toDelete.Add(filter.filterId);
                    }
                }
                FwpmFreeMemory0(ref entries);
                if (returned < 200) break;
            }

            FwpmFilterDestroyEnumHandle0(eng, eh);
            eh = IntPtr.Zero;

            int deleted = 0;
            foreach (var fid in toDelete) {
                uint dr = FwpmFilterDeleteById0(eng, fid);
                if (dr == 0 || dr == FWP_E_FILTER_NOT_FOUND) deleted++;
            }
            return deleted;
        } finally {
            if (eh != IntPtr.Zero) FwpmFilterDestroyEnumHandle0(eng, eh);
            FwpmEngineClose0(eng);
        }
    }

    public static bool Unblock(string filterIdsJson) {
        var ids = ParseUlongArray(filterIdsJson);
        if (ids.Length == 0) return true;
        IntPtr eng = OpenEngine();
        try {
            bool ok = true;
            foreach (var fid in ids) {
                uint r = FwpmFilterDeleteById0(eng, fid);
                if (r != 0 && r != FWP_E_FILTER_NOT_FOUND) ok = false;
            }
            return ok;
        } finally {
            FwpmEngineClose0(eng);
        }
    }

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
            var s = tok.Trim().Trim('"');
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
            $decodedCidrsJson = Decode-Base64Json $CidrsJsonBase64 'CIDRs JSON'
            if ($null -ne $decodedCidrsJson) {
                $CidrsJson = $decodedCidrsJson
            }
            $CidrsJson = Normalize-StringArrayJson $CidrsJson 'CIDRs'
            Write-Output ([WfpMgr]::Block($CidrsJson, $ProcessPath))
        }
        'unblock' {
            $decodedFilterIdsJson = Decode-Base64Json $FilterIdsJsonBase64 'filter IDs JSON'
            if ($null -ne $decodedFilterIdsJson) {
                $FilterIdsJson = $decodedFilterIdsJson
            }
            $FilterIdsJson = Normalize-UlongArrayJson $FilterIdsJson 'filter IDs'
            $ok = [WfpMgr]::Unblock($FilterIdsJson)
            Write-Output $ok.ToString().ToLowerInvariant()
        }
        'check' {
            $decodedFilterIdsJson = Decode-Base64Json $FilterIdsJsonBase64 'filter IDs JSON'
            if ($null -ne $decodedFilterIdsJson) {
                $FilterIdsJson = $decodedFilterIdsJson
            }
            $FilterIdsJson = Normalize-UlongArrayJson $FilterIdsJson 'filter IDs'
            $ok = [WfpMgr]::CheckExists($FilterIdsJson)
            Write-Output $ok.ToString().ToLowerInvariant()
        }
        'purge' {
            $n = [WfpMgr]::Purge()
            Write-Output $n
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
