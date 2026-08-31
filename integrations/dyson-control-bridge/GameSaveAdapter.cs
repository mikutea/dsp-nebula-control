using System;
using System.IO;
using System.Reflection;
using HarmonyLib;

namespace DysonControl.Bridge
{
    internal sealed class GameSaveAdapter
    {
        private readonly PropertyInfo nebulaInstalledProperty;
        private readonly PropertyInfo multiplayerActiveProperty;
        private readonly PropertyInfo multiplayerSessionProperty;
        private readonly PropertyInfo sessionIsDedicatedProperty;
        private readonly PropertyInfo sessionIsServerProperty;
        private readonly PropertyInfo sessionIsGameLoadedProperty;
        private readonly PropertyInfo sessionLocalPlayerProperty;
        private readonly PropertyInfo localPlayerIsHostProperty;
        private readonly FieldInfo gameSaveFolderField;
        private readonly FieldInfo lastExitField;
        private readonly FieldInfo saveExtensionField;
        private readonly MethodInfo saveCurrentGameMethod;
        private readonly PropertyInfo lastSaveTimeProperty;

        private GameSaveAdapter(
            PropertyInfo nebulaInstalledProperty,
            PropertyInfo multiplayerActiveProperty,
            PropertyInfo multiplayerSessionProperty,
            PropertyInfo sessionIsDedicatedProperty,
            PropertyInfo sessionIsServerProperty,
            PropertyInfo sessionIsGameLoadedProperty,
            PropertyInfo sessionLocalPlayerProperty,
            PropertyInfo localPlayerIsHostProperty,
            FieldInfo gameSaveFolderField,
            FieldInfo lastExitField,
            FieldInfo saveExtensionField,
            MethodInfo saveCurrentGameMethod,
            PropertyInfo lastSaveTimeProperty)
        {
            this.nebulaInstalledProperty = nebulaInstalledProperty;
            this.multiplayerActiveProperty = multiplayerActiveProperty;
            this.multiplayerSessionProperty = multiplayerSessionProperty;
            this.sessionIsDedicatedProperty = sessionIsDedicatedProperty;
            this.sessionIsServerProperty = sessionIsServerProperty;
            this.sessionIsGameLoadedProperty = sessionIsGameLoadedProperty;
            this.sessionLocalPlayerProperty = sessionLocalPlayerProperty;
            this.localPlayerIsHostProperty = localPlayerIsHostProperty;
            this.gameSaveFolderField = gameSaveFolderField;
            this.lastExitField = lastExitField;
            this.saveExtensionField = saveExtensionField;
            this.saveCurrentGameMethod = saveCurrentGameMethod;
            this.lastSaveTimeProperty = lastSaveTimeProperty;
        }

        internal static bool TryCreate(out GameSaveAdapter adapter, out string errorCode)
        {
            adapter = null;
            errorCode = "BRIDGE_INCOMPATIBLE";
            try
            {
                var apiType = AccessTools.TypeByName("NebulaAPI.NebulaModAPI");
                var sessionInterface = AccessTools.TypeByName("NebulaAPI.GameState.IMultiplayerSession");
                var localPlayerInterface = AccessTools.TypeByName("NebulaAPI.GameState.ILocalPlayer");
                var gameConfigType = AccessTools.TypeByName("GameConfig");
                var gameSaveType = AccessTools.TypeByName("GameSave");
                var gameStatesType = AccessTools.TypeByName("NebulaWorld.GameStates.GameStatesManager");
                if (apiType == null || sessionInterface == null || localPlayerInterface == null ||
                    gameConfigType == null || gameSaveType == null || gameStatesType == null)
                {
                    return false;
                }

                var candidate = new GameSaveAdapter(
                    AccessTools.Property(apiType, "NebulaIsInstalled"),
                    AccessTools.Property(apiType, "IsMultiplayerActive"),
                    AccessTools.Property(apiType, "MultiplayerSession"),
                    AccessTools.Property(sessionInterface, "IsDedicated"),
                    AccessTools.Property(sessionInterface, "IsServer"),
                    AccessTools.Property(sessionInterface, "IsGameLoaded"),
                    AccessTools.Property(sessionInterface, "LocalPlayer"),
                    AccessTools.Property(localPlayerInterface, "IsHost"),
                    AccessTools.Field(gameConfigType, "gameSaveFolder"),
                    AccessTools.Field(gameSaveType, "LastExit"),
                    AccessTools.Field(gameSaveType, "saveExt"),
                    AccessTools.Method(gameSaveType, "SaveCurrentGame", new[] { typeof(string) }),
                    AccessTools.Property(gameStatesType, "LastSaveTime"));

                if (!candidate.AllMembersResolved())
                {
                    return false;
                }
                adapter = candidate;
                errorCode = "NONE";
                return true;
            }
            catch
            {
                adapter = null;
                return false;
            }
        }

        internal bool TryPrepare(out SaveContext context, out string errorCode)
        {
            context = null;
            errorCode = "GAME_NOT_READY";
            try
            {
                if (!GetBoolean(nebulaInstalledProperty, null) || !GetBoolean(multiplayerActiveProperty, null))
                {
                    return false;
                }
                var session = multiplayerSessionProperty.GetValue(null, null);
                if (session == null || !GetBoolean(sessionIsDedicatedProperty, session) ||
                    !GetBoolean(sessionIsServerProperty, session))
                {
                    errorCode = "NOT_DEDICATED_HOST";
                    return false;
                }
                var localPlayer = sessionLocalPlayerProperty.GetValue(session, null);
                if (localPlayer == null || !GetBoolean(localPlayerIsHostProperty, localPlayer))
                {
                    errorCode = "NOT_DEDICATED_HOST";
                    return false;
                }
                if (!GetBoolean(sessionIsGameLoadedProperty, session))
                {
                    return false;
                }

                var saveFolder = gameSaveFolderField.GetValue(null) as string;
                var saveName = lastExitField.GetValue(null) as string;
                var saveExtension = saveExtensionField.GetValue(null) as string;
                if (string.IsNullOrWhiteSpace(saveFolder) ||
                    !string.Equals(saveName, BridgeProtocol.LastExitSaveName, StringComparison.Ordinal) ||
                    string.IsNullOrWhiteSpace(saveExtension) || !saveExtension.StartsWith(".", StringComparison.Ordinal))
                {
                    errorCode = "BRIDGE_INCOMPATIBLE";
                    return false;
                }
                var normalizedFolder = Path.GetFullPath(saveFolder).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
                var dsvPath = Path.GetFullPath(Path.Combine(normalizedFolder, saveName + saveExtension));
                var serverPath = Path.GetFullPath(Path.Combine(normalizedFolder, saveName + ".server"));
                if (!dsvPath.StartsWith(normalizedFolder, StringComparison.OrdinalIgnoreCase) ||
                    !serverPath.StartsWith(normalizedFolder, StringComparison.OrdinalIgnoreCase))
                {
                    errorCode = "BRIDGE_INCOMPATIBLE";
                    return false;
                }

                var prepared = new SaveContext
                {
                    SaveName = saveName,
                    DsvPath = dsvPath,
                    ServerPath = serverPath
                };
                var before = Observe(prepared);
                if (before.SaveTime < 0)
                {
                    errorCode = "SAVE_TIME_UNAVAILABLE";
                    return false;
                }
                prepared.BeforeObservation = before;
                prepared.SaveTimeBefore = before.SaveTime;
                context = prepared;
                errorCode = "NONE";
                return true;
            }
            catch
            {
                context = null;
                errorCode = "BRIDGE_INCOMPATIBLE";
                return false;
            }
        }

        internal bool TryInvokeSave(
            SaveContext context,
            out SaveObservation immediateObservation,
            out string errorCode)
        {
            immediateObservation = null;
            errorCode = "SAVE_CALL_FAILED";
            object result;
            try
            {
                result = saveCurrentGameMethod.Invoke(null, new object[] { context.SaveName });
            }
            catch
            {
                return false;
            }
            try
            {
                immediateObservation = Observe(context);
            }
            catch
            {
                immediateObservation = null;
                errorCode = "SAVE_OBSERVATION_FAILED";
                return false;
            }
            if (!(result is bool succeeded) || !succeeded)
            {
                return false;
            }
            if (!immediateObservation.PairPresent || immediateObservation.DsvBytes <= 0 ||
                immediateObservation.DsvWriteTimeUtcTicks <= 0 || immediateObservation.ServerBytes <= 0 ||
                immediateObservation.ServerWriteTimeUtcTicks <= 0)
            {
                errorCode = "SAVE_PAIR_MISSING";
                return false;
            }
            if (immediateObservation.SaveTime <= context.SaveTimeBefore)
            {
                errorCode = "SAVE_TIME_UNCHANGED";
                return false;
            }
            var dsvChanged = immediateObservation.DsvChangedFrom(context.BeforeObservation);
            var serverChanged = immediateObservation.ServerChangedFrom(context.BeforeObservation);
            if (!dsvChanged && !serverChanged)
            {
                errorCode = "SAVE_PAIR_UNCHANGED";
                return false;
            }
            if (!dsvChanged || !serverChanged)
            {
                errorCode = "SAVE_PAIR_PARTIAL";
                return false;
            }
            errorCode = "NONE";
            return true;
        }

        internal SaveObservation Observe(SaveContext context)
        {
            var dsv = new FileInfo(context.DsvPath);
            var server = new FileInfo(context.ServerPath);
            dsv.Refresh();
            server.Refresh();
            return new SaveObservation
            {
                PairPresent = dsv.Exists && server.Exists && dsv.Length > 0 && server.Length > 0,
                DsvBytes = dsv.Exists ? dsv.Length : -1,
                ServerBytes = server.Exists ? server.Length : -1,
                DsvWriteTimeUtcTicks = dsv.Exists ? dsv.LastWriteTimeUtc.Ticks : -1,
                ServerWriteTimeUtcTicks = server.Exists ? server.LastWriteTimeUtc.Ticks : -1,
                SaveTime = GetLastSaveTime()
            };
        }

        private long GetLastSaveTime()
        {
            var value = lastSaveTimeProperty.GetValue(null, null);
            return value is long parsed ? parsed : -1;
        }

        private bool AllMembersResolved()
        {
            return nebulaInstalledProperty != null && multiplayerActiveProperty != null &&
                   multiplayerSessionProperty != null && sessionIsDedicatedProperty != null &&
                   sessionIsServerProperty != null && sessionIsGameLoadedProperty != null &&
                   sessionLocalPlayerProperty != null && localPlayerIsHostProperty != null &&
                   gameSaveFolderField != null && lastExitField != null && saveExtensionField != null &&
                   saveCurrentGameMethod != null && saveCurrentGameMethod.ReturnType == typeof(bool) &&
                   lastSaveTimeProperty != null;
        }

        private static bool GetBoolean(PropertyInfo property, object instance)
        {
            var value = property.GetValue(instance, null);
            return value is bool result && result;
        }
    }

    internal sealed class SaveContext
    {
        internal string SaveName { get; set; }
        internal string DsvPath { get; set; }
        internal string ServerPath { get; set; }
        internal long SaveTimeBefore { get; set; }
        internal SaveObservation BeforeObservation { get; set; }
    }
}
