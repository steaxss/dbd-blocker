#Requires -Version 5.0
# DBD Game Server Tracker - ETW (Event Tracing for Windows)
# Uses Microsoft-Windows-Kernel-Network provider to capture real-time UDP events.
# Detects the actual game server IP:port from DBD's UDP traffic.
# Outputs one JSON line per poll tick to stdout; debug logs go to stderr.
param(
    [string]$DbdProcessName = 'DeadByDaylight-Win64-Shipping',
    [ValidateRange(100, 5000)]
    [int]$PollMs     = 500,
    [ValidateRange(1, 60)]
    [int]$WindowSecs = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-64BitProcess {
    if (-not [Environment]::Is64BitProcess) {
        throw '64-bit PowerShell is required for the ETW tracker.'
    }
}

Assert-64BitProcess

# --- Embedded C# - ETW real-time session for UDP kernel network events ---
$csharpCode = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class EtwNet {

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
    const ulong KEYWORD_UDPIP                  = 0x10;

    static long _sessionHandle;
    static long _traceHandle = -1;
    static Thread _thread;
    static volatile int _filterPid;
    static ConcurrentQueue<NetEvent> _queue = new ConcurrentQueue<NetEvent>();
    static int _callbackCount;

    static Delegate _callbackKeepAlive;
    static IntPtr _loggerNamePtr = IntPtr.Zero;

    public class NetEvent {
        public string RemoteIp;
        public int RemotePort;
        public int LocalPort;
        public int Pid;
        public long Ts;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WNODE_HEADER {
        public uint BufferSize;
        public uint ProviderId;
        public ulong HistoricalContext;
        public long TimeStamp;
        public Guid Guid;
        public uint ClientContext;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE_PROPERTIES {
        public WNODE_HEADER Wnode;
        public uint BufferSize;
        public uint MinimumBuffers;
        public uint MaximumBuffers;
        public uint MaximumFileSize;
        public uint LogFileMode;
        public uint FlushTimer;
        public uint EnableFlags;
        public int AgeLimit;
        public uint NumberOfBuffers;
        public uint FreeBuffers;
        public uint EventsLost;
        public uint BuffersWritten;
        public uint LogBuffersLost;
        public uint RealTimeBuffersLost;
        public IntPtr LoggerThreadId;
        public uint LogFileNameOffset;
        public uint LoggerNameOffset;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_DESCRIPTOR {
        public ushort Id;
        public byte Version;
        public byte Channel;
        public byte Level;
        public byte Opcode;
        public ushort Task;
        public ulong Keyword;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_HEADER {
        public ushort Size;
        public ushort HeaderType;
        public ushort Flags;
        public ushort EventProperty;
        public uint ThreadId;
        public uint ProcessId;
        public long TimeStamp;
        public Guid ProviderId;
        public EVENT_DESCRIPTOR EventDescriptor;
        public ulong ProcessorTime;
        public Guid ActivityId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_RECORD {
        public EVENT_HEADER EventHeader;
        public uint BufferContext;
        public ushort ExtendedDataCount;
        public ushort UserDataLength;
        public IntPtr ExtendedData;
        public IntPtr UserData;
        public IntPtr UserContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE_HEADER {
        public ushort Size;
        public ushort FieldTypeFlags;
        public uint Version;
        public uint ThreadId;
        public uint ProcessId;
        public long TimeStamp;
        public Guid Guid;
        public ulong ProcessorTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE {
        public EVENT_TRACE_HEADER Header;
        public uint InstanceId;
        public uint ParentInstanceId;
        public Guid ParentGuid;
        public IntPtr MofData;
        public uint MofLength;
        public uint ClientContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TRACE_LOGFILE_HEADER {
        public uint BufferSize;
        public uint Version;
        public uint ProviderVersion;
        public uint NumberOfProcessors;
        public long EndTime;
        public uint TimerResolution;
        public uint MaximumFileSize;
        public uint LogFileMode;
        public uint BuffersWritten;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] LogInstanceOrData;
        public IntPtr LoggerName;
        public IntPtr LogFileName;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 172)]
        public byte[] TimeZoneInformation;
        public long BootTime;
        public long PerfFreq;
        public long StartTime;
        public uint ReservedFlags;
        public uint BuffersLost;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE_LOGFILEW {
        public IntPtr LogFileName;
        public IntPtr LoggerName;
        public long CurrentTime;
        public uint BuffersRead;
        public uint ProcessTraceMode;
        public EVENT_TRACE CurrentEvent;
        public TRACE_LOGFILE_HEADER LogfileHeader;
        public IntPtr BufferCallback;
        public uint BufferSize;
        public uint Filled;
        public uint EventsLost;
        public IntPtr EventRecordCallback;
        public uint IsKernelTrace;
        public IntPtr Context;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct UdpIpV4Payload {
        public uint Pid;
        public uint Size;
        public uint DestinationAddress;
        public uint SourceAddress;
        public ushort DestinationPort;
        public ushort SourcePort;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void EventRecordCallbackDelegate(IntPtr eventRecord);

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

    static bool IsGamePort(int port) {
        if (port == 53 || port == 80 || port == 443) return false;
        if (port == 3478 || port == 3479) return false;
        if (port == 123) return false;
        return true;
    }

    static IntPtr AllocPropertiesBuffer(string loggerName) {
        int propsSize = Marshal.SizeOf(typeof(EVENT_TRACE_PROPERTIES));
        byte[] nameBytes = Encoding.Unicode.GetBytes(loggerName + "\0");
        int total = propsSize + nameBytes.Length;
        IntPtr buffer = Marshal.AllocHGlobal(total);
        ZeroMemory(buffer, (IntPtr)total);

        var props = new EVENT_TRACE_PROPERTIES();
        props.Wnode.BufferSize = (uint)total;
        props.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        props.BufferSize = 64;
        props.MinimumBuffers = 4;
        props.MaximumBuffers = 16;
        props.LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
        props.FlushTimer = 1;
        props.LoggerNameOffset = (uint)propsSize;

        Marshal.StructureToPtr(props, buffer, false);
        Marshal.Copy(nameBytes, 0, IntPtr.Add(buffer, propsSize), nameBytes.Length);
        return buffer;
    }

    static void StopExisting() {
        IntPtr props = AllocPropertiesBuffer(SESSION);
        try {
            ControlTraceW(0, SESSION, props, EVENT_TRACE_CONTROL_STOP);
        } finally {
            Marshal.FreeHGlobal(props);
        }
    }

    static void OnEvent(IntPtr eventRecordPtr) {
        Interlocked.Increment(ref _callbackCount);
        try {
            var record = (EVENT_RECORD)Marshal.PtrToStructure(eventRecordPtr, typeof(EVENT_RECORD));
            if (record.UserData == IntPtr.Zero || record.UserDataLength < Marshal.SizeOf(typeof(UdpIpV4Payload))) return;

            var payload = (UdpIpV4Payload)Marshal.PtrToStructure(record.UserData, typeof(UdpIpV4Payload));
            int pid = unchecked((int)payload.Pid);
            if (_filterPid != 0 && pid != _filterPid) return;

            byte opcode = record.EventHeader.EventDescriptor.Opcode;
            bool isRecv = (opcode == 2 || opcode == 11);
            uint remoteRaw = isRecv ? payload.SourceAddress : payload.DestinationAddress;
            int remotePort = isRecv ? Port(payload.SourcePort) : Port(payload.DestinationPort);
            int localPort = isRecv ? Port(payload.DestinationPort) : Port(payload.SourcePort);

            if (!IsPublic(remoteRaw)) return;
            if (!IsGamePort(remotePort)) return;

            _queue.Enqueue(new NetEvent {
                RemoteIp = Ip(remoteRaw),
                RemotePort = remotePort,
                LocalPort = localPort,
                Pid = pid,
                Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            });
        } catch { }
    }

    public static int GetCallbackCount() { return _callbackCount; }

    public static string Start(int pid) {
        if (IntPtr.Size != 8) return "64-bit process required";
        _filterPid = pid;
        NetEvent d; while (_queue.TryDequeue(out d)) { }

        StopExisting();
        Thread.Sleep(200);

        IntPtr props = AllocPropertiesBuffer(SESSION);
        long sh;
        int err = StartTraceW(out sh, SESSION, props);
        Marshal.FreeHGlobal(props);
        if (err != 0) return "StartTrace error " + err + " (0x" + err.ToString("X") + ")";
        _sessionHandle = sh;

        Guid g = KERNEL_NETWORK;
        err = EnableTraceEx2(sh, ref g, EVENT_CONTROL_CODE_ENABLE, TRACE_LEVEL_VERBOSE, KEYWORD_UDPIP, 0, 0, IntPtr.Zero);
        if (err != 0) {
            StopExisting();
            return "EnableTraceEx2 error " + err;
        }

        var logfile = new EVENT_TRACE_LOGFILEW();
        logfile.LogfileHeader.LogInstanceOrData = new byte[16];
        logfile.LogfileHeader.TimeZoneInformation = new byte[172];
        _loggerNamePtr = Marshal.StringToHGlobalUni(SESSION);
        logfile.LoggerName = _loggerNamePtr;
        logfile.ProcessTraceMode = unchecked((uint)(PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD));

        EventRecordCallbackDelegate cb = new EventRecordCallbackDelegate(OnEvent);
        _callbackKeepAlive = cb;
        logfile.EventRecordCallback = Marshal.GetFunctionPointerForDelegate(cb);

        int logfileSize = Marshal.SizeOf(typeof(EVENT_TRACE_LOGFILEW));
        IntPtr logfilePtr = Marshal.AllocHGlobal(logfileSize);
        ZeroMemory(logfilePtr, (IntPtr)logfileSize);
        Marshal.StructureToPtr(logfile, logfilePtr, false);

        long th = OpenTraceW(logfilePtr);
        Marshal.FreeHGlobal(logfilePtr);
        if (th == -1 || th == 0) {
            StopExisting();
            if (_loggerNamePtr != IntPtr.Zero) { Marshal.FreeHGlobal(_loggerNamePtr); _loggerNamePtr = IntPtr.Zero; }
            return "OpenTrace error " + Marshal.GetLastWin32Error();
        }

        _traceHandle = th;
        _thread = new Thread(() => {
            ProcessTrace(new long[] { _traceHandle }, 1, IntPtr.Zero, IntPtr.Zero);
        });
        _thread.IsBackground = true;
        _thread.Name = "ETW-ProcessTrace";
        _thread.Start();
        return "ok";
    }

    public static NetEvent[] Drain() {
        var list = new List<NetEvent>();
        NetEvent ev; while (_queue.TryDequeue(out ev)) list.Add(ev);
        return list.ToArray();
    }

    public static void SetPid(int pid) { _filterPid = pid; }
    public static int QueueSize() { return _queue.Count; }

    public static void Stop() {
        if (_traceHandle != -1 && _traceHandle != 0) {
            CloseTrace(_traceHandle);
            _traceHandle = -1;
        }
        if (_thread != null && _thread.IsAlive) _thread.Join(3000);
        StopExisting();
        if (_loggerNamePtr != IntPtr.Zero) {
            Marshal.FreeHGlobal(_loggerNamePtr);
            _loggerNamePtr = IntPtr.Zero;
        }
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
                $dbdProcess = Get-DbdProcess
                $dbdLabel = if ($dbdProcess) { "$($dbdProcess.ProcessName) (PID: $dbdPid)" } else { "PID: $dbdPid" }
                Log "DBD detected ($dbdLabel)"
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
