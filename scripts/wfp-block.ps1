#Requires -Version 5.1
# DBD Server Blocker - Windows Filtering Platform manager.
# Called from the Electron main process. Requires Administrator privileges and 64-bit PowerShell.
#
# Actions:
#   list    -> current filters owned by the app, grouped by region (WFP is the source of truth)
#   apply   -> atomic batch (one WFP transaction) read from STDIN as JSON:
#              { "processPath": "C:\\...\\DeadByDaylight-Win64-Shipping.exe",
#                "set":    [ { "region": "ap-northeast-2", "cidrs": ["3.34.0.0/15", "2406:da12::/36"], "persistent": false } ],
#                "remove": [ "eu-west-2" ] }
#              "set" replaces every filter of that region, "remove" deletes them.
#   drops   -> packets dropped by the app filters in the last -Seconds (Windows WFP net events, read through
#              netsh): proof that blocks are effective. Read-only, no system setting is changed.
#   purge   -> deletes every filter, sublayer and provider created by any version of the app (zero residue),
#              plus the legacy Windows Firewall rules (Block_DBD_*) written by v1.0.
#
# Output: exactly one JSON document on stdout. Errors -> {"ok":false,"error":"..."} and exit code 1.
#
# Model:
#   provider  DBD Server Blocker (persistent)
#   sublayer  DBD Server Blocker (persistent, weight 0xFFFF, owned by the provider)
#   filters   one per CIDR and per ALE layer (connect + recv/accept), scoped to the game executable (ALE_APP_ID),
#             tagged "region=<id>" in their description, FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT so lower sublayers
#             (VPN / booster callouts) cannot override the block.
#             Non-permanent regions use non-persistent filters: they disappear on reboot even if the app crashed.
#   When the last filter is removed, the sublayer and the provider are deleted as well.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('list', 'apply', 'purge', 'drops')]
    [string]$Action,
    [ValidateRange(10, 3600)]
    [int]$Seconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result([hashtable]$obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
}

if (-not [Environment]::Is64BitProcess) {
    Write-Result @{ ok = $false; error = '64-bit PowerShell is required for the WFP structure layout.' }
    exit 1
}

if (-not ([System.Management.Automation.PSTypeName]'DbdWfp.Engine').Type) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace DbdWfp {

public sealed class FilterInfo {
    public ulong Id;
    public string Region;
    public string Cidr;
    public string Layer;
    public bool Persistent;
    public bool Legacy;
}

public sealed class Engine : IDisposable {
    // ---- constants ------------------------------------------------------------------------------
    const uint RPC_C_AUTHN_DEFAULT = 0xFFFFFFFF;
    const uint FWPM_PROVIDER_FLAG_PERSISTENT = 0x1;
    const uint FWPM_SUBLAYER_FLAG_PERSISTENT = 0x1;
    const uint FWPM_FILTER_FLAG_PERSISTENT = 0x1;
    const uint FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT = 0x8;
    const uint FWP_EMPTY = 0;
    const uint FWP_BYTE_BLOB_TYPE = 12;
    const uint FWP_V4_ADDR_MASK = 0x100;
    const uint FWP_V6_ADDR_MASK = 0x101;
    const uint FWP_ACTION_BLOCK = 0x00001001;
    const int FWP_MATCH_EQUAL = 0;

    const uint FWP_E_FILTER_NOT_FOUND = 0x80320003;
    const uint FWP_E_PROVIDER_NOT_FOUND = 0x80320005;
    const uint FWP_E_SUBLAYER_NOT_FOUND = 0x80320007;
    const uint FWP_E_ALREADY_EXISTS = 0x80320009;
    const uint FWP_E_IN_USE = 0x8032000A;

    public const string TagPrefix = "region=";

    public static readonly Guid PROVIDER = new Guid("6a8f3c2e-4d1b-4f7a-9c3e-2b5d8e1f0a01");
    public static readonly Guid SUBLAYER = new Guid("6a8f3c2e-4d1b-4f7a-9c3e-2b5d8e1f0a02");
    // Sublayer used by v1.1 - v1.3 (no provider, filters tracked in wfp-state.json).
    public static readonly Guid LEGACY_SUBLAYER = new Guid("dbd00001-dbd0-dbd0-dbd0-000000000001");

    static readonly Guid LAYER_CONNECT_V4 = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82");
    static readonly Guid LAYER_CONNECT_V6 = new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
    static readonly Guid LAYER_RECV_V4 = new Guid("e1cd9fe7-f4b5-4273-96c0-592e487b8650");
    static readonly Guid LAYER_RECV_V6 = new Guid("a3b42c97-9f04-4672-b87e-cee9c483257f");
    static readonly Guid FIELD_REMOTE_IP = new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045");
    static readonly Guid FIELD_APP_ID = new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971");

    // ---- native structures (x64) ---------------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    struct FWPM_DISPLAY_DATA0 { public IntPtr name; public IntPtr description; }

    [StructLayout(LayoutKind.Sequential)]
    struct FWP_BYTE_BLOB { public uint size; public IntPtr data; }

    [StructLayout(LayoutKind.Explicit, Size = 16)]
    struct FWP_VALUE0 {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public ulong uint64;
        [FieldOffset(8)] public IntPtr ptr;
    }

    [StructLayout(LayoutKind.Explicit, Size = 16)]
    struct FWP_CONDITION_VALUE0 {
        [FieldOffset(0)] public uint type;
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
    }

    [StructLayout(LayoutKind.Explicit, Size = 16)]
    struct FWPM_CONTEXT0 {
        [FieldOffset(0)] public ulong rawContext;
        [FieldOffset(0)] public Guid providerContextKey;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FWPM_PROVIDER0 {
        public Guid providerKey;
        public FWPM_DISPLAY_DATA0 displayData;
        public uint flags;
        public FWP_BYTE_BLOB providerData;
        public IntPtr serviceName;
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

    // ---- P/Invoke ------------------------------------------------------------------------------
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(IntPtr serverName, uint authnService, IntPtr authIdentity, IntPtr session, out IntPtr engineHandle);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engineHandle);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engineHandle, uint flags);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engineHandle);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engineHandle);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderAdd0(IntPtr engineHandle, ref FWPM_PROVIDER0 provider, IntPtr sd);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderDeleteByKey0(IntPtr engineHandle, ref Guid key);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderGetByKey0(IntPtr engineHandle, ref Guid key, out IntPtr provider);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engineHandle, ref FWPM_SUBLAYER0 subLayer, IntPtr sd);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr engineHandle, ref Guid key);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerGetByKey0(IntPtr engineHandle, ref Guid key, out IntPtr subLayer);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engineHandle, ref FWPM_FILTER0 filter, IntPtr sd, out ulong id);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteById0(IntPtr engineHandle, ulong id);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterCreateEnumHandle0(IntPtr engineHandle, IntPtr template, out IntPtr enumHandle);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterEnum0(IntPtr engineHandle, IntPtr enumHandle, uint numEntriesRequested, out IntPtr entries, out uint numEntriesReturned);
    [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDestroyEnumHandle0(IntPtr engineHandle, IntPtr enumHandle);
    [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr p);
    [DllImport("fwpuclnt.dll", CharSet = CharSet.Unicode)] static extern uint FwpmGetAppIdFromFileName0(string fileName, out IntPtr appId);

    // ---- layout self-check ---------------------------------------------------------------------
    static Engine() {
        if (IntPtr.Size != 8) throw new InvalidOperationException("64-bit process required.");
        Check("FWP_VALUE0", Marshal.SizeOf(typeof(FWP_VALUE0)), 16);
        Check("FWP_CONDITION_VALUE0", Marshal.SizeOf(typeof(FWP_CONDITION_VALUE0)), 16);
        Check("FWPM_FILTER_CONDITION0", Marshal.SizeOf(typeof(FWPM_FILTER_CONDITION0)), 40);
        Check("FWPM_FILTER_CONDITION0.conditionValue", Off(typeof(FWPM_FILTER_CONDITION0), "conditionValue"), 24);
        Check("FWPM_ACTION0", Marshal.SizeOf(typeof(FWPM_ACTION0)), 20);
        Check("FWPM_PROVIDER0", Marshal.SizeOf(typeof(FWPM_PROVIDER0)), 64);
        Check("FWPM_PROVIDER0.serviceName", Off(typeof(FWPM_PROVIDER0), "serviceName"), 56);
        Check("FWPM_SUBLAYER0", Marshal.SizeOf(typeof(FWPM_SUBLAYER0)), 72);
        Check("FWPM_SUBLAYER0.weight", Off(typeof(FWPM_SUBLAYER0), "weight"), 64);
        Check("FWPM_FILTER0", Marshal.SizeOf(typeof(FWPM_FILTER0)), 200);
        Check("FWPM_FILTER0.layerKey", Off(typeof(FWPM_FILTER0), "layerKey"), 64);
        Check("FWPM_FILTER0.subLayerKey", Off(typeof(FWPM_FILTER0), "subLayerKey"), 80);
        Check("FWPM_FILTER0.numFilterConditions", Off(typeof(FWPM_FILTER0), "numFilterConditions"), 112);
        Check("FWPM_FILTER0.filterCondition", Off(typeof(FWPM_FILTER0), "filterCondition"), 120);
        Check("FWPM_FILTER0.action", Off(typeof(FWPM_FILTER0), "action"), 128);
        Check("FWPM_FILTER0.filterId", Off(typeof(FWPM_FILTER0), "filterId"), 176);
    }

    static int Off(Type t, string f) { return Marshal.OffsetOf(t, f).ToInt32(); }
    static void Check(string label, int actual, int expected) {
        if (actual != expected) throw new InvalidOperationException(label + ": expected " + expected + ", got " + actual);
    }

    static Exception Fail(string api, uint code) {
        return new InvalidOperationException(api + " failed (0x" + code.ToString("X8") + ")");
    }

    // ---- lifetime ------------------------------------------------------------------------------
    IntPtr _engine;
    bool _inTransaction;

    public Engine() {
        uint r = FwpmEngineOpen0(IntPtr.Zero, RPC_C_AUTHN_DEFAULT, IntPtr.Zero, IntPtr.Zero, out _engine);
        if (r != 0) throw Fail("FwpmEngineOpen0", r);
    }

    public void Dispose() {
        if (_engine == IntPtr.Zero) return;
        if (_inTransaction) { FwpmTransactionAbort0(_engine); _inTransaction = false; }
        FwpmEngineClose0(_engine);
        _engine = IntPtr.Zero;
    }

    public void Begin() {
        uint r = FwpmTransactionBegin0(_engine, 0);
        if (r != 0) throw Fail("FwpmTransactionBegin0", r);
        _inTransaction = true;
    }

    public void Commit() {
        uint r = FwpmTransactionCommit0(_engine);
        _inTransaction = false;
        if (r != 0) throw Fail("FwpmTransactionCommit0", r);
    }

    public void Abort() {
        if (!_inTransaction) return;
        FwpmTransactionAbort0(_engine);
        _inTransaction = false;
    }

    // ---- enumeration ---------------------------------------------------------------------------
    public List<FilterInfo> ListFilters() {
        var result = new List<FilterInfo>();
        IntPtr enumHandle;
        uint r = FwpmFilterCreateEnumHandle0(_engine, IntPtr.Zero, out enumHandle);
        if (r != 0) throw Fail("FwpmFilterCreateEnumHandle0", r);
        try {
            const uint batch = 256;
            while (true) {
                IntPtr entries; uint returned;
                r = FwpmFilterEnum0(_engine, enumHandle, batch, out entries, out returned);
                if (r != 0) throw Fail("FwpmFilterEnum0", r);
                try {
                    for (int i = 0; i < returned; i++) {
                        IntPtr fp = Marshal.ReadIntPtr(entries, i * IntPtr.Size);
                        var f = (FWPM_FILTER0)Marshal.PtrToStructure(fp, typeof(FWPM_FILTER0));
                        bool ours = f.subLayerKey == SUBLAYER;
                        bool legacy = f.subLayerKey == LEGACY_SUBLAYER;
                        if (!ours && !legacy) continue;
                        result.Add(Describe(f, legacy));
                    }
                } finally {
                    if (entries != IntPtr.Zero) FwpmFreeMemory0(ref entries);
                }
                if (returned < batch) break;
            }
        } finally {
            FwpmFilterDestroyEnumHandle0(_engine, enumHandle);
        }
        return result;
    }

    static FilterInfo Describe(FWPM_FILTER0 f, bool legacy) {
        var info = new FilterInfo();
        info.Id = f.filterId;
        info.Legacy = legacy;
        info.Persistent = (f.flags & FWPM_FILTER_FLAG_PERSISTENT) != 0;
        info.Layer = f.layerKey == LAYER_CONNECT_V4 ? "connect-v4"
                   : f.layerKey == LAYER_CONNECT_V6 ? "connect-v6"
                   : f.layerKey == LAYER_RECV_V4 ? "recv-v4"
                   : f.layerKey == LAYER_RECV_V6 ? "recv-v6"
                   : f.layerKey.ToString();
        string desc = f.displayData.description == IntPtr.Zero ? null : Marshal.PtrToStringUni(f.displayData.description);
        if (desc != null && desc.StartsWith(TagPrefix, StringComparison.Ordinal)) info.Region = desc.Substring(TagPrefix.Length);

        int condSize = Marshal.SizeOf(typeof(FWPM_FILTER_CONDITION0));
        for (int c = 0; c < f.numFilterConditions && f.filterCondition != IntPtr.Zero; c++) {
            var cond = (FWPM_FILTER_CONDITION0)Marshal.PtrToStructure(IntPtr.Add(f.filterCondition, c * condSize), typeof(FWPM_FILTER_CONDITION0));
            if (cond.fieldKey != FIELD_REMOTE_IP || cond.conditionValue.ptr == IntPtr.Zero) continue;
            if (cond.conditionValue.type == FWP_V4_ADDR_MASK) {
                uint addr = (uint)Marshal.ReadInt32(cond.conditionValue.ptr, 0);
                uint mask = (uint)Marshal.ReadInt32(cond.conditionValue.ptr, 4);
                int prefix = 0; for (uint m = mask; (m & 0x80000000u) != 0; m <<= 1) prefix++;
                info.Cidr = ((addr >> 24) & 0xFF) + "." + ((addr >> 16) & 0xFF) + "." + ((addr >> 8) & 0xFF) + "." + (addr & 0xFF) + "/" + prefix;
            } else if (cond.conditionValue.type == FWP_V6_ADDR_MASK) {
                byte[] bytes = new byte[16];
                Marshal.Copy(cond.conditionValue.ptr, bytes, 0, 16);
                byte prefix = Marshal.ReadByte(cond.conditionValue.ptr, 16);
                info.Cidr = new IPAddress(bytes).ToString() + "/" + prefix;
            }
        }
        return info;
    }

    // ---- provider / sublayer -------------------------------------------------------------------
    public void EnsureProviderAndSublayer() {
        IntPtr name = Marshal.StringToHGlobalUni("DBD Server Blocker");
        IntPtr desc = Marshal.StringToHGlobalUni("Blocks Dead by Daylight from selected AWS regions");
        IntPtr providerKeyPtr = Marshal.AllocHGlobal(16);
        try {
            var provider = new FWPM_PROVIDER0();
            provider.providerKey = PROVIDER;
            provider.displayData.name = name;
            provider.displayData.description = desc;
            provider.flags = FWPM_PROVIDER_FLAG_PERSISTENT;
            uint r = FwpmProviderAdd0(_engine, ref provider, IntPtr.Zero);
            if (r != 0 && r != FWP_E_ALREADY_EXISTS) throw Fail("FwpmProviderAdd0", r);

            Marshal.StructureToPtr(PROVIDER, providerKeyPtr, false);
            var sub = new FWPM_SUBLAYER0();
            sub.subLayerKey = SUBLAYER;
            sub.displayData.name = name;
            sub.displayData.description = desc;
            sub.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
            sub.providerKey = providerKeyPtr;
            sub.weight = 0xFFFF;
            r = FwpmSubLayerAdd0(_engine, ref sub, IntPtr.Zero);
            if (r != 0 && r != FWP_E_ALREADY_EXISTS) throw Fail("FwpmSubLayerAdd0", r);
        } finally {
            Marshal.FreeHGlobal(name);
            Marshal.FreeHGlobal(desc);
            Marshal.FreeHGlobal(providerKeyPtr);
        }
    }

    // Deletes the sublayer(s) and the provider. Must only be called when they hold no filter.
    public void DeleteContainers() {
        Guid k = SUBLAYER;
        uint r = FwpmSubLayerDeleteByKey0(_engine, ref k);
        if (r != 0 && r != FWP_E_SUBLAYER_NOT_FOUND) throw Fail("FwpmSubLayerDeleteByKey0", r);
        k = LEGACY_SUBLAYER;
        r = FwpmSubLayerDeleteByKey0(_engine, ref k);
        if (r != 0 && r != FWP_E_SUBLAYER_NOT_FOUND) throw Fail("FwpmSubLayerDeleteByKey0(legacy)", r);
        k = PROVIDER;
        r = FwpmProviderDeleteByKey0(_engine, ref k);
        if (r != 0 && r != FWP_E_PROVIDER_NOT_FOUND && r != FWP_E_IN_USE) throw Fail("FwpmProviderDeleteByKey0", r);
    }

    public bool ProviderExists() {
        Guid k = PROVIDER; IntPtr p;
        uint r = FwpmProviderGetByKey0(_engine, ref k, out p);
        if (r == 0) { FwpmFreeMemory0(ref p); return true; }
        return false;
    }

    public bool SublayerExists(bool legacy) {
        Guid k = legacy ? LEGACY_SUBLAYER : SUBLAYER; IntPtr p;
        uint r = FwpmSubLayerGetByKey0(_engine, ref k, out p);
        if (r == 0) { FwpmFreeMemory0(ref p); return true; }
        return false;
    }

    // ---- filters -------------------------------------------------------------------------------
    public void DeleteFilter(ulong id) {
        uint r = FwpmFilterDeleteById0(_engine, id);
        if (r != 0 && r != FWP_E_FILTER_NOT_FOUND) throw Fail("FwpmFilterDeleteById0(" + id + ")", r);
    }

    public static string ValidateProcessPath(string processPath) {
        if (string.IsNullOrWhiteSpace(processPath)) throw new ArgumentException("processPath is required.");
        if (!Path.IsPathRooted(processPath)) throw new ArgumentException("processPath must be absolute.");
        if (!processPath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("processPath must point to an .exe file.");
        string full = Path.GetFullPath(processPath);
        if (!File.Exists(full)) throw new ArgumentException("processPath does not exist: " + full);
        return full;
    }

    // Returns the number of filters created. Must be called inside a transaction.
    public int AddRegion(string region, string[] cidrs, string processPath, bool persistent) {
        if (string.IsNullOrEmpty(region)) throw new ArgumentException("region is required.");
        if (cidrs == null || cidrs.Length == 0) throw new ArgumentException("At least one CIDR is required for " + region + ".");

        IntPtr appId;
        uint r = FwpmGetAppIdFromFileName0(ValidateProcessPath(processPath), out appId);
        if (r != 0 || appId == IntPtr.Zero) throw Fail("FwpmGetAppIdFromFileName0", r);

        IntPtr name = Marshal.StringToHGlobalUni("DBD Server Blocker");
        IntPtr tag = Marshal.StringToHGlobalUni(TagPrefix + region);
        IntPtr providerKeyPtr = Marshal.AllocHGlobal(16);
        int created = 0;
        try {
            Marshal.StructureToPtr(PROVIDER, providerKeyPtr, false);
            foreach (string cidr in cidrs) {
                Cidr parsed = Cidr.Parse(cidr);
                Guid[] layers = parsed.IsV6
                    ? new Guid[] { LAYER_CONNECT_V6, LAYER_RECV_V6 }
                    : new Guid[] { LAYER_CONNECT_V4, LAYER_RECV_V4 };
                foreach (Guid layer in layers) {
                    AddFilter(layer, parsed, appId, name, tag, providerKeyPtr, persistent);
                    created++;
                }
            }
        } finally {
            Marshal.FreeHGlobal(name);
            Marshal.FreeHGlobal(tag);
            Marshal.FreeHGlobal(providerKeyPtr);
            FwpmFreeMemory0(ref appId);
        }
        return created;
    }

    void AddFilter(Guid layer, Cidr cidr, IntPtr appId, IntPtr name, IntPtr tag, IntPtr providerKeyPtr, bool persistent) {
        int condSize = Marshal.SizeOf(typeof(FWPM_FILTER_CONDITION0));
        IntPtr addrPtr = Marshal.AllocHGlobal(24);
        IntPtr conds = Marshal.AllocHGlobal(condSize * 2);
        try {
            for (int i = 0; i < 24; i++) Marshal.WriteByte(addrPtr, i, 0);
            var ipCond = new FWPM_FILTER_CONDITION0();
            ipCond.fieldKey = FIELD_REMOTE_IP;
            ipCond.matchType = FWP_MATCH_EQUAL;
            if (cidr.IsV6) {
                Marshal.Copy(cidr.Bytes, 0, addrPtr, 16);          // network byte order
                Marshal.WriteByte(addrPtr, 16, (byte)cidr.Prefix);
                ipCond.conditionValue.type = FWP_V6_ADDR_MASK;
            } else {
                uint addr = ((uint)cidr.Bytes[0] << 24) | ((uint)cidr.Bytes[1] << 16) | ((uint)cidr.Bytes[2] << 8) | cidr.Bytes[3];
                uint mask = cidr.Prefix == 0 ? 0u : 0xFFFFFFFFu << (32 - cidr.Prefix);
                Marshal.WriteInt32(addrPtr, 0, unchecked((int)addr));   // host byte order
                Marshal.WriteInt32(addrPtr, 4, unchecked((int)mask));
                ipCond.conditionValue.type = FWP_V4_ADDR_MASK;
            }
            ipCond.conditionValue.ptr = addrPtr;
            Marshal.StructureToPtr(ipCond, conds, false);

            var appCond = new FWPM_FILTER_CONDITION0();
            appCond.fieldKey = FIELD_APP_ID;
            appCond.matchType = FWP_MATCH_EQUAL;
            appCond.conditionValue.type = FWP_BYTE_BLOB_TYPE;
            appCond.conditionValue.ptr = appId;
            Marshal.StructureToPtr(appCond, IntPtr.Add(conds, condSize), false);

            var filter = new FWPM_FILTER0();
            filter.filterKey = Guid.NewGuid();
            filter.displayData.name = name;
            filter.displayData.description = tag;
            filter.flags = FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT | (persistent ? FWPM_FILTER_FLAG_PERSISTENT : 0u);
            filter.providerKey = providerKeyPtr;
            filter.layerKey = layer;
            filter.subLayerKey = SUBLAYER;
            filter.weight.type = FWP_EMPTY;
            filter.numFilterConditions = 2;
            filter.filterCondition = conds;
            filter.action.type = FWP_ACTION_BLOCK;

            ulong id;
            uint r = FwpmFilterAdd0(_engine, ref filter, IntPtr.Zero, out id);
            if (r != 0) throw Fail("FwpmFilterAdd0(" + cidr.Text + ")", r);
        } finally {
            Marshal.FreeHGlobal(conds);
            Marshal.FreeHGlobal(addrPtr);
        }
    }
}

public sealed class Cidr {
    public byte[] Bytes;
    public int Prefix;
    public bool IsV6;
    public string Text;

    public static Cidr Parse(string text) {
        if (string.IsNullOrWhiteSpace(text)) throw new ArgumentException("Empty CIDR.");
        string s = text.Trim();
        int slash = s.IndexOf('/');
        string ipPart = slash >= 0 ? s.Substring(0, slash) : s;
        IPAddress ip;
        if (!IPAddress.TryParse(ipPart, out ip)) throw new ArgumentException("Invalid CIDR: " + text);
        bool v6 = ip.AddressFamily == AddressFamily.InterNetworkV6;
        if (!v6 && ipPart.Split('.').Length != 4) throw new ArgumentException("Invalid IPv4 CIDR: " + text);
        int max = v6 ? 128 : 32;
        int prefix = max;
        if (slash >= 0 && (!int.TryParse(s.Substring(slash + 1), out prefix) || prefix < 0 || prefix > max))
            throw new ArgumentException("Invalid prefix length: " + text);
        if (!v6 && prefix < 8) throw new ArgumentException("Refusing overly broad IPv4 range: " + text);
        if (v6 && prefix < 16) throw new ArgumentException("Refusing overly broad IPv6 range: " + text);

        byte[] bytes = ip.GetAddressBytes();
        for (int bit = prefix; bit < max; bit++) bytes[bit / 8] &= (byte)~(0x80 >> (bit % 8));   // clear host bits
        var c = new Cidr();
        c.Bytes = bytes; c.Prefix = prefix; c.IsV6 = v6;
        c.Text = new IPAddress(bytes).ToString() + "/" + prefix;
        return c;
    }
}

}
'@
}

function Get-OwnedState([DbdWfp.Engine]$engine) {
    $filters = $engine.ListFilters()
    $regions = @{}
    $legacy = 0
    $untagged = 0
    foreach ($f in $filters) {
        if ($f.Legacy) { $legacy++; continue }
        if (-not $f.Region) { $untagged++; continue }
        if (-not $regions.ContainsKey($f.Region)) {
            $regions[$f.Region] = @{ filters = 0; persistent = $true; cidrs = New-Object System.Collections.Generic.SortedSet[string] }
        }
        $entry = $regions[$f.Region]
        $entry.filters++
        if (-not $f.Persistent) { $entry.persistent = $false }
        if ($f.Cidr) { [void]$entry.cidrs.Add($f.Cidr) }
    }
    $out = @{}
    foreach ($k in $regions.Keys) {
        $e = $regions[$k]
        $out[$k] = @{ filters = $e.filters; persistent = $e.persistent; cidrs = @($e.cidrs) }
    }
    return @{
        filters  = $filters
        regions  = $out
        legacy   = $legacy
        untagged = $untagged
    }
}

function Remove-LegacyFirewallRules {
    # v1.0 wrote Windows Firewall rules named Block_DBD_<region>[_<city>] straight into the registry.
    $removed = 0
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules'
    try {
        $props = Get-ItemProperty -Path $key -ErrorAction Stop
        $names = @($props.PSObject.Properties | Where-Object { $_.Name -like 'Block_DBD_*' } | ForEach-Object { $_.Name })
        foreach ($n in $names) {
            try {
                Remove-NetFirewallRule -Name $n -ErrorAction Stop
            } catch {
                Remove-ItemProperty -Path $key -Name $n -ErrorAction SilentlyContinue
            }
            $removed++
        }
    } catch { }
    return $removed
}

function Read-StdinJson {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'Expected a JSON payload on stdin.' }
    return ConvertFrom-Json -InputObject $raw
}

$engine = $null
try {
    $engine = New-Object DbdWfp.Engine

    switch ($Action) {
        'list' {
            $state = Get-OwnedState $engine
            Write-Result @{
                ok              = $true
                regions         = $state.regions
                legacyFilters   = $state.legacy
                untaggedFilters = $state.untagged
                provider        = $engine.ProviderExists()
                sublayer        = $engine.SublayerExists($false)
                legacySublayer  = $engine.SublayerExists($true)
            }
        }

        'apply' {
            $payload = Read-StdinJson
            $processPath = ''
            if ($payload.PSObject.Properties['processPath']) { $processPath = [string]$payload.processPath }
            $sets = @()
            if ($payload.PSObject.Properties['set'] -and $payload.set) { $sets = @($payload.set) }
            $removes = @()
            if ($payload.PSObject.Properties['remove'] -and $payload.remove) { $removes = @($payload.remove | ForEach-Object { [string]$_ }) }

            # Validate everything before touching WFP.
            if ($sets.Count -gt 0) { [void][DbdWfp.Engine]::ValidateProcessPath($processPath) }
            foreach ($s in $sets) {
                foreach ($prop in 'region', 'cidrs') {
                    if (-not $s.PSObject.Properties[$prop]) { throw "Each 'set' entry needs a '$prop' property." }
                }
                if (-not $s.PSObject.Properties['persistent']) { $s | Add-Member -NotePropertyName persistent -NotePropertyValue $false }
                if (-not ($s.region -is [string]) -or $s.region -notmatch '^[a-z]{2}(-[a-z]+)+-\d$') { throw "Invalid region id: $($s.region)" }
                if (@($s.cidrs).Count -eq 0) { throw "No CIDR given for $($s.region)." }
                foreach ($c in @($s.cidrs)) { [void][DbdWfp.Cidr]::Parse([string]$c) }
            }
            foreach ($r in $removes) {
                if ($r -notmatch '^[a-z]{2}(-[a-z]+)+-\d$') { throw "Invalid region id: $r" }
            }

            $touched = @{}
            foreach ($s in $sets) { $touched[[string]$s.region] = $true }
            foreach ($r in $removes) { $touched[$r] = $true }

            $before = Get-OwnedState $engine
            $created = 0
            $deleted = 0

            $engine.Begin()
            try {
                if ($sets.Count -gt 0) { $engine.EnsureProviderAndSublayer() }
                foreach ($f in $before.filters) {
                    if (-not $f.Legacy -and $f.Region -and $touched.ContainsKey($f.Region)) {
                        $engine.DeleteFilter($f.Id)
                        $deleted++
                    }
                }
                foreach ($s in $sets) {
                    $cidrs = [string[]]@($s.cidrs | ForEach-Object { [string]$_ })
                    $created += $engine.AddRegion([string]$s.region, $cidrs, $processPath, [bool]$s.persistent)
                }
                $engine.Commit()
            } catch {
                $engine.Abort()
                throw
            }

            $after = Get-OwnedState $engine
            if ($after.filters.Count -eq 0) {
                $engine.Begin()
                try { $engine.DeleteContainers(); $engine.Commit() } catch { $engine.Abort() }
            }

            # Verify: every requested region exists with the expected filter count, every removed region is gone.
            $problems = @()
            foreach ($s in $sets) {
                $expected = 2 * @($s.cidrs).Count
                $actual = if ($after.regions.ContainsKey([string]$s.region)) { $after.regions[[string]$s.region].filters } else { 0 }
                if ($actual -ne $expected) { $problems += "$($s.region): expected $expected filters, found $actual" }
            }
            foreach ($r in $removes) {
                if ($after.regions.ContainsKey($r)) { $problems += "${r}: $($after.regions[$r].filters) filters still present" }
            }
            if ($problems.Count -gt 0) { throw ('Verification failed: ' + ($problems -join '; ')) }

            Write-Result @{
                ok      = $true
                created = $created
                deleted = $deleted
                regions = $after.regions
            }
        }

        'drops' {
            $state = Get-OwnedState $engine
            $regionByFilter = @{}
            foreach ($f in $state.filters) {
                if (-not $f.Legacy -and $f.Region) { $regionByFilter[[string]$f.Id] = $f.Region }
            }
            if ($regionByFilter.Count -eq 0) {
                Write-Result @{ ok = $true; available = $true; events = @() }
                break
            }

            $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('dbd-blocker-netevents-' + [guid]::NewGuid().ToString('N') + '.xml')
            try {
                $netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
                & $netsh wfp show netevents "file=$tmp" "timewindow=$Seconds" | Out-Null
                if (-not (Test-Path -LiteralPath $tmp)) {
                    Write-Result @{ ok = $true; available = $false; events = @() }
                    break
                }
                $doc = New-Object System.Xml.XmlDocument
                $doc.Load($tmp)
                $events = New-Object System.Collections.Generic.List[object]
                foreach ($item in $doc.SelectNodes('/netEvents/item')) {
                    $type = $item.SelectSingleNode('type')
                    if (-not $type -or $type.InnerText -notlike '*CLASSIFY_DROP*') { continue }
                    $fid = $item.SelectSingleNode('classifyDrop/filterId')
                    if (-not $fid -or -not $regionByFilter.ContainsKey($fid.InnerText)) { continue }
                    $h = $item.SelectSingleNode('header')
                    $remote = $h.SelectSingleNode('remoteAddrV4')
                    if (-not $remote) { $remote = $h.SelectSingleNode('remoteAddrV6') }
                    $remoteText = ''
                    if ($remote) { $remoteText = $remote.InnerText }
                    $events.Add(@{
                        time      = $h.SelectSingleNode('timeStamp').InnerText
                        region    = $regionByFilter[$fid.InnerText]
                        filterId  = $fid.InnerText
                        remote    = $remoteText
                        port      = [int]$h.SelectSingleNode('remotePort').InnerText
                        localPort = [int]$h.SelectSingleNode('localPort').InnerText
                    })
                }
                Write-Result @{ ok = $true; available = $true; events = $events.ToArray() }
            } finally {
                Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            }
        }

        'purge' {
            $before = Get-OwnedState $engine
            $engine.Begin()
            try {
                foreach ($f in $before.filters) { $engine.DeleteFilter($f.Id) }
                $engine.DeleteContainers()
                $engine.Commit()
            } catch {
                $engine.Abort()
                throw
            }
            $legacyRules = Remove-LegacyFirewallRules
            $after = Get-OwnedState $engine
            $clean = ($after.filters.Count -eq 0) -and -not $engine.ProviderExists() -and -not $engine.SublayerExists($false) -and -not $engine.SublayerExists($true)
            if (-not $clean) { throw "Purge incomplete: $($after.filters.Count) filters remain." }
            Write-Result @{
                ok                  = $true
                deleted             = $before.filters.Count
                legacyFilters       = $before.legacy
                legacyFirewallRules = $legacyRules
            }
        }
    }
} catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    Write-Result @{ ok = $false; error = $msg; line = $_.InvocationInfo.ScriptLineNumber }
    exit 1
} finally {
    if ($engine) { $engine.Dispose() }
}
