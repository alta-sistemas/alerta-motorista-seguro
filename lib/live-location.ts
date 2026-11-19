import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { updateRemoteAlertLocation } from "@/lib/alert-api";
import type { DeviceIdentity } from "@/lib/alert-api";

export const LIVE_LOCATION_TASK = "alerta-live-location-task";
const ACTIVE_TRACKING_KEY = "alerta.active-tracking.v2";
type ActiveTracking = { alertId: string; identity: DeviceIdentity };

async function sendLocation(location: Location.LocationObject, active: ActiveTracking) {
  await updateRemoteAlertLocation({ identity: active.identity, alertId: active.alertId, latitude: location.coords.latitude, longitude: location.coords.longitude, capturedAt: new Date(location.timestamp).toISOString() });
}

if (!TaskManager.isTaskDefined(LIVE_LOCATION_TASK)) {
  TaskManager.defineTask(LIVE_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const activeRaw = await AsyncStorage.getItem(ACTIVE_TRACKING_KEY);
    if (!activeRaw) return;
    const active = JSON.parse(activeRaw) as ActiveTracking;
    const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
    for (const location of locations) {
      try {
        await sendLocation(location, active);
      } catch {
        // O próximo ponto tenta novamente sem registrar coordenadas ou tokens em logs.
      }
    }
  });
}

export async function startLiveLocationTracking(identity: DeviceIdentity, alertId: string): Promise<"started" | "permission-denied" | "unsupported"> {
  if (Platform.OS === "web") return "unsupported";
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== "granted") return "permission-denied";
  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== "granted") return "permission-denied";
  await AsyncStorage.setItem(ACTIVE_TRACKING_KEY, JSON.stringify({ alertId, identity } satisfies ActiveTracking));
  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK);
  if (!alreadyStarted) {
    await Location.startLocationUpdatesAsync(LIVE_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 5000,
      distanceInterval: 10,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: Platform.OS === "android" ? {
        notificationTitle: "Alerta compartilhando localização",
        notificationBody: "A central de segurança está acompanhando este alerta.",
        notificationColor: "#D49A3A",
      } : undefined,
    });
  }
  return "started";
}

export async function stopLiveLocationTracking(): Promise<void> {
  if (Platform.OS !== "web") {
    const started = await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK);
    if (started) await Location.stopLocationUpdatesAsync(LIVE_LOCATION_TASK);
  }
  await AsyncStorage.removeItem(ACTIVE_TRACKING_KEY);
}

export async function loadActiveTracking(): Promise<ActiveTracking | null> {
  const raw = await AsyncStorage.getItem(ACTIVE_TRACKING_KEY);
  return raw ? (JSON.parse(raw) as ActiveTracking) : null;
}
