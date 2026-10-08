





















using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
using System.Threading;

internal static class RobloxNative
{
    private static int Main(string[] args)
    {
        try
        {
            string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "";
            switch (cmd)
            {
                case "mutex":        return RunMutex();
                case "closehandles": return RunCloseHandles();
                case "volume":       return RunVolume(args);
                case "volumeafter":  return RunVolumeAfter(args);
                case "antiafk":      return RunAntiAfk(args);
                case "setram":       return RunSetRam(args);
                case "launchram":    return RunLaunchRam(args);
                default:
                    Console.Error.WriteLine("Unknown command. Use: mutex | closehandles | volume <0-100> [pid ...] | antiafk <seconds> | setram <pid> <mb> | launchram <exe> <cwd> <mb> <uri>");
                    return 2;
            }
        }
        catch (Exception ex)
        {
            
            Console.Error.WriteLine("RobloxNative fatal: " + ex);
            return 1;
        }
    }

    
    
    
    
    
    private static Mutex _singletonMutex;
    private static Mutex _singletonEventMutex;

    private static int RunMutex()
    {
        
        try
        {
            bool created;
            _singletonMutex = new Mutex(true, "ROBLOX_singletonMutex", out created);
            if (!created) { try { _singletonMutex.WaitOne(0); } catch (AbandonedMutexException) { } catch { } }
        }
        catch (Exception ex) { Console.Error.WriteLine("HoldMutex: " + ex.Message); }

        
        
        Console.Out.WriteLine("MUTEX_HELD");
        Console.Out.Flush();

        
        try { HandleCloser.CloseRobloxSingletonHandles(); }
        catch (Exception ex) { Console.Error.WriteLine("CloseHandles(mutex): " + ex.Message); }

        try
        {
            bool created;
            _singletonEventMutex = new Mutex(true, "ROBLOX_singletonEvent", out created);
            if (!created) { try { _singletonEventMutex.WaitOne(0); } catch (AbandonedMutexException) { } catch { } }
        }
        catch (Exception ex) { Console.Error.WriteLine("HoldEventMutex: " + ex.Message); }

        
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }

    
    private static int RunCloseHandles()
    {
        try { HandleCloser.CloseRobloxSingletonHandles(); }
        catch (Exception ex) { Console.Error.WriteLine("CloseHandles: " + ex.Message); }
        Console.Out.WriteLine("HANDLES_DONE");
        Console.Out.Flush();
        return 0;
    }

    
    private static int RunVolume(string[] args)
    {
        int pct = 0;
        if (args.Length > 1) int.TryParse(args[1], out pct);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        float level = pct / 100.0f;

        
        
        
        int[] pids;
        if (args.Length > 2)
        {
            pids = new int[args.Length - 2];
            int count = 0;
            for (int i = 2; i < args.Length; i++)
            {
                int pid;
                if (int.TryParse(args[i], out pid) && pid > 0) pids[count++] = pid;
            }
            if (count < pids.Length)
            {
                var trimmed = new int[count];
                Array.Copy(pids, trimmed, count);
                pids = trimmed;
            }
        }
        else
        {
            try
            {
                var procs = Process.GetProcessesByName("RobloxPlayerBeta");
                pids = new int[procs.Length];
                for (int i = 0; i < procs.Length; i++) pids[i] = procs[i].Id;
            }
            catch { pids = new int[0]; }
        }

        if (pids.Length == 0) { Console.Out.WriteLine("SET:0"); Console.Out.Flush(); return 0; }

        int n = 0;
        try { n = AudioControl.Apply(level, pids); }
        catch (Exception ex) { Console.Error.WriteLine("Volume: " + ex.Message); }
        Console.Out.WriteLine("SET:" + n);
        Console.Out.Flush();
        return 0;
    }

    private static int RunVolumeAfter(string[] args)
    {
        int pct = 0;
        long sinceMs = 0;
        if (args.Length > 1) int.TryParse(args[1], out pct);
        if (args.Length > 2) long.TryParse(args[2], out sinceMs);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;

        var selected = new System.Collections.Generic.List<int>();
        try
        {
            foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
            {
                try
                {
                    long started = (long)(p.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    
                    
                    
                    
                    if (started >= sinceMs) selected.Add(p.Id);
                }
                catch { }
            }
        }
        catch { }

        if (selected.Count == 0) { Console.Out.WriteLine("SET:0"); Console.Out.Flush(); return 0; }
        int n = 0;
        try { n = AudioControl.Apply(pct / 100.0f, selected.ToArray()); }
        catch (Exception ex) { Console.Error.WriteLine("VolumeAfter: " + ex.Message); }
        Console.Out.WriteLine("SET:" + n);
        Console.Out.Flush();
        return 0;
    }

    
    
    
    
    
    
    
    private static int RunAntiAfk(string[] args)
    {
        int deadlineSec = 18 * 60; 
        if (args.Length > 1) { int d; if (int.TryParse(args[1], out d)) deadlineSec = d; }
        if (deadlineSec < 60)   deadlineSec = 60;
        if (deadlineSec > 1140) deadlineSec = 1140; 

        
        
        int vk = 0x10;
        if (args.Length > 2) { int v; if (int.TryParse(args[2], out v) && v > 0 && v < 256) vk = v; }

        Console.Out.WriteLine("ANTIAFK_ON:" + deadlineSec);
        Console.Out.Flush();
        AntiAfk.RunLoop(deadlineSec, vk);
        return 0;
    }

    
    
    
    
    
    private static int RunSetRam(string[] args)
    {
        
        int bootstrapPid = 0, mb = 0;
        long sinceMs = 0;
        if (args.Length < 3 || !int.TryParse(args[1], out bootstrapPid) || !int.TryParse(args[2], out mb) || bootstrapPid <= 0 || mb <= 0)
        {
            Console.Error.WriteLine("setram: usage setram <bootstrapPid> <mb> [launchStartUnixMs]");
            return 2;
        }
        if (args.Length > 3) long.TryParse(args[3], out sinceMs);
        if (sinceMs <= 0) sinceMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        IntPtr hJob = IntPtr.Zero;
        IntPtr hProc = IntPtr.Zero;
        try
        {
            
            
            
            
            
            int targetPid = WaitForRobloxTarget(bootstrapPid, sinceMs, 90000);
            if (targetPid <= 0)
            {
                Console.Error.WriteLine("setram: Roblox client did not appear within the 90 second startup window");
                return 1;
            }

            hJob = CreateRamJob(mb);
            if (hJob == IntPtr.Zero) return 1;

            hProc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION, false, targetPid);
            if (hProc == IntPtr.Zero) { Console.Error.WriteLine("setram: OpenProcess failed " + Marshal.GetLastWin32Error()); return 1; }
            if (!AssignProcessToJobObject(hJob, hProc)) { Console.Error.WriteLine("setram: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error()); return 1; }
            ApplyWorkingSetLimit(hProc, mb);
            Console.Out.WriteLine("RAM_SET:" + targetPid + ":" + mb);
            Console.Out.Flush();
            
            
            
            
            
            
            CloseHandle(hProc);
            hProc = IntPtr.Zero;
            WatchRamLimit(hJob, targetPid, mb);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("setram: " + ex.Message);
            return 1;
        }
        finally
        {
            if (hProc != IntPtr.Zero) CloseHandle(hProc);
            
        }
    }

    
    
    
    private static int RunLaunchRam(string[] args)
    {
        
        int mb = 0;
        if (args.Length < 5 || !int.TryParse(args[3], out mb) || mb <= 0 || String.IsNullOrEmpty(args[1]) || String.IsNullOrEmpty(args[4]))
        {
            Console.Error.WriteLine("launchram: usage launchram <exe> <cwd> <mb> <uri>");
            return 2;
        }

        IntPtr hJob = CreateRamJob(mb);
        if (hJob == IntPtr.Zero) return 1;

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try
        {
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            
            
            char quote = (char)34;
            string command = quote + args[1] + quote + " " + quote + args[4] + quote;
            StringBuilder commandLine = new StringBuilder(command);
            bool created = CreateProcess(
                args[1], commandLine, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero,
                String.IsNullOrEmpty(args[2]) ? null : args[2], ref si, out pi);
            if (!created)
            {
                Console.Error.WriteLine("launchram: CreateProcess failed " + Marshal.GetLastWin32Error());
                CloseHandle(hJob);
                return 1;
            }

            if (!AssignProcessToJobObject(hJob, pi.hProcess))
            {
                Console.Error.WriteLine("launchram: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error());
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(hJob);
                return 1;
            }
            if (!ApplyWorkingSetLimit(pi.hProcess, mb))
            {
                Console.Error.WriteLine("launchram: could not apply the hard working-set limit");
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(hJob);
                return 1;
            }

            if (ResumeThread(pi.hThread) == UInt32.MaxValue)
            {
                Console.Error.WriteLine("launchram: ResumeThread failed " + Marshal.GetLastWin32Error());
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(hJob);
                return 1;
            }

            int pid = (int)pi.dwProcessId;
            Console.Out.WriteLine("RAM_SET:" + pid + ":" + mb);
            Console.Out.Flush();
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            
            
            WatchRamLimit(hJob, pid, mb);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("launchram: " + ex.Message);
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            CloseHandle(hJob);
            return 1;
        }
    }

    private static IntPtr CreateRamJob(int mb)
    {
        IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero)
        {
            Console.Error.WriteLine("ram: CreateJobObject failed " + Marshal.GetLastWin32Error());
            return IntPtr.Zero;
        }

        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        
        return hJob;
    }

    





















    private static bool ApplyWorkingSetLimit(IntPtr hProcess, int mb)
    {
        ulong bytes = (ulong)mb * 1024UL * 1024UL;
        
        
        
        UIntPtr minimum = (UIntPtr)(20UL * 4096UL);
        bool ok = SetProcessWorkingSetSizeEx(hProcess, minimum, (UIntPtr)bytes, QUOTA_LIMITS_HARDWS_MAX_ENABLE);
        if (!ok) Console.Error.WriteLine("ram: SetProcessWorkingSetSizeEx failed " + Marshal.GetLastWin32Error());
        return ok;
    }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    private static void WatchRamLimit(IntPtr hJob, int rootPid, int mb)
    {
        var tracked = new HashSet<int>();
        tracked.Add(rootPid);
        var parentMap = new Dictionary<int, int>(256);
        var dead = new List<int>();
        var fresh = new List<int>();
        int heartbeatMs = 1000;          
        ulong capBytes = (ulong)mb * 1024UL * 1024UL;
        ulong overshoot = capBytes + (capBytes / 8);   

        while (true)
        {
            try
            {
                
                parentMap.Clear();
                Process[] procs = null;
                try { procs = Process.GetProcesses(); } catch { procs = null; }
                if (procs != null)
                {
                    foreach (var pr in procs)
                    {
                        try { parentMap[pr.Id] = GetParentProcessId(pr.Id); } catch { }
                    }
                }

                
                
                
                fresh.Clear();
                foreach (var kv in parentMap)
                {
                    int pid = kv.Key;
                    if (tracked.Contains(pid) || pid == 0) continue;
                    int walker = kv.Value;
                    var seen = new HashSet<int>();
                    while (walker != 0 && seen.Add(walker))
                    {
                        if (tracked.Contains(walker)) { fresh.Add(pid); break; }
                        if (!parentMap.TryGetValue(walker, out walker)) break;
                    }
                }
                foreach (var pid in fresh)
                {
                    tracked.Add(pid);
                    try
                    {
                        IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION | PROCESS_TERMINATE, false, pid);
                        if (h == IntPtr.Zero) continue;
                        try
                        {
                            
                            
                            
                            AssignProcessToJobObject(hJob, h);
                            ApplyWorkingSetLimit(h, mb);
                            Console.Out.WriteLine("RAM_SET_CHILD:" + pid + ":" + mb);
                            Console.Out.Flush();
                        }
                        finally { CloseHandle(h); }
                    }
                    catch { }
                }

                
                
                
                
                
                dead.Clear();
                foreach (var pid in tracked)
                {
                    try
                    {
                        var pr = Process.GetProcessById(pid);
                        if (pr == null || pr.HasExited) { dead.Add(pid); continue; }
                        IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, false, pid);
                        if (h == IntPtr.Zero) { dead.Add(pid); continue; }
                        try
                        {
                            ApplyWorkingSetLimit(h, mb);
                            PROCESS_MEMORY_COUNTERS mc;
                            uint mcb = (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS));
                            if (GetProcessMemoryInfo(h, out mc, mcb))
                            {
                                ulong ws = (ulong)mc.WorkingSetSize;
                                if (ws > overshoot)
                                {
                                    
                                    
                                    
                                    try { EmptyWorkingSet64(h); }
                                    catch
                                    {
                                        try { EmptyWorkingSet(h); } catch { }
                                    }
                                }
                            }
                        }
                        finally { CloseHandle(h); }
                    }
                    catch { dead.Add(pid); }
                }
                foreach (var d in dead) tracked.Remove(d);
            }
            catch { }
            Thread.Sleep(heartbeatMs);
        }
    }

    private static int GetParentProcessId(int pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return 0;
        IntPtr buf = IntPtr.Zero;
        try
        {
            int size = Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION));
            buf = Marshal.AllocHGlobal(size);
            uint returned;
            int status = NtQueryInformationProcess(h, 0, buf, (uint)size, out returned);
            if (status != 0) return 0;
            var info = (PROCESS_BASIC_INFORMATION)Marshal.PtrToStructure(buf, typeof(PROCESS_BASIC_INFORMATION));
            return (int)info.InheritedFromUniqueProcessId;
        }
        catch { return 0; }
        finally
        {
            if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
            CloseHandle(h);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, IntPtr processInformation, uint processInformationLength, out uint returnLength);

    private static int WaitForRobloxTarget(int bootstrapPid, long sinceMs, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                Process bootstrap = null;
                try { bootstrap = Process.GetProcessById(bootstrapPid); } catch { }
                if (bootstrap != null)
                {
                    string name = "";
                    long startMs = 0;
                    try
                    {
                        name = bootstrap.ProcessName;
                        startMs = (long)(bootstrap.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    }
                    catch { }
                    
                    
                    
                    if (string.Equals(name, "RobloxPlayerBeta", StringComparison.OrdinalIgnoreCase) && startMs >= sinceMs - 2000)
                        return bootstrapPid;
                }

                int selected = 0;
                DateTime selectedStart = DateTime.MaxValue;
                foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
                {
                    try
                    {
                        DateTime start = p.StartTime.ToUniversalTime();
                        long startMs = (long)(start - new DateTime(1970, 1, 1)).TotalMilliseconds;
                        if (startMs >= sinceMs && start < selectedStart)
                        {
                            selected = p.Id;
                            selectedStart = start;
                        }
                    }
                    catch { }
                }
                if (selected > 0) return selected;
            }
            catch { }
            Thread.Sleep(500);
        }
        return 0;
    }

    const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    const int PROCESS_SET_QUOTA = 0x0100;
    const int PROCESS_TERMINATE = 0x0001;
    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public UIntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int dwDesiredAccess, bool bInheritHandle, int dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetProcessWorkingSetSizeEx(IntPtr hProcess, UIntPtr dwMinimumWorkingSetSize, UIntPtr dwMaximumWorkingSetSize, uint flags);
    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool EmptyWorkingSet(IntPtr hProcess);
    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool EmptyWorkingSet64(IntPtr hProcess);
    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool GetProcessMemoryInfo(IntPtr Process, out PROCESS_MEMORY_COUNTERS counters, uint size);

    
    
    
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_MEMORY_COUNTERS
    {
        public uint cb;
        public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
    }

    const uint QUOTA_LIMITS_HARDWS_MAX_ENABLE = 0x00000004;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(
        string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment,
        string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
}


internal static class HandleCloser
{
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int size, out int ret);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr srcHandle, IntPtr tgtProc, out IntPtr tgtHandle, int access, bool inherit, int opts);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int size, out int ret);

    const int SystemExtendedHandleInformation = 64;
    const int PROCESS_DUP_HANDLE = 0x0040;
    const int DUPLICATE_CLOSE_SOURCE = 0x1;
    const int DUPLICATE_SAME_ACCESS = 0x2;

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX
    {
        public IntPtr Object;
        public IntPtr UniqueProcessId;
        public IntPtr HandleValue;
        public int GrantedAccess;
        public short CreatorBackTraceIndex;
        public short ObjectTypeIndex;
        public int HandleAttributes;
        public int Reserved;
    }

    public static void CloseRobloxSingletonHandles()
    {
        var robloxPids = new System.Collections.Generic.HashSet<int>();
        foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
            robloxPids.Add(p.Id);
        if (robloxPids.Count == 0) return;

        int size = 1 << 20;
        IntPtr buf = IntPtr.Zero;
        int needed;
        try
        {
            while (true)
            {
                buf = Marshal.AllocHGlobal(size);
                int status = NtQuerySystemInformation(SystemExtendedHandleInformation, buf, size, out needed);
                if (status == 0) break;
                Marshal.FreeHGlobal(buf); buf = IntPtr.Zero;
                if (status == unchecked((int)0xC0000004)) { size *= 2; continue; } 
                return;
            }

            long count = Marshal.ReadInt64(buf);
            int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
            IntPtr entries = buf + IntPtr.Size * 2; 

            IntPtr self = GetCurrentProcess();

            for (long i = 0; i < count; i++)
            {
                var entry = (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(
                    entries + (int)(i * entrySize),
                    typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));

                int pid = (int)entry.UniqueProcessId;
                if (!robloxPids.Contains(pid)) continue;

                IntPtr srcProc = OpenProcess(PROCESS_DUP_HANDLE, false, pid);
                if (srcProc == IntPtr.Zero) continue;

                try
                {
                    IntPtr dupHandle;
                    if (!DuplicateHandle(srcProc, entry.HandleValue, self, out dupHandle, 0, false, DUPLICATE_SAME_ACCESS))
                        continue;

                    try
                    {
                        int nameBufSize = 1024;
                        IntPtr nameBuf = Marshal.AllocHGlobal(nameBufSize);
                        try
                        {
                            int nameRet;
                            NtQueryObject(dupHandle, 1, nameBuf, nameBufSize, out nameRet); 
                            short len = Marshal.ReadInt16(nameBuf);
                            if (len > 0)
                            {
                                IntPtr strPtr = Marshal.ReadIntPtr(nameBuf, IntPtr.Size == 8 ? 8 : 4);
                                string name = Marshal.PtrToStringUni(strPtr, len / 2);
                                if (name != null && name.Contains("ROBLOX_singletonEvent"))
                                {
                                    IntPtr dummy;
                                    DuplicateHandle(srcProc, entry.HandleValue, IntPtr.Zero, out dummy, 0, false, DUPLICATE_CLOSE_SOURCE);
                                    Console.Out.WriteLine("CLOSED:" + pid);
                                }
                            }
                        }
                        finally { Marshal.FreeHGlobal(nameBuf); }
                    }
                    finally { CloseHandle(dupHandle); }
                }
                finally { CloseHandle(srcProc); }
            }
        }
        finally
        {
            if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        }
    }
}


internal static class AudioControl
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        int NotUsed1();
        int NotUsed2();
        int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl session);
    }

    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(string value, ref Guid ctx);
        int GetIconPath(out IntPtr path);
        int SetIconPath(string value, ref Guid ctx);
        int GetGroupingParam(out Guid param);
        int SetGroupingParam(ref Guid over, ref Guid ctx);
        int RegisterAudioSessionNotification(IntPtr n);
        int UnregisterAudioSessionNotification(IntPtr n);
    }

    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        
        
        int R1(); int R2(); int R3(); int R4(); int R5();
        int R6(); int R7(); int R8(); int R9();
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out int pid);
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(bool mute, ref Guid eventContext);
        int GetMute(out bool mute);
    }

    const int eRender = 0;
    const int eConsole = 0;
    const int CLSCTX_ALL = 0x17;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")]
    static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")]
    static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    const uint TH32CS_SNAPPROCESS = 0x00000002;
    const int MAX_PATH = 260;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MAX_PATH)]
        public string szExeFile;
    }

    
    
    
    static int[] ExpandDescendants(int[] roots)
    {
        var ids = new HashSet<int>();
        foreach (int root in roots) if (root > 0) ids.Add(root);
        if (ids.Count == 0) return new int[0];

        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return new List<int>(ids).ToArray();
        try
        {
            bool changed;
            do
            {
                changed = false;
                var entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32First(snapshot, ref entry)) break;
                do
                {
                    if (entry.th32ProcessID > 0 && ids.Contains((int)entry.th32ParentProcessID) && ids.Add((int)entry.th32ProcessID))
                        changed = true;
                } while (Process32Next(snapshot, ref entry));
            } while (changed);
        }
        finally { CloseHandle(snapshot); }
        return new List<int>(ids).ToArray();
    }

    public static int Apply(float level, int[] pids)
    {
        pids = ExpandDescendants(pids);
        int changed = 0;
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device) != 0 || device == null)
            return 0;

        Guid IID_ISessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        object mgrObj;
        if (device.Activate(ref IID_ISessionManager2, CLSCTX_ALL, IntPtr.Zero, out mgrObj) != 0)
            return 0;
        var mgr = (IAudioSessionManager2)mgrObj;

        IAudioSessionEnumerator sessions;
        if (mgr.GetSessionEnumerator(out sessions) != 0) return 0;

        int count;
        sessions.GetCount(out count);
        Guid empty = Guid.Empty;

        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl ctl;
            if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
            var ctl2 = ctl as IAudioSessionControl2;
            if (ctl2 == null) continue;
            int pid;
            if (ctl2.GetProcessId(out pid) != 0) continue;
            bool match = false;
            foreach (int p in pids) { if (p == pid) { match = true; break; } }
            if (!match) continue;
            var vol = ctl as ISimpleAudioVolume;
            if (vol == null) continue;
            
            
            
            
            
            
            int volumeHr = vol.SetMasterVolume(level, ref empty);
            int muteHr = vol.SetMute(false, ref empty);
            if (volumeHr == 0 || muteHr == 0) changed++;
        }
        return changed;
    }
}










internal static class AntiAfk
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    const uint KEYEVENTF_KEYUP = 0x0002;

    static readonly Random _rng = new Random();

    
    static System.Collections.Generic.Dictionary<uint, IntPtr> EnumRobloxWindows()
    {
        var robloxPids = new System.Collections.Generic.HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
        {
            try { robloxPids.Add((uint)p.Id); } catch { }
        }
        var map = new System.Collections.Generic.Dictionary<uint, IntPtr>();
        if (robloxPids.Count == 0) return map;
        EnumWindows((hWnd, lp) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) == 0) return true; 
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            if (robloxPids.Contains(pid) && !map.ContainsKey(pid)) map[pid] = hWnd;
            return true;
        }, IntPtr.Zero);
        return map;
    }

    
    
    
    
    
    
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    const int SW_RESTORE = 9;

    static bool TapWindow(IntPtr hWnd, byte bVk, byte bScan)
    {
        IntPtr originalFg = GetForegroundWindow();
        bool needRestore = originalFg != IntPtr.Zero && originalFg != hWnd;
        try
        {
            if (originalFg != hWnd)
            {
                if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
                SetForegroundWindow(hWnd);
                Thread.Sleep(90 + _rng.Next(60)); 
            }
            Thread.Sleep(20 + _rng.Next(20));
            keybd_event(bVk, bScan, 0, IntPtr.Zero); 
            try
            {
                Thread.Sleep(35 + _rng.Next(40));
            }
            finally
            {
                
                keybd_event(bVk, bScan, KEYEVENTF_KEYUP, IntPtr.Zero); 
            }
            return true;
        }
        catch { return false; }
        finally
        {
            if (needRestore) { try { SetForegroundWindow(originalFg); } catch { } }
        }
    }

    
    
    
    
    public static void RunLoop(int deadlineSec, int vk)
    {
        
        
        
        byte bVk = (byte)vk;
        byte bScan = (byte)MapVirtualKey((uint)vk, 0);
        
        var lastReset = new System.Collections.Generic.Dictionary<uint, DateTime>();

        while (true)
        {
            Thread.Sleep(15 * 1000); 
            DateTime now = DateTime.UtcNow;

            
            
            IntPtr originalFg = GetForegroundWindow();

            var windows = EnumRobloxWindows();

            var gone = new System.Collections.Generic.List<uint>();
            foreach (var pid in lastReset.Keys) if (!windows.ContainsKey(pid)) gone.Add(pid);
            foreach (var pid in gone) lastReset.Remove(pid);
            foreach (var pid in windows.Keys) if (!lastReset.ContainsKey(pid)) lastReset[pid] = now;

            var due = new System.Collections.Generic.List<uint>();
            foreach (var kv in windows)
            {
                if ((now - lastReset[kv.Key]).TotalSeconds >= deadlineSec) due.Add(kv.Key);
            }
            if (due.Count == 0) continue;

            int tapped = 0;
            foreach (var pid in due)
            {
                if (TapWindow(windows[pid], bVk, bScan)) tapped++;
                lastReset[pid] = DateTime.UtcNow;
            }
            if (tapped > 0)
            {
                Console.Out.WriteLine("ANTIAFK_TICK:" + tapped);
                Console.Out.Flush();
            }
        }
    }

}
