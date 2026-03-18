#Requires -Version 5.0
# DBD Game Server Tracker - ETW (Event Tracing for Windows)
# Uses Microsoft-Windows-Kernel-Network provider to capture real-time UDP events.
# Detects the actual game server IP:port from DBD's UDP traffic.
# Outputs one JSON line per poll tick to stdout; debug logs go to stderr.
param(
    [string]$DbdProcessName = 'DeadByDaylight-Win64-Shipping',
    [int]$PollMs     = 500,
    [int]$WindowSecs = 5
)

$ErrorActionPreference = 'SilentlyContinue'

# --- Embedded C# - ETW real-time session for UDP kernel network events ---
$csharpCode = @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class EtwNet {

    // Microsoft-Windows-Kernel-Network provider
    static readonly Guid KERNEL_NETWORK = new Guid(
        0x7DD42A49, 0x5329, 0x4832, 0x8D, 0xFD, 0x43, 0xD9, 0x79, 0x15, 0x3A, 0x88);
    const string SESSION = "DBD-Blocker-ETW";

    const uint EVENT_TRACE_REAL_TIME_MODE      = 0x00000100;
    const uint PROCESS_TRACE_MODE_REAL_TIME    = 0x00000100;
    const uint PROCESS_TRACE_MODE_EVENT_RECORD = 0x10000000;
    const uint WNODE_FLAG_TRACED_GUID          = 0x00020000;
    const int  EVENT_TRACE_CONTROL_STOP        = 1;
    const int  EVENT_CONTROL_CODE_ENABLE       = 1;
    const byte TRACE_LEVEL_VERBOSE             = 5;
    const ulong KEYWORD_UDPIP                  = 0x10;  // UDP only

    // State
    #pragma warning disable 414
    static long _sessionHandle;
    static long _traceHandle = -1;
    static Thread _thread;
    static volatile bool _running;
    static volatile int _filterPid;
    #pragma warning restore 414
    static ConcurrentQueue<NetEvent> _queue = new ConcurrentQueue<NetEvent>();
    static int _callbackCount;

    static Delegate _callbackKeepAlive;
    static IntPtr _loggerNamePtr = IntPtr.Zero;

    public class NetEvent {
        public string RemoteIp;
        public int    RemotePort;
        public int    LocalPort;
        public int    Pid;
        public long   Ts;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void EventRecordCallbackDelegate(IntPtr eventRecord);

    // P/Invoke
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int StartTraceW(out long sessionHandle, string sessionName, IntPtr properties);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern int EnableTraceEx2(long traceHandle, ref Guid providerId, int controlCode,
        byte level, ulong matchAnyKeyword, ulong matchAllKeyword, int timeout, IntPtr enableParameters);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern long OpenTraceW(IntPtr logfile);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern int ProcessTrace([In] long[] handleArray, int handleCount, IntPtr startTime, IntPtr endTime);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int ControlTraceW(long sessionHandle, string sessionName, IntPtr properties, int controlCode);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern int CloseTrace(long traceHandle);
    [DllImport("kernel32.dll", EntryPoint = "RtlZeroMemory")]
    static extern void ZeroMemory(IntPtr dest, IntPtr size);

    // IP/Port helpers (network byte order on little-endian)
    static string Ip(uint v) {
        return (v & 0xFF) + "." + ((v >> 8) & 0xFF) + "." +
               ((v >> 16) & 0xFF) + "." + ((v >> 24) & 0xFF);
    }
    static int Port(ushort v) {
        return ((v & 0xFF) << 8) | ((v >> 8) & 0xFF);
    }
    static bool IsPublic(uint ip) {
        byte a = (byte)(ip & 0xFF);
        byte b = (byte)((ip >> 8) & 0xFF);
        if (a == 0 || a == 10 || a == 127) return false;
        if (a == 169 && b == 254) return false;
        if (a == 172 && b >= 16 && b <= 31) return false;
        if (a == 192 && b == 168) return false;
        if (a >= 224) return false;
        return true;
    }

    // Filter out well-known service ports that are NOT game servers
    static bool IsGamePort(int port) {
        if (port == 53 || port == 80 || port == 443) return false;   // DNS, HTTP, HTTPS
        if (port == 3478 || port == 3479) return false;              // STUN/TURN
        if (port == 123) return false;                               // NTP
        return true;
    }

    // EVENT_RECORD offsets (x64):
    //   +0x28  ushort EventDescriptor.Id
    //   +0x2D  byte   Opcode
    //   +0x56  ushort UserDataLength
    //   +0x60  IntPtr UserData
    //
    // UserData for UdpIp IPv4:
    //   +0x00  uint PID       +0x04  uint size
    //   +0x08  uint daddr     +0x0C  uint saddr
    //   +0x10  ushort dport   +0x12  ushort sport

    static void OnEvent(IntPtr rec) {
        Interlocked.Increment(ref _callbackCount);
        try {
            ushort userDataLen = (ushort)Marshal.ReadInt16(rec, 0x56);
            IntPtr userData    = Marshal.ReadIntPtr(rec, 0x60);
            if (userData == IntPtr.Zero || userDataLen < 20) return;

            int pid = Marshal.ReadInt32(userData, 0);
            if (_filterPid != 0 && pid != _filterPid) return;

            byte opcode = Marshal.ReadByte(rec, 0x2D);

            uint   daddr = (uint)Marshal.ReadInt32(userData, 0x08);
            uint   saddr = (uint)Marshal.ReadInt32(userData, 0x0C);
            ushort dport = (ushort)Marshal.ReadInt16(userData, 0x10);
            ushort sport = (ushort)Marshal.ReadInt16(userData, 0x12);

            // Send (opcode 1/10): daddr=remote, Recv (opcode 2/11): saddr=remote
            bool isRecv = (opcode == 2 || opcode == 11);
            uint   remoteRaw  = isRecv ? saddr : daddr;
            int    remotePort = isRecv ? Port(sport) : Port(dport);
            int    localPort  = isRecv ? Port(dport) : Port(sport);

            if (!IsPublic(remoteRaw)) return;
            if (!IsGamePort(remotePort)) return;

            _queue.Enqueue(new NetEvent {
                RemoteIp   = Ip(remoteRaw),
                RemotePort = remotePort,
                LocalPort  = localPort,
                Pid        = pid,
                Ts         = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
        } catch { }
    }

    public static int GetCallbackCount() { return _callbackCount; }

    static IntPtr AllocProps(int extra) {
        int total = 120 + extra;
        IntPtr p = Marshal.AllocHGlobal(total);
        ZeroMemory(p, (IntPtr)total);
        Marshal.WriteInt32(p, 0, total);
        return p;
    }

    static void StopExisting() {
        IntPtr props = AllocProps(512);
        ControlTraceW(0, SESSION, props, EVENT_TRACE_CONTROL_STOP);
        Marshal.FreeHGlobal(props);
    }

    public static string Start(int pid) {
        _filterPid = pid;
        _running = true;
        NetEvent d; while (_queue.TryDequeue(out d)) { }

        StopExisting();
        System.Threading.Thread.Sleep(200);

        // StartTrace
        IntPtr props = AllocProps(512);
        Marshal.WriteInt32(props, 44, unchecked((int)WNODE_FLAG_TRACED_GUID));
        Marshal.WriteInt32(props, 48, 64);   // BufferSize KB
        Marshal.WriteInt32(props, 52, 4);    // MinBuffers
        Marshal.WriteInt32(props, 56, 16);   // MaxBuffers
        Marshal.WriteInt32(props, 64, unchecked((int)EVENT_TRACE_REAL_TIME_MODE));
        Marshal.WriteInt32(props, 68, 1);    // FlushTimer
        Marshal.WriteInt32(props, 116, 120); // LoggerNameOffset

        long sh;
        int err = StartTraceW(out sh, SESSION, props);
        Marshal.FreeHGlobal(props);
        if (err != 0) return "StartTrace error " + err + " (0x" + err.ToString("X") + ")";
        _sessionHandle = sh;

        // EnableTraceEx2 - UDP only
        Guid g = KERNEL_NETWORK;
        err = EnableTraceEx2(sh, ref g, EVENT_CONTROL_CODE_ENABLE,
            TRACE_LEVEL_VERBOSE, KEYWORD_UDPIP, 0, 0, IntPtr.Zero);
        if (err != 0) return "EnableTraceEx2 error " + err;

        // OpenTrace (EVENT_TRACE_LOGFILEW raw offsets on x64)
        IntPtr lf = Marshal.AllocHGlobal(1024);
        ZeroMemory(lf, (IntPtr)1024);
        _loggerNamePtr = Marshal.StringToHGlobalUni(SESSION);
        Marshal.WriteIntPtr(lf, 0x008, _loggerNamePtr);
        Marshal.WriteInt32(lf, 0x01C,
            unchecked((int)(PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD)));
        EventRecordCallbackDelegate cb = new EventRecordCallbackDelegate(OnEvent);
        _callbackKeepAlive = cb;
        Marshal.WriteIntPtr(lf, 0x1A8, Marshal.GetFunctionPointerForDelegate(cb));

        long th = OpenTraceW(lf);
        Marshal.FreeHGlobal(lf);
        if (th == -1 || th == 0) return "OpenTrace error " + Marshal.GetLastWin32Error();
        _traceHandle = th;

        // ProcessTrace on background thread
        _thread = new Thread(() => {
            ProcessTrace(new long[] { _traceHandle }, 1, IntPtr.Zero, IntPtr.Zero);
        });
        _thread.IsBackground = true;
        _thread.Name = "ETW-ProcessTrace";
        _thread.Start();
        return "ok";
    }

    public static NetEvent[] Drain() {
        var l = new System.Collections.Generic.List<NetEvent>();
        NetEvent ev; while (_queue.TryDequeue(out ev)) l.Add(ev);
        return l.ToArray();
    }

    public static void SetPid(int pid) { _filterPid = pid; }
    public static int QueueSize() { return _queue.Count; }

    public static void Stop() {
        _running = false;
        if (_traceHandle != -1 && _traceHandle != 0) { CloseTrace(_traceHandle); _traceHandle = -1; }
        if (_thread != null && _thread.IsAlive) _thread.Join(3000);
        StopExisting();
        if (_loggerNamePtr != IntPtr.Zero) { Marshal.FreeHGlobal(_loggerNamePtr); _loggerNamePtr = IntPtr.Zero; }
    }
}
'@

try {
    Add-Type -TypeDefinition $csharpCode -Language CSharp -ErrorAction Stop
    [Console]::Error.WriteLine('[ETW-Tracker] C# compiled OK')
} catch {
    [Console]::Error.WriteLine("[ETW-Tracker] C# compile error: $_")
    exit 1
}

# --- Helpers ---
function Log([string]$msg) { [Console]::Error.WriteLine("[ETW-Tracker] $msg") }

function Get-DbdPid {
    $p = Get-Process -Name $DbdProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { return $p.Id } else { return 0 }
}

function Test-ExitLag {
    $p = Get-Process -Name 'ExitLag' -ErrorAction SilentlyContinue
    return ($null -ne $p)
}

function Emit([object]$obj) {
    $obj | ConvertTo-Json -Compress -Depth 4 | ForEach-Object {
        [Console]::Out.WriteLine($_)
        [Console]::Out.Flush()
    }
}

# --- Rolling window for UDP game server ---
$udpWindow = [System.Collections.Generic.Dictionary[string,hashtable]]::new()
$windowMs  = $WindowSecs * 1000
$localUdpPorts = [System.Collections.Generic.HashSet[int]]::new()
$localUdpPortsLastClean = 0

function Score-Window([System.Collections.Generic.Dictionary[string,hashtable]]$win, [long]$now, [long]$winMs) {
    $expired = @($win.Keys | Where-Object { ($now - $win[$_].lastSeen) -gt $winMs })
    foreach ($k in $expired) { $win.Remove($k) | Out-Null }

    if ($win.Count -eq 0) { return @{ server=$null; confidence=0.0; candidates=@() } }

    $maxCount = ($win.Values | Measure-Object -Property count -Maximum).Maximum
    if (-not $maxCount -or $maxCount -le 0) { $maxCount = 1 }

    $candidates = foreach ($key in $win.Keys) {
        $e       = $win[$key]
        $freq    = [Math]::Min(1.0, $e.count / $maxCount)
        $age     = $now - $e.lastSeen
        $recency = [Math]::Max(0.0, 1.0 - ($age / $winMs))
        $score   = [Math]::Round(($freq * 0.7) + ($recency * 0.3), 4)
        $score   = [Math]::Min(1.0, [Math]::Max(0.0, $score))
        [PSCustomObject]@{
            ip=$e.ip; port=$e.port; score=$score; lastSeen=$e.lastSeen; count=$e.count
        }
    }

    $sorted = @($candidates | Sort-Object score -Descending)
    $top    = $sorted[0]
    $server = "$($top.ip):$($top.port)"
    $confidence = if ($sorted.Count -eq 1) {
        [Math]::Min(1.0, $top.score)
    } else {
        $margin = $top.score - $sorted[1].score
        [Math]::Min(1.0, [Math]::Round($top.score + ($margin * 0.5), 4))
    }
    return @{ server=$server; confidence=[Math]::Min(1.0, $confidence); candidates=$sorted }
}

# --- Main loop ---
$lastDbdPid = 0
$etwStarted = $false
$tickN      = 0
$lastServer = $null

# Cache PID+ExitLag check (every 3s instead of every tick)
$pidCheckInterval = 3000
$lastPidCheck     = 0
$cachedDbdPid     = 0
$cachedExitLag    = $false

Log ('Started (poll={0}ms, window={1}s, process={2})' -f $PollMs, $WindowSecs, $DbdProcessName)

try {
    while ($true) {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $tickN++

        # Throttled PID + ExitLag check
        if (($now - $lastPidCheck) -gt $pidCheckInterval) {
            $cachedDbdPid  = Get-DbdPid
            $cachedExitLag = Test-ExitLag
            $lastPidCheck  = $now
        }
        $dbdPid = $cachedDbdPid

        if ($dbdPid -ne $lastDbdPid) {
            if ($dbdPid -eq 0) {
                Log "DBD stopped - clearing state"
                $udpWindow.Clear()
                $localUdpPorts.Clear()
                $lastServer = $null
            } else {
                Log "DBD detected (PID: $dbdPid)"
                [EtwNet]::SetPid($dbdPid)
                if (-not $etwStarted) {
                    $result = [EtwNet]::Start($dbdPid)
                    if ($result -eq 'ok') {
                        Log "ETW session started"
                        $etwStarted = $true
                    } else {
                        Log "ETW FAILED: $result"
                    }
                }
            }
            $lastDbdPid = $dbdPid
        }

        if ($dbdPid -eq 0) {
            Emit ([PSCustomObject]@{
                dbdRunning=$false; current_server=$null; confidence=0.0
                candidates=@(); udpPorts=@(); dbdPid=0
                exitlagRunning=$cachedExitLag; t=$now
            })
            Start-Sleep -Milliseconds $PollMs
            continue
        }

        # Drain ETW UDP events
        $events   = [EtwNet]::Drain()
        $udpCount = 0

        foreach ($ev in $events) {
            $udpCount++
            $key = "$($ev.RemoteIp):$($ev.RemotePort)"
            if (-not $udpWindow.ContainsKey($key)) {
                $udpWindow[$key] = @{
                    ip=$ev.RemoteIp; port=$ev.RemotePort
                    firstSeen=$now; lastSeen=$now; count=0
                }
            }
            $udpWindow[$key].lastSeen = $now
            $udpWindow[$key].count++

            if ($ev.LocalPort -gt 0) { $localUdpPorts.Add($ev.LocalPort) | Out-Null }
        }

        # Periodic log
        if ($tickN % 20 -eq 0) {
            $logMsg = 'tick={0} events={1} endpoints={2} q={3} exitlag={4}' -f $tickN, $udpCount, $udpWindow.Count, [EtwNet]::QueueSize(), $cachedExitLag
            Log $logMsg
        }

        # Clean stale local ports
        if (($now - $localUdpPortsLastClean) -gt 10000) {
            $localUdpPorts.Clear()
            $localUdpPortsLastClean = $now
        }

        # Score
        $result = Score-Window $udpWindow $now $windowMs

        # Log server change
        if ($result.server -and $result.server -ne $lastServer) {
            $conf = [Math]::Round($result.confidence, 2)
            Log ('Game server: {0} (confidence={1})' -f $result.server, $conf)
            $lastServer = $result.server
        }

        Emit ([PSCustomObject]@{
            dbdRunning     = $true
            current_server = $result.server
            confidence     = $result.confidence
            candidates     = $result.candidates
            udpPorts       = @($localUdpPorts | Sort-Object)
            dbdPid         = $dbdPid
            exitlagRunning = $cachedExitLag
            t              = $now
        })

        Start-Sleep -Milliseconds $PollMs
    }
}
finally {
    Log "Shutting down..."
    [EtwNet]::Stop()
    Log "Stopped"
}
