using System;
using System.IO;
using System.Linq;
using System.Text;

namespace DysonControl.Bridge
{
    internal sealed class BridgeFileStore
    {
        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false, true);
        private readonly string requestsRoot;
        private readonly string processingRoot;
        private readonly string receiptsRoot;
        private readonly string processedRoot;
        private readonly string rejectedRoot;
        private readonly string controlRoot;

        internal BridgeFileStore(string controlRoot, string secretFile)
        {
            if (string.IsNullOrWhiteSpace(controlRoot) || !Path.IsPathRooted(controlRoot))
            {
                throw new InvalidOperationException("ControlRoot must be an absolute non-root path.");
            }
            var normalizedRoot = Path.GetFullPath(controlRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (string.Equals(normalizedRoot, Path.GetPathRoot(normalizedRoot)?.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("ControlRoot cannot be a drive root.");
            }
            if (string.IsNullOrWhiteSpace(secretFile) || !Path.IsPathRooted(secretFile))
            {
                throw new InvalidOperationException("SecretFile must be an absolute path.");
            }

            Secret = File.ReadAllText(secretFile, Encoding.UTF8);
            if (!BridgeProtocol.TryValidateSecret(Secret, out var normalizedSecret))
            {
                throw new InvalidOperationException("Bridge secret is invalid.");
            }
            Secret = normalizedSecret;

            Directory.CreateDirectory(normalizedRoot);
            this.controlRoot = normalizedRoot;
            requestsRoot = CreateSafeDirectory(normalizedRoot, "requests");
            processingRoot = CreateSafeDirectory(normalizedRoot, "processing");
            receiptsRoot = CreateSafeDirectory(normalizedRoot, "receipts");
            processedRoot = CreateSafeDirectory(normalizedRoot, "processed");
            rejectedRoot = CreateSafeDirectory(normalizedRoot, "rejected");
            AssertNotReparsePoint(new DirectoryInfo(normalizedRoot));
        }

        internal string Secret { get; }

        internal void WriteHeartbeat(string pluginVersion, int processId, long startedAtUnixMs, long writtenAtUnixMs)
        {
            WriteAtomicFile("heartbeat", BridgeProtocol.SerializeHeartbeat(new BridgeHeartbeat
            {
                PluginVersion = pluginVersion,
                ProcessId = processId,
                StartedAtUnixMs = startedAtUnixMs,
                WrittenAtUnixMs = writtenAtUnixMs
            }, Secret));
        }

        internal void WritePlayerSnapshot(BridgePlayerSnapshot snapshot)
        {
            WriteAtomicFile("players", BridgeProtocol.SerializePlayerSnapshot(snapshot, Secret));
        }

        internal void WritePlayerCapabilities(BridgePlayerCapabilitySnapshot snapshot)
        {
            WriteAtomicFile("player-capabilities", BridgeProtocol.SerializePlayerCapabilities(snapshot, Secret));
        }

        internal BridgeClaim TryClaimNext()
        {
            var recovered = Directory.GetFiles(processingRoot, "*.request", SearchOption.TopDirectoryOnly)
                .OrderBy(path => File.GetCreationTimeUtc(path))
                .FirstOrDefault();
            if (recovered != null)
            {
                return new BridgeClaim(recovered, true);
            }

            foreach (var source in Directory.GetFiles(requestsRoot, "*.request", SearchOption.TopDirectoryOnly)
                         .OrderBy(path => File.GetCreationTimeUtc(path)).Take(8))
            {
                var sourceInfo = new FileInfo(source);
                if ((sourceInfo.Attributes & FileAttributes.ReparsePoint) != 0 || sourceInfo.Length > 4096)
                {
                    Reject(new BridgeClaim(source, false));
                    continue;
                }
                var destination = Path.Combine(processingRoot, sourceInfo.Name);
                try
                {
                    File.Move(source, destination);
                    return new BridgeClaim(destination, false);
                }
                catch (IOException)
                {
                    // Another bridge instance or a duplicate claim won this file.
                }
            }
            return null;
        }

        internal bool TryReadRequest(BridgeClaim claim, out BridgeRequest request, out string errorCode)
        {
            request = null;
            errorCode = "INVALID_REQUEST";
            try
            {
                var info = new FileInfo(claim.Path);
                if (!info.Exists || info.Length > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                {
                    return false;
                }
                var payloadBytes = File.ReadAllBytes(claim.Path);
                if (payloadBytes.Length == 0 || payloadBytes.Length > 4096 || HasUtf8Bom(payloadBytes))
                {
                    return false;
                }
                string payload;
                try
                {
                    payload = Utf8WithoutBom.GetString(payloadBytes);
                }
                catch (DecoderFallbackException)
                {
                    return false;
                }
                if (!BridgeProtocol.TryParseRequest(payload, Secret, out request, out errorCode))
                {
                    return false;
                }
                var expectedName = request.RequestId + ".request";
                if (!string.Equals(info.Name, expectedName, StringComparison.OrdinalIgnoreCase))
                {
                    request = null;
                    errorCode = "INVALID_REQUEST";
                    return false;
                }
                return true;
            }
            catch
            {
                request = null;
                errorCode = "REQUEST_IO_ERROR";
                return false;
            }
        }

        private static bool HasUtf8Bom(byte[] value)
        {
            return value.Length >= 3 && value[0] == 0xEF && value[1] == 0xBB && value[2] == 0xBF;
        }

        internal bool ReceiptExists(string requestId)
        {
            return File.Exists(GetReceiptPath(requestId));
        }

        internal void Complete(BridgeClaim claim, BridgeReceipt receipt)
        {
            var finalPath = GetReceiptPath(receipt.RequestId);
            if (!File.Exists(finalPath))
            {
                var temporaryPath = Path.Combine(receiptsRoot, ".partial-" + receipt.RequestId + "-" + Guid.NewGuid().ToString("N"));
                try
                {
                    File.WriteAllText(temporaryPath, BridgeProtocol.SerializeReceipt(receipt, Secret), Utf8WithoutBom);
                    File.Move(temporaryPath, finalPath);
                }
                finally
                {
                    if (File.Exists(temporaryPath))
                    {
                        File.Delete(temporaryPath);
                    }
                }
            }
            Archive(claim, processedRoot);
        }

        internal void Reject(BridgeClaim claim)
        {
            Archive(claim, rejectedRoot);
        }

        internal void ArchiveCompletedDuplicate(BridgeClaim claim)
        {
            Archive(claim, processedRoot);
        }

        private string GetReceiptPath(string requestId)
        {
            if (!Guid.TryParseExact(requestId, "D", out var parsed))
            {
                throw new InvalidOperationException("Receipt request ID is invalid.");
            }
            return Path.Combine(receiptsRoot, parsed.ToString("D").ToLowerInvariant() + ".receipt");
        }

        private static string CreateSafeDirectory(string root, string name)
        {
            var directory = Path.Combine(root, name);
            Directory.CreateDirectory(directory);
            AssertNotReparsePoint(new DirectoryInfo(directory));
            return directory;
        }

        private void WriteAtomicFile(string fileName, string payload)
        {
            var finalPath = Path.Combine(controlRoot, fileName);
            if (File.Exists(finalPath))
            {
                AssertNotReparsePoint(new FileInfo(finalPath));
            }
            var temporaryPath = Path.Combine(controlRoot, ".partial-" + fileName + "-" + Guid.NewGuid().ToString("N"));
            try
            {
                File.WriteAllText(temporaryPath, payload, Utf8WithoutBom);
                if (File.Exists(finalPath))
                {
                    File.Replace(temporaryPath, finalPath, null);
                }
                else
                {
                    File.Move(temporaryPath, finalPath);
                }
            }
            finally
            {
                if (File.Exists(temporaryPath))
                {
                    File.Delete(temporaryPath);
                }
            }
        }

        private static void AssertNotReparsePoint(FileSystemInfo info)
        {
            info.Refresh();
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException("Bridge directories cannot be reparse points.");
            }
        }

        private static void Archive(BridgeClaim claim, string destinationRoot)
        {
            if (!File.Exists(claim.Path))
            {
                return;
            }
            var fileName = Path.GetFileName(claim.Path);
            var destination = Path.Combine(destinationRoot, fileName);
            if (File.Exists(destination))
            {
                destination = Path.Combine(destinationRoot,
                    Path.GetFileNameWithoutExtension(fileName) + "-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ".request");
            }
            File.Move(claim.Path, destination);
        }
    }

    internal sealed class BridgeClaim
    {
        internal BridgeClaim(string path, bool recovered)
        {
            Path = path;
            Recovered = recovered;
        }

        internal string Path { get; }
        internal bool Recovered { get; }
    }
}
