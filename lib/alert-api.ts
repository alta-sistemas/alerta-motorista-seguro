import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import * as IntentLauncher from "expo-intent-launcher";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { apiCall } from "@/lib/_core/api";
import { getApiBaseUrl } from "@/constants/oauth";

export type AlertRole = "driver" | "security";
export type DeviceIdentity = { deviceId: string; role: AlertRole; label: string; deviceToken: string; pairCode?: string | null; pushToken?: string | null };
export type RemoteAlert = {
  id: string;
  driverDeviceId: string;
  driverName: string;
  vehicle: { model: string; color: string; plate: string };
  latitude: number | null;
  longitude: number | null;
  locationSource: "current" | "last" | "none";
  capturedAt: string;
  createdAt: number;
  updatedAt: number;
  status: "new" | "acknowledged" | "resolved";
  trackingActive: boolean;
};

const DEVICE_KEY_PREFIX = "alerta.device.identity.v4";
const TOKEN_KEY_PREFIX = "alerta.device.token.v1";

function createDeviceId(): string {
  return `device_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createClientAlertId(): string {
  return `alert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function deviceKey(role: AlertRole): string {
  return `${DEVICE_KEY_PREFIX}.${role}`;
}

function tokenKey(role: AlertRole): string {
  return `${TOKEN_KEY_PREFIX}.${role}`;
}

async function loadToken(role: AlertRole): Promise<string | null> {
  try {
    if (Platform.OS !== "web") return await SecureStore.getItemAsync(tokenKey(role));
    return await AsyncStorage.getItem(tokenKey(role));
  } catch {
    return await AsyncStorage.getItem(tokenKey(role));
  }
}

async function saveToken(role: AlertRole, token: string): Promise<void> {
  try {
    if (Platform.OS !== "web") {
      await SecureStore.setItemAsync(tokenKey(role), token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      return;
    }
  } catch {
    // Fall back to AsyncStorage on devices without a usable secure store.
  }
  await AsyncStorage.setItem(tokenKey(role), token);
}

async function saveIdentity(identity: DeviceIdentity): Promise<void> {
  const { deviceToken: _deviceToken, ...publicIdentity } = identity;
  await AsyncStorage.setItem(deviceKey(identity.role), JSON.stringify(publicIdentity));
}

function authHeaders(identity: DeviceIdentity): Record<string, string> {
  return { "X-Device-Token": identity.deviceToken };
}

export async function loadIdentity(role: AlertRole, label: string): Promise<DeviceIdentity> {
  const raw = await AsyncStorage.getItem(deviceKey(role));
  const stored = raw ? (JSON.parse(raw) as Partial<DeviceIdentity>) : null;
  const storedToken = await loadToken(role);
  const deviceToken = storedToken ?? `dt_${createClientAlertId()}_${Math.random().toString(36).slice(2)}`;
  const identity: DeviceIdentity = {
    deviceId: stored?.deviceId ?? createDeviceId(),
    role,
    label: label.trim() || (role === "security" ? "Pessoa de segurança" : "Motorista"),
    deviceToken,
    pairCode: role === "security" ? stored?.pairCode ?? null : null,
    pushToken: role === "security" ? stored?.pushToken ?? null : null,
  };
  await saveToken(role, deviceToken);
  await saveIdentity(identity);
  return identity;
}

export async function registerDevice(identity: DeviceIdentity): Promise<DeviceIdentity> {
  const result = await apiCall<DeviceIdentity & { ok: boolean; pairedDrivers?: string[] }>("/api/alert/register", {
    method: "POST",
    headers: authHeaders(identity),
    body: JSON.stringify({ deviceId: identity.deviceId, role: identity.role, label: identity.label, pairCode: identity.pairCode ?? null, pushToken: identity.pushToken ?? null }),
  });
  const updated = { ...identity, pairCode: result.pairCode ?? identity.pairCode ?? null };
  await saveIdentity(updated);
  return updated;
}

export async function issueSecurityPairCode(identity: DeviceIdentity): Promise<DeviceIdentity> {
  const result = await apiCall<{ pairCode: string }>("/api/alert/pair-code", { method: "POST", headers: authHeaders(identity), body: JSON.stringify({ deviceId: identity.deviceId }) });
  const updated = { ...identity, pairCode: result.pairCode };
  await saveIdentity(updated);
  return updated;
}

export async function getSecurityPushToken(): Promise<string | null> {
  if (Platform.OS === "web") return null;
  await Notifications.setNotificationChannelAsync("emergency-alerts", {
    name: "Alertas de emergência",
    description: "Pedidos de socorro dos motoristas pareados",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250, 250],
    sound: "default",
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  const permission = await Notifications.getPermissionsAsync();
  const finalStatus = permission.status === "granted" ? permission.status : (await Notifications.requestPermissionsAsync()).status;
  if (finalStatus !== "granted") return null;
  const nativeToken = await Notifications.getDevicePushTokenAsync();
  return nativeToken.type === "fcm" && typeof nativeToken.data === "string" ? nativeToken.data : null;
}

export async function openOverlayPermission(): Promise<void> {
  if (Platform.OS !== "android" || !Application.applicationId) return;
  await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_OVERLAY_PERMISSION, { data: `package:${Application.applicationId}` });
}

export function getOverlayConfig(identity: DeviceIdentity, vehicle: { model: string; color: string; plate: string }, driverName: string) {
  return { apiBaseUrl: getApiBaseUrl(), deviceId: identity.deviceId, deviceToken: identity.deviceToken, driverName, vehicle };
}

export async function pairDriver(identity: DeviceIdentity, code: string): Promise<void> {
  await apiCall("/api/alert/pair", { method: "POST", headers: authHeaders(identity), body: JSON.stringify({ driverDeviceId: identity.deviceId, code: code.trim() }) });
}

export async function triggerRemoteAlert(input: {
  identity: DeviceIdentity;
  driverName: string;
  vehicle: { model: string; color: string; plate: string };
  location: { latitude: number; longitude: number } | null;
  locationSource: "current" | "last" | "none";
  capturedAt: string;
  alertId?: string;
}): Promise<{ alertId: string; deliveredTo: number; alert?: RemoteAlert }> {
  const alertId = input.alertId ?? createClientAlertId();
  return apiCall("/api/alert/trigger", { method: "POST", headers: authHeaders(input.identity), body: JSON.stringify({ alertId, driverDeviceId: input.identity.deviceId, driverName: input.driverName, vehicle: input.vehicle, location: input.location, locationSource: input.locationSource, capturedAt: input.capturedAt }) });
}

export async function updateRemoteAlertLocation(input: { identity: DeviceIdentity; alertId: string; latitude: number; longitude: number; capturedAt: string }): Promise<void> {
  await apiCall("/api/alert/location", { method: "POST", headers: authHeaders(input.identity), body: JSON.stringify({ driverDeviceId: input.identity.deviceId, alertId: input.alertId, latitude: input.latitude, longitude: input.longitude, capturedAt: input.capturedAt }) });
}

export async function stopRemoteAlertTracking(identity: DeviceIdentity, alertId: string): Promise<void> {
  await apiCall("/api/alert/stop-tracking", { method: "POST", headers: authHeaders(identity), body: JSON.stringify({ driverDeviceId: identity.deviceId, alertId }) });
}

export async function fetchInbox(identity: DeviceIdentity, since: number): Promise<RemoteAlert[]> {
  const result = await apiCall<{ alerts: RemoteAlert[] }>(`/api/alert/inbox?deviceId=${encodeURIComponent(identity.deviceId)}&since=${Math.max(0, since)}`, { headers: authHeaders(identity) });
  return result.alerts ?? [];
}

export async function acknowledgeAlert(identity: DeviceIdentity, alertId: string): Promise<void> {
  await apiCall("/api/alert/acknowledge", { method: "POST", headers: authHeaders(identity), body: JSON.stringify({ deviceId: identity.deviceId, alertId }) });
}

export async function resolveAlert(identity: DeviceIdentity, alertId: string): Promise<void> {
  await apiCall("/api/alert/resolve", { method: "POST", headers: authHeaders(identity), body: JSON.stringify({ deviceId: identity.deviceId, alertId }) });
}
