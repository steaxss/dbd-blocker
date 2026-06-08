#Requires -Version 5.0
# DBD Connection Tracker — GetExtendedTcpTable + GetExtendedUdpTable
# Tracks TCP remote endpoints (gives IP:port) and UDP local sockets (gives port only).
# TCP is used for scoring because it exposes the remote server IP; UDP confirms activity.
# Outputs one JSON line per poll tick to stdout; debug logs go to stderr.
param(
    [string]$DbdProcessName = 'DeadByDaylight-Win64-Shipping',
    [ValidateRange(100, 5000)]
    [int]$PollMs     = 300,
    [ValidateRange(1, 60)]
    [int]$WindowSecs = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Embedded C# — P/Invoke for IP Helper API ──────────────────────────────────
$csharpCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ConnTracker {
    const int AF_INET                 = 2;
    const int TCP_TABLE_OWNER_PID_ALL = 5;   // all states, with owning PID
    const int UDP_TABLE_OWNER_PID     = 1;   // local socket + owning PID

    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern int GetExtendedTcpTable(
        IntPtr pTcpTable, ref int dwOutBufLen,
        [MarshalAs(UnmanagedType.Bool)] bool bOrder,
        int ulAf, int TableClass, int Reserved);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern int GetExtendedUdpTable(
        IntPtr pUdpTable, ref int dwOutBufLen,
        [MarshalAs(UnmanagedType.Bool)] bool bOrder,
        int ulAf, int TableClass, int Reserved);

    public class TcpEntry {
        public int    State, LocalPort, RemotePort, Pid;
        public string LocalAddr, RemoteAddr;
    }
    public class UdpEntry {
        public int    LocalPort, Pid;
        public string LocalAddr;
    }

    // IPv4 DWORD stored in network byte order — read bytes low-to-high = IP octets
    static string U2Ip(uint v) =>
        (v & 0xFF) + "." + ((v >> 8) & 0xFF) + "." + ((v >> 16) & 0xFF) + "." + ((v >> 24) & 0xFF);

    // Port DWORD: stored as big-endian USHORT — swap low 2 bytes
    static int ToPort(uint v) => (int)(((v & 0xFF) << 8) | ((v >> 8) & 0xFF));

    // MIB_TCPROW_OWNER_PID: 6 DWORDs (24 bytes)
    //   [0] State  [4] LocalAddr  [8] LocalPort  [12] RemoteAddr  [16] RemotePort  [20] OwningPid
    public static List<TcpEntry> GetTcp(int filterPid) {
        var r = new List<TcpEntry>();
        int sz = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref sz, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
        if (sz == 0) return r;
        IntPtr buf = Marshal.AllocHGlobal(sz + 512);
        try {
            if (GetExtendedTcpTable(buf, ref sz, false, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) != 0) return r;
            int n = Marshal.ReadInt32(buf, 0);
            for (int i = 0; i < n; i++) {
                int o   = 4 + i * 24;
                int pid = Marshal.ReadInt32(buf, o + 20);
                if (filterPid != 0 && pid != filterPid) continue;
                r.Add(new TcpEntry {
                    State      = Marshal.ReadInt32(buf, o),
                    LocalAddr  = U2Ip((uint)Marshal.ReadInt32(buf, o + 4)),
                    LocalPort  = ToPort((uint)Marshal.ReadInt32(buf, o + 8)),
                    RemoteAddr = U2Ip((uint)Marshal.ReadInt32(buf, o + 12)),
                    RemotePort = ToPort((uint)Marshal.ReadInt32(buf, o + 16)),
                    Pid        = pid
                });
            }
        } finally { Marshal.FreeHGlobal(buf); }
        return r;
    }

    // MIB_UDPROW_OWNER_PID: 3 DWORDs (12 bytes)
    //   [0] LocalAddr  [4] LocalPort  [8] OwningPid
    public static List<UdpEntry> GetUdp(int filterPid) {
        var r = new List<UdpEntry>();
        int sz = 0;
        GetExtendedUdpTable(IntPtr.Zero, ref sz, false, AF_INET, UDP_TABLE_OWNER_PID, 0);
        if (sz == 0) return r;
        IntPtr buf = Marshal.AllocHGlobal(sz + 512);
        try {
            if (GetExtendedUdpTable(buf, ref sz, false, AF_INET, UDP_TABLE_OWNER_PID, 0) != 0) return r;
            int n = Marshal.ReadInt32(buf, 0);
            for (int i = 0; i < n; i++) {
                int o   = 4 + i * 12;
                int pid = Marshal.ReadInt32(buf, o + 8);
                if (filterPid != 0 && pid != filterPid) continue;
                r.Add(new UdpEntry {
                    LocalAddr = U2Ip((uint)Marshal.ReadInt32(buf, o)),
                    LocalPort = ToPort((uint)Marshal.ReadInt32(buf, o + 4)),
                    Pid       = pid
                });
            }
        } finally { Marshal.FreeHGlobal(buf); }
        return r;
    }

    // Rejects loopback, private, link-local, multicast, unspecified
    public static bool IsPublic(string ip) {
        var p = ip.Split('.');
        int a, b;
        if (p.Length != 4 || !int.TryParse(p[0], out a) || !int.TryParse(p[1], out b)) return false;
        if (a == 0 || a == 10 || a == 127)               return false;
        if (a == 169 && b == 254)                         return false;
        if (a == 172 && b >= 16 && b <= 31)               return false;
        if (a == 192 && b == 168)                         return false;
        if (a >= 224)                                     return false;
        return true;
    }
}
'@

try {
    Add-Type -TypeDefinition $csharpCode -Language CSharp -ErrorAction Stop
    [Console]::Error.WriteLine('[Tracker] C# compiled OK')
} catch {
    [Console]::Error.WriteLine("[Tracker] C# compile error: $_")
    exit 1
}

# ── Helpers ────────────────────────────────────────────────────────────────────
function Log([string]$msg) { [Console]::Error.WriteLine("[Tracker] $msg") }

function Get-DbdProcess {
    $candidateNames = @(
        $DbdProcessName,
        'DeadByDaylight-Win64-Shipping',
        'DeadByDaylight-WinGDK-Shipping'
    ) | Where-Object { $_ } | Select-Object -Unique

    foreach ($name in $candidateNames) {
        $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p) { return $p }
    }

    return $null
}

function Get-DbdPid {
    $p = Get-DbdProcess
    if ($p) { return $p.Id } else { return 0 }
}

function Emit([object]$obj) {
    $obj | ConvertTo-Json -Compress -Depth 4 | ForEach-Object {
        [Console]::Out.WriteLine($_)
        [Console]::Out.Flush()
    }
}

# ── Rolling window ──────────────────────────────────────────────────────────────
# Key = "ip:port"   Value = { ip, port, firstSeen, lastSeen, count }
$window   = [System.Collections.Generic.Dictionary[string,hashtable]]::new()
$windowMs = $WindowSecs * 1000

# ── Main loop ──────────────────────────────────────────────────────────────────
$lastDbdPid = 0
$tickN      = 0

Log "Started (poll=${PollMs}ms, window=${WindowSecs}s, process=$DbdProcessName)"

while ($true) {
    $now   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $tickN++

    # ── Resolve DBD PID ─────────────────────────────────────────────────────────
    $dbdPid = Get-DbdPid

    if ($dbdPid -ne $lastDbdPid) {
        if ($dbdPid -eq 0) {
            Log "DBD stopped — clearing window"
            $window.Clear()
        } else {
            $dbdProcess = Get-DbdProcess
            $dbdLabel = if ($dbdProcess) { "$($dbdProcess.ProcessName) (PID: $dbdPid)" } else { "PID: $dbdPid" }
            Log "DBD detected ($dbdLabel)"
        }
        $lastDbdPid = $dbdPid
    }

    if ($dbdPid -eq 0) {
        Emit ([PSCustomObject]@{
            dbdRunning     = $false
            current_server = $null
            confidence     = 0.0
            candidates     = @()
            udpPorts       = @()
            dbdPid         = 0
            t              = $now
        })
        Start-Sleep -Milliseconds $PollMs
        continue
    }

    # ── Poll connection tables ──────────────────────────────────────────────────
    $tcpEntries = [ConnTracker]::GetTcp($dbdPid)
    $udpEntries = [ConnTracker]::GetUdp($dbdPid)

    Log "Poll tick t=$now — TCP:$($tcpEntries.Count) UDP:$($udpEntries.Count)"

    # ── Update rolling window with public TCP remote endpoints ──────────────────
    foreach ($conn in $tcpEntries) {
        if (-not [ConnTracker]::IsPublic($conn.RemoteAddr)) { continue }
        $key = "$($conn.RemoteAddr):$($conn.RemotePort)"
        if (-not $window.ContainsKey($key)) {
            $window[$key] = @{ ip = $conn.RemoteAddr; port = $conn.RemotePort; firstSeen = $now; lastSeen = $now; count = 0 }
            Log "New endpoint: $key"
        }
        $window[$key].lastSeen = $now
        $window[$key].count++
        Log "Updated endpoint: $key (count=$($window[$key].count))"
    }

    # ── Prune entries outside the rolling window ────────────────────────────────
    $expired = @($window.Keys | Where-Object { ($now - $window[$_].lastSeen) -gt $windowMs })
    foreach ($k in $expired) {
        Log "Expired endpoint: $k"
        $window.Remove($k) | Out-Null
    }

    # ── Compute scores ──────────────────────────────────────────────────────────
    #   score = (frequency * 0.7) + (recency * 0.3)
    #   frequency = count / maxCount  (normalized hit count within the window)
    #   recency   = 1 - (age / windowMs)  (how recently the endpoint was seen)
    $maxCount = if ($window.Count -gt 0) {
        ($window.Values | Measure-Object -Property count -Maximum).Maximum
    } else { 1 }
    if (-not $maxCount -or $maxCount -le 0) { $maxCount = 1 }

    $candidates = foreach ($key in $window.Keys) {
        $e        = $window[$key]
        $freq     = $e.count / $maxCount
        $age      = $now - $e.lastSeen
        $recency  = [Math]::Max(0.0, 1.0 - ($age / $windowMs))
        $score    = [Math]::Round(($freq * 0.7) + ($recency * 0.3), 4)
        Log "Score: $key = $score (freq=$([Math]::Round($freq,3)), recency=$([Math]::Round($recency,3)), count=$($e.count))"
        [PSCustomObject]@{
            ip       = $e.ip
            port     = $e.port
            score    = $score
            lastSeen = $e.lastSeen
            count    = $e.count
        }
    }

    $sorted = @($candidates | Sort-Object score -Descending)

    # ── Select current server ───────────────────────────────────────────────────
    $currentServer = $null
    $confidence    = 0.0

    if ($sorted.Count -gt 0) {
        $top           = $sorted[0]
        $currentServer = "$($top.ip):$($top.port)"

        if ($sorted.Count -eq 1) {
            $confidence = $top.score
        } else {
            $margin     = $top.score - $sorted[1].score
            $confidence = [Math]::Min(1.0, [Math]::Round($top.score + ($margin * 0.5), 4))
        }
        Log "Selected server: $currentServer (confidence=$confidence, candidates=$($sorted.Count))"
    }

    # ── UDP local ports (confirms UDP activity) ─────────────────────────────────
    $udpPorts = @($udpEntries | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique)

    # ── Emit JSON line ──────────────────────────────────────────────────────────
    Emit ([PSCustomObject]@{
        dbdRunning     = $true
        current_server = $currentServer
        confidence     = $confidence
        candidates     = $sorted
        udpPorts       = $udpPorts
        dbdPid         = $dbdPid
        t              = $now
    })

    Start-Sleep -Milliseconds $PollMs
}
