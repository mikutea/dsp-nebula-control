# Read-only primitive. Callers must independently prove stopped state and bind
# the result to the completed stop intent; these hashes alone grant no authority.
if (-not ('Dyson.StoppedSaveCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace Dyson {
  public sealed class StoppedSaveFile {
    public long Bytes;
    public string Sha256;
  }
  public sealed class StoppedSavePair {
    public StoppedSaveFile Dsv;
    public StoppedSaveFile Server;
  }
  public static class StoppedSaveCapture {
    [StructLayout(LayoutKind.Sequential)] struct Info {
      public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
        WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    static string Normalize(string path) {
      if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path.Substring(8);
      else if (path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) path = path.Substring(4);
      return Path.GetFullPath(path);
    }
    static void PlainDirectory(string path) {
      for (DirectoryInfo dir = new DirectoryInfo(path); dir != null; dir = dir.Parent) {
        dir.Refresh();
        if (!dir.Exists || (dir.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("directory");
      }
    }
    static Info Identity(FileStream stream, string expected) {
      Info info;
      if (!GetFileInformationByHandle(stream.SafeFileHandle, out info) || info.Links != 1 ||
          (info.Attributes & 0x410) != 0 || (info.SizeHigh == 0 && info.SizeLow == 0)) throw new IOException("identity");
      var path = new StringBuilder(32768);
      uint count = GetFinalPathNameByHandle(stream.SafeFileHandle, path, (uint)path.Capacity, 0);
      if (count == 0 || count >= path.Capacity || !String.Equals(Normalize(path.ToString()), Normalize(expected),
          StringComparison.OrdinalIgnoreCase)) throw new IOException("path");
      return info;
    }
    static bool Same(Info a, Info b) {
      return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow &&
        a.SizeHigh == b.SizeHigh && a.SizeLow == b.SizeLow && a.WriteHigh == b.WriteHigh && a.WriteLow == b.WriteLow;
    }
    static StoppedSaveFile Hash(FileStream stream) {
      using (var hash = SHA256.Create()) return new StoppedSaveFile {
        Bytes = stream.Length, Sha256 = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant()
      };
    }
    public static StoppedSavePair Capture(string projectRoot) {
      string root = Path.GetFullPath(projectRoot);
      string directory = Path.Combine(root, "userdata", "Save");
      PlainDirectory(directory);
      string dsv = Path.Combine(directory, "_lastexit_.dsv");
      string server = Path.Combine(directory, "_lastexit_.server");
      using (var left = new FileStream(dsv, FileMode.Open, FileAccess.Read, FileShare.Read))
      using (var right = new FileStream(server, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        Info beforeLeft = Identity(left, dsv), beforeRight = Identity(right, server);
        var result = new StoppedSavePair { Dsv = Hash(left), Server = Hash(right) };
        PlainDirectory(directory);
        if (!Same(beforeLeft, Identity(left, dsv)) || !Same(beforeRight, Identity(right, server)))
          throw new IOException("changed");
        return result;
      }
    }
  }
}
'@
}

function Get-DysonStoppedSavePair {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    try {
        $pair = [Dyson.StoppedSaveCapture]::Capture($ProjectRoot)
        return [ordered]@{
            saveName = '_lastexit_'
            dsvBytes = $pair.Dsv.Bytes
            dsvSha256 = $pair.Dsv.Sha256
            serverBytes = $pair.Server.Bytes
            serverSha256 = $pair.Server.Sha256
        }
    }
    catch { throw 'BOOTSTRAP_STOPPED_SAVE_CAPTURE_INVALID' }
}
