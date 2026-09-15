using System;
using System.Diagnostics;
using System.Linq;
using System.Reflection;

namespace DysonControl.Bridge
{
    internal enum NebulaNoticeRuntimeState
    {
        Unverified = 0,
        Verified = 1
    }

    /// <summary>
    /// Binds the targeted notice mutation to the exact loaded Nebula assemblies and public primitives
    /// that were reviewed for Nebula v0.9.22. Any missing or changed identity fails closed without
    /// affecting the independent read-only roster publisher.
    /// </summary>
    internal static class NebulaNoticeRuntimeCompatibility
    {
        internal const string UnverifiedScope = "source-contract-only-runtime-unverified";
        internal const string VerifiedScope = "runtime-assembly-identity-verified";
        internal const string UnverifiedReasonCode = "NEBULA_NOTICE_RUNTIME_UNVERIFIED";
        internal const string VerifiedReasonCode = "UPSTREAM_TARGETED_NOTICE_PRIMITIVES_VERIFIED";

        internal const string ExpectedApiAssemblyName = "NebulaAPI";
        internal const string ExpectedApiAssemblyVersion = "2.1.0.0";
        internal const string ExpectedApiFileVersion = "2.1.0.7";
        internal const string ExpectedApiProductVersion = "2.1.0.7+924606f";
        internal const string ExpectedModelAssemblyName = "NebulaModel";
        internal const string ExpectedModelAssemblyVersion = "0.9.22.0";
        internal const string ExpectedModelFileVersion = "0.9.22.2";
        internal const string ExpectedModelProductVersion = "0.9.22.2+3cdf95c";

        internal static NebulaNoticeRuntimeState VerifyLoadedRuntime()
        {
            try
            {
                var loaded = AppDomain.CurrentDomain.GetAssemblies();
                var api = FindSingleAssembly(loaded, ExpectedApiAssemblyName);
                var model = FindSingleAssembly(loaded, ExpectedModelAssemblyName);
                if (api == null || model == null ||
                    !HasExpectedIdentity(
                        api,
                        ExpectedApiAssemblyName,
                        ExpectedApiAssemblyVersion,
                        ExpectedApiFileVersion,
                        ExpectedApiProductVersion) ||
                    !HasExpectedIdentity(
                        model,
                        ExpectedModelAssemblyName,
                        ExpectedModelAssemblyVersion,
                        ExpectedModelFileVersion,
                        ExpectedModelProductVersion))
                {
                    return NebulaNoticeRuntimeState.Unverified;
                }

                return HasTargetedNoticePrimitives(api, model)
                    ? NebulaNoticeRuntimeState.Verified
                    : NebulaNoticeRuntimeState.Unverified;
            }
            catch
            {
                return NebulaNoticeRuntimeState.Unverified;
            }
        }

        internal static string VerificationScope(NebulaNoticeRuntimeState state)
        {
            return state == NebulaNoticeRuntimeState.Verified ? VerifiedScope : UnverifiedScope;
        }

        internal static bool ActionsEnabled(NebulaNoticeRuntimeState state)
        {
            return state == NebulaNoticeRuntimeState.Verified;
        }

        internal static string NoticeAvailability(NebulaNoticeRuntimeState state)
        {
            return state == NebulaNoticeRuntimeState.Verified ? "available" : "unavailable";
        }

        internal static string NoticeReasonCode(NebulaNoticeRuntimeState state)
        {
            return state == NebulaNoticeRuntimeState.Verified ? VerifiedReasonCode : UnverifiedReasonCode;
        }

        internal static bool IsKnownState(NebulaNoticeRuntimeState state)
        {
            return state == NebulaNoticeRuntimeState.Unverified || state == NebulaNoticeRuntimeState.Verified;
        }

        private static Assembly FindSingleAssembly(Assembly[] loaded, string simpleName)
        {
            var matches = loaded
                .Where(assembly => string.Equals(
                    assembly.GetName().Name,
                    simpleName,
                    StringComparison.Ordinal))
                .Take(2)
                .ToArray();
            return matches.Length == 1 ? matches[0] : null;
        }

        private static bool HasExpectedIdentity(
            Assembly assembly,
            string expectedName,
            string expectedAssemblyVersion,
            string expectedFileVersion,
            string expectedProductVersion)
        {
            if (assembly == null || assembly.IsDynamic || string.IsNullOrWhiteSpace(assembly.Location))
            {
                return false;
            }

            var name = assembly.GetName();
            var publicKeyToken = name.GetPublicKeyToken();
            if (!string.Equals(name.Name, expectedName, StringComparison.Ordinal) ||
                !string.Equals(name.Version?.ToString(), expectedAssemblyVersion, StringComparison.Ordinal) ||
                !string.IsNullOrEmpty(name.CultureName) ||
                (publicKeyToken != null && publicKeyToken.Length != 0))
            {
                return false;
            }

            var version = FileVersionInfo.GetVersionInfo(assembly.Location);
            return string.Equals(version.FileVersion, expectedFileVersion, StringComparison.Ordinal) &&
                   string.Equals(version.ProductVersion, expectedProductVersion, StringComparison.Ordinal);
        }

        private static bool HasTargetedNoticePrimitives(Assembly api, Assembly model)
        {
            var multiplayerSession = api.GetType("NebulaAPI.GameState.IMultiplayerSession", false, false);
            var networkProvider = api.GetType("NebulaAPI.GameState.INetworkProvider", false, false);
            var player = api.GetType("NebulaAPI.GameState.INebulaPlayer", false, false);
            var playerData = api.GetType("NebulaAPI.GameState.IPlayerData", false, false);
            var playerCollection = api.GetType("NebulaAPI.DataStructures.ConcurrentPlayerCollection", false, false);
            var connection = api.GetType("NebulaAPI.Networking.INebulaConnection", false, false);
            var server = model.GetType("NebulaModel.Networking.IServer", false, false);
            var packet = model.GetType("NebulaModel.Packets.Chat.NewChatMessagePacket", false, false);
            var messageType = model.GetType("NebulaModel.DataStructures.Chat.ChatMessageType", false, false);

            if (multiplayerSession == null || networkProvider == null || player == null || playerData == null ||
                playerCollection == null || connection == null || server == null ||
                packet == null || messageType == null || !multiplayerSession.IsInterface ||
                !networkProvider.IsInterface || !player.IsInterface || !playerData.IsInterface ||
                !connection.IsInterface ||
                !server.IsInterface || !packet.IsClass || !messageType.IsEnum)
            {
                return false;
            }

            var networkProperty = multiplayerSession.GetProperty("Network", BindingFlags.Public | BindingFlags.Instance);
            var playersProperty = server.GetProperty("Players", BindingFlags.Public | BindingFlags.Instance);
            var connectedProperty = playerCollection.GetProperty("Connected", BindingFlags.Public | BindingFlags.Instance);
            var playerConnectionProperty = player.GetProperty("Connection", BindingFlags.Public | BindingFlags.Instance);
            var playerDataProperty = player.GetProperty("Data", BindingFlags.Public | BindingFlags.Instance);
            var connectionAliveProperty = connection.GetProperty("IsAlive", BindingFlags.Public | BindingFlags.Instance);
            if (networkProperty?.PropertyType != networkProvider ||
                !networkProvider.IsAssignableFrom(server) ||
                playersProperty?.PropertyType != playerCollection ||
                connectedProperty == null ||
                !IsConnectedPlayerDictionary(connectedProperty.PropertyType, connection, player) ||
                playerConnectionProperty?.PropertyType != connection ||
                playerDataProperty?.PropertyType != playerData ||
                connectionAliveProperty?.PropertyType != typeof(bool))
            {
                return false;
            }

            var sendPacket = player.GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(method => method.Name == "SendPacket" && method.IsGenericMethodDefinition)
                .ToArray();
            if (sendPacket.Length != 1 || !IsExpectedSendPacket(sendPacket[0]))
            {
                return false;
            }

            var constructor = packet.GetConstructor(new[] { messageType, typeof(string), typeof(DateTime), typeof(string) });
            var emptyConstructor = packet.GetConstructor(Type.EmptyTypes);
            var warningName = Enum.GetNames(messageType)
                .SingleOrDefault(name => string.Equals(name, "SystemWarnMessage", StringComparison.Ordinal));
            if (constructor == null || emptyConstructor == null || warningName == null)
            {
                return false;
            }

            return Convert.ToInt64(Enum.Parse(messageType, warningName)) == 2L;
        }

        private static bool IsConnectedPlayerDictionary(Type type, Type connection, Type player)
        {
            return type.IsGenericType &&
                   type.GetGenericTypeDefinition() == typeof(System.Collections.Generic.IReadOnlyDictionary<,>) &&
                   type.GetGenericArguments().SequenceEqual(new[] { connection, player });
        }

        private static bool IsExpectedSendPacket(MethodInfo method)
        {
            var genericArguments = method.GetGenericArguments();
            var parameters = method.GetParameters();
            if (genericArguments.Length != 1 || parameters.Length != 1 ||
                parameters[0].ParameterType != genericArguments[0] || method.ReturnType != typeof(void))
            {
                return false;
            }

            var required = GenericParameterAttributes.ReferenceTypeConstraint |
                           GenericParameterAttributes.DefaultConstructorConstraint;
            return (genericArguments[0].GenericParameterAttributes & required) == required;
        }
    }
}
