import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { Linking, Platform } from "react-native";

export type EmergencyContact = {
  id: string;
  name: string;
  phone: string;
};

export type Vehicle = {
  model: string;
  color: string;
  plate: string;
};

export type DriverProfile = {
  vehicle: Vehicle;
  contacts: EmergencyContact[];
};

export type SavedLocation = {
  latitude: number;
  longitude: number;
  capturedAt: string;
};

export type LocationResult = {
  location: SavedLocation | null;
  permission: "granted" | "denied" | "unknown";
  source: "current" | "last" | "none";
};

export const PROFILE_STORAGE_KEY = "alerta.driver-profile.v1";
export const LAST_LOCATION_STORAGE_KEY = "alerta.last-location.v1";

export const EMPTY_PROFILE: DriverProfile = {
  vehicle: { model: "", color: "", plate: "" },
  contacts: [
    { id: "contact-1", name: "", phone: "" },
    { id: "contact-2", name: "", phone: "" },
    { id: "contact-3", name: "", phone: "" },
  ],
};

export function normalizeProfile(input: Partial<DriverProfile> | null | undefined): DriverProfile {
  const contacts = Array.isArray(input?.contacts) ? input.contacts : [];
  return {
    vehicle: {
      model: input?.vehicle?.model ?? "",
      color: input?.vehicle?.color ?? "",
      plate: input?.vehicle?.plate ?? "",
    },
    contacts: Array.from({ length: 3 }, (_, index) => {
      const source = contacts[index];
      return {
        id: source?.id ?? `contact-${index + 1}`,
        name: source?.name ?? "",
        phone: source?.phone ?? "",
      };
    }),
  };
}

export async function loadProfile(): Promise<DriverProfile> {
  try {
    const raw = await AsyncStorage.getItem(PROFILE_STORAGE_KEY);
    return normalizeProfile(raw ? JSON.parse(raw) : null);
  } catch {
    return EMPTY_PROFILE;
  }
}

export async function saveProfile(profile: DriverProfile): Promise<void> {
  await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalizeProfile(profile)));
}

export function getConfiguredContacts(profile: DriverProfile): EmergencyContact[] {
  return profile.contacts.filter((contact) => contact.name.trim() && contact.phone.trim());
}

export function isValidPhone(phone: string): boolean {
  return phone.replace(/\D/g, "").length >= 8;
}

export function getProfileReadiness(profile: DriverProfile): {
  contacts: number;
  hasVehicle: boolean;
  ready: boolean;
} {
  const contacts = getConfiguredContacts(profile).filter((contact) => isValidPhone(contact.phone)).length;
  const hasVehicle = Boolean(
    profile.vehicle.model.trim() && profile.vehicle.color.trim() && profile.vehicle.plate.trim(),
  );
  return { contacts, hasVehicle, ready: contacts > 0 && hasVehicle };
}

export async function loadLastLocation(): Promise<SavedLocation | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_LOCATION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedLocation) : null;
  } catch {
    return null;
  }
}

async function saveLastLocation(location: SavedLocation): Promise<void> {
  await AsyncStorage.setItem(LAST_LOCATION_STORAGE_KEY, JSON.stringify(location));
}

async function getCurrentPositionWithTimeout(): Promise<Location.LocationObject> {
  return Promise.race([
    Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
      mayShowUserSettingsDialog: true,
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("location-timeout")), 9000);
    }),
  ]);
}

export async function getBestAvailableLocation(): Promise<LocationResult> {
  const previous = await loadLastLocation();

  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== "granted") {
      return { location: previous, permission: "denied", source: previous ? "last" : "none" };
    }

    const current = await getCurrentPositionWithTimeout();
    const location: SavedLocation = {
      latitude: current.coords.latitude,
      longitude: current.coords.longitude,
      capturedAt: new Date().toISOString(),
    };
    try {
      await saveLastLocation(location);
    } catch {
      // A storage failure must not discard a freshly captured location.
    }
    return { location, permission: "granted", source: "current" };
  } catch {
    return { location: previous, permission: "unknown", source: previous ? "last" : "none" };
  }
}

function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

function formatVehicle(vehicle: Vehicle): string {
  const model = vehicle.model.trim() || "não informado";
  const color = vehicle.color.trim() || "não informada";
  const plate = vehicle.plate.trim().toUpperCase() || "não informada";
  return `${model}, ${color}, placa ${plate}`;
}

export function composeAlertMessage(
  profile: DriverProfile,
  location: SavedLocation | null,
  source: "current" | "last" | "none" = location ? "current" : "none",
): string {
  const capturedAt = location?.capturedAt ?? new Date().toISOString();
  const locationLine = location
    ? `${source === "last" ? "Última localização disponível" : "Localização atual"}: https://maps.google.com/?q=${location.latitude},${location.longitude}`
    : "Localização: indisponível no momento";
  return [
    "PEDIDO DE SOCORRO — motorista precisa de ajuda.",
    `Veículo: ${formatVehicle(profile.vehicle)}`,
    `Horário: ${formatTimestamp(capturedAt)}`,
    locationLine,
    "Se houver risco, chame a polícia (190) e compartilhe esta mensagem.",
  ].join("\n");
}

export async function openLocationSettings(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await Linking.openSettings();
  } catch {
    // The app can still be used with the last saved location.
  }
}
