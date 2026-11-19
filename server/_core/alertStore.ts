import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  alertDevices,
  alertFcmTokens,
  alertLocations,
  alertPairCodes,
  alertPairings,
  alertRecords,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { hashDeviceToken } from "./device-auth";

export type AlertRole = "driver" | "security";
export type LocationSource = "current" | "last" | "none";
export type DeviceRecord = {
  deviceId: string;
  role: AlertRole;
  label: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
};
export type AlertRecord = {
  id: string;
  driverDeviceId: string;
  driverName: string;
  vehicle: { model: string; color: string; plate: string };
  latitude: number | null;
  longitude: number | null;
  locationSource: LocationSource;
  capturedAt: string;
  createdAt: number;
  updatedAt: number;
  status: "new" | "acknowledged" | "resolved";
  trackingActive: boolean;
};

type MemoryPairCode = {
  securityDeviceId: string;
  codeHash: string;
  expiresAt: number;
  usedAt: number | null;
  attempts: number;
};
type MemoryAlert = AlertRecord;

const memory = {
  devices: new Map<string, DeviceRecord>(),
  pairCodes: [] as MemoryPairCode[],
  pairings: new Set<string>(),
  alerts: new Map<string, MemoryAlert>(),
  locations: [] as Array<{ alertId: string; driverDeviceId: string; latitude: number; longitude: number; capturedAt: string; createdAt: number }>,
  fcmTokens: new Map<string, Set<string>>(),
};

let lastPruneAt = 0;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 5;

function now(): number {
  return Date.now();
}

function toMillis(value: Date | string | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
}

function createPairCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function pairKey(driverDeviceId: string, securityDeviceId: string): string {
  return `${driverDeviceId}:${securityDeviceId}`;
}

function memoryDevice(deviceId: string): DeviceRecord | undefined {
  return memory.devices.get(deviceId);
}

function mapDbDevice(row: typeof alertDevices.$inferSelect): DeviceRecord {
  return {
    deviceId: row.deviceId,
    role: row.role,
    label: row.label,
    tokenHash: row.tokenHash,
    createdAt: toMillis(row.createdAt),
    lastSeenAt: toMillis(row.lastSeenAt),
  };
}

function mapDbAlert(row: typeof alertRecords.$inferSelect): AlertRecord {
  return {
    id: row.alertId,
    driverDeviceId: row.driverDeviceId,
    driverName: row.driverName,
    vehicle: { model: row.vehicleModel, color: row.vehicleColor, plate: row.vehiclePlate },
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    locationSource: row.locationSource,
    capturedAt: row.capturedAt,
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
    status: row.status,
    trackingActive: Boolean(row.trackingActive),
  };
}

export async function getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
  const db = await getDb();
  if (!db) return memoryDevice(deviceId);
  const rows = await db.select().from(alertDevices).where(eq(alertDevices.deviceId, deviceId)).limit(1);
  return rows[0] ? mapDbDevice(rows[0]) : undefined;
}

export async function registerDevice(input: {
  deviceId: string;
  role: AlertRole;
  label: string;
  token: string;
  requestedPairCode?: string | null;
  pushToken?: string | null;
}): Promise<{ device: DeviceRecord; pairCode: string | null }> {
  const tokenHash = hashDeviceToken(input.token);
  const db = await getDb();
  if (!db) {
    const existing = memory.devices.get(input.deviceId);
    const device: DeviceRecord = existing ?? {
      deviceId: input.deviceId,
      role: input.role,
      label: input.label,
      tokenHash,
      createdAt: now(),
      lastSeenAt: now(),
    };
    device.role = input.role;
    device.label = input.label;
    device.lastSeenAt = now();
    memory.devices.set(device.deviceId, device);
    if (input.role === "security" && input.pushToken) {
      const tokens = memory.fcmTokens.get(input.deviceId) ?? new Set<string>();
      tokens.add(input.pushToken);
      memory.fcmTokens.set(input.deviceId, tokens);
    }
    const pairCode = input.role === "security" ? memoryRegisterPairCode(input.deviceId, input.requestedPairCode) : null;
    return { device, pairCode };
  }

  const existingRows = await db.select().from(alertDevices).where(eq(alertDevices.deviceId, input.deviceId)).limit(1);
  if (existingRows[0]) {
    await db.update(alertDevices).set({ role: input.role, label: input.label, lastSeenAt: new Date() }).where(eq(alertDevices.deviceId, input.deviceId));
  } else {
    await db.insert(alertDevices).values({ deviceId: input.deviceId, role: input.role, label: input.label, tokenHash });
  }
  const deviceRows = await db.select().from(alertDevices).where(eq(alertDevices.deviceId, input.deviceId)).limit(1);
  if (!deviceRows[0]) throw new Error("device-registration-failed");
  const device = mapDbDevice(deviceRows[0]);
  const pairCode = input.role === "security" ? await dbRegisterPairCode(input.deviceId, input.requestedPairCode) : null;
  if (input.role === "security" && input.pushToken) await upsertFcmToken(input.deviceId, input.pushToken);
  return { device, pairCode };
}

function memoryRegisterPairCode(securityDeviceId: string, requestedPairCode?: string | null): string {
  const active = memory.pairCodes
    .filter((item) => item.securityDeviceId === securityDeviceId && !item.usedAt && item.expiresAt > now() && item.attempts < MAX_PAIR_ATTEMPTS)
    .sort((a, b) => b.expiresAt - a.expiresAt)[0];
  if (active && requestedPairCode && hashDeviceToken(requestedPairCode) === active.codeHash) return requestedPairCode;
  const code = createPairCode();
  memory.pairCodes.push({ securityDeviceId, codeHash: hashDeviceToken(code), expiresAt: now() + PAIR_CODE_TTL_MS, usedAt: null, attempts: 0 });
  return code;
}

async function dbRegisterPairCode(securityDeviceId: string, requestedPairCode?: string | null): Promise<string> {
  const db = await getDb();
  if (!db) return memoryRegisterPairCode(securityDeviceId, requestedPairCode);
  const activeRows = await db.select().from(alertPairCodes).where(and(eq(alertPairCodes.securityDeviceId, securityDeviceId), isNull(alertPairCodes.usedAt), gt(alertPairCodes.expiresAt, new Date()), lt(alertPairCodes.attempts, MAX_PAIR_ATTEMPTS))).orderBy(desc(alertPairCodes.createdAt)).limit(1);
  const active = activeRows[0];
  if (active && requestedPairCode && hashDeviceToken(requestedPairCode) === active.codeHash) return requestedPairCode;
  const code = createPairCode();
  await db.insert(alertPairCodes).values({ securityDeviceId, codeHash: hashDeviceToken(code), expiresAt: new Date(now() + PAIR_CODE_TTL_MS), attempts: 0 });
  return code;
}

export async function verifyDevice(deviceId: string, token: string): Promise<DeviceRecord | undefined> {
  const device = await getDevice(deviceId);
  if (!device || !token || hashDeviceToken(token) !== device.tokenHash) return undefined;
  const db = await getDb();
  if (db) await db.update(alertDevices).set({ lastSeenAt: new Date() }).where(eq(alertDevices.deviceId, deviceId));
  else device.lastSeenAt = now();
  return device;
}

export async function upsertFcmToken(deviceId: string, token: string): Promise<void> {
  if (!token) return;
  const db = await getDb();
  if (!db) {
    const tokens = memory.fcmTokens.get(deviceId) ?? new Set<string>();
    tokens.add(token);
    memory.fcmTokens.set(deviceId, tokens);
    return;
  }
  await db.insert(alertFcmTokens).values({ deviceId, token }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
}

export async function getFcmTokens(deviceIds: string[]): Promise<string[]> {
  if (deviceIds.length === 0) return [];
  const db = await getDb();
  if (!db) return deviceIds.flatMap((deviceId) => [...(memory.fcmTokens.get(deviceId) ?? [])]);
  const rows = await db.select({ token: alertFcmTokens.token }).from(alertFcmTokens).where(inArray(alertFcmTokens.deviceId, deviceIds));
  return rows.map((row) => row.token);
}

export async function removeFcmTokens(tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  const db = await getDb();
  if (!db) {
    for (const token of tokens) for (const values of memory.fcmTokens.values()) values.delete(token);
    return;
  }
  await db.delete(alertFcmTokens).where(inArray(alertFcmTokens.token, tokens));
}

export async function createPairing(driverDeviceId: string, code: string): Promise<{ securityDeviceId: string; securityLabel: string }> {
  const codeHash = hashDeviceToken(code);
  const db = await getDb();
  if (!db) {
    const existing = [...memory.pairings].find((key) => key.startsWith(`${driverDeviceId}:`));
    const known = memory.pairCodes.find((item) => item.codeHash === codeHash && item.expiresAt > now() && !item.usedAt && item.attempts < MAX_PAIR_ATTEMPTS);
    if (!known) {
      for (const item of memory.pairCodes) if (item.codeHash === codeHash) item.attempts += 1;
      throw new Error("pair-code-invalid");
    }
    const security = memoryDevice(known.securityDeviceId);
    if (!security || security.role !== "security") throw new Error("pair-code-invalid");
    if (!existing && [...memory.pairings].filter((key) => key.startsWith(`${driverDeviceId}:`)).length >= 3) throw new Error("pairing-limit");
    known.usedAt = now();
    memory.pairings.add(pairKey(driverDeviceId, security.deviceId));
    return { securityDeviceId: security.deviceId, securityLabel: security.label };
  }

  const driverPairings = await db.select().from(alertPairings).where(eq(alertPairings.driverDeviceId, driverDeviceId));
  const codeRows = await db.select().from(alertPairCodes).where(eq(alertPairCodes.codeHash, codeHash)).orderBy(desc(alertPairCodes.createdAt)).limit(5);
  const active = codeRows.find((row) => !row.usedAt && row.expiresAt.getTime() > now() && row.attempts < MAX_PAIR_ATTEMPTS);
  if (!active) {
    if (codeRows[0]) await db.update(alertPairCodes).set({ attempts: sql`${alertPairCodes.attempts} + 1` }).where(eq(alertPairCodes.id, codeRows[0].id));
    throw new Error("pair-code-invalid");
  }
  const existing = driverPairings.find((row) => row.securityDeviceId === active.securityDeviceId);
  if (existing) return getSecuritySummary(active.securityDeviceId);
  if (driverPairings.length >= 3) throw new Error("pairing-limit");
  await db.update(alertPairCodes).set({ usedAt: new Date() }).where(eq(alertPairCodes.id, active.id));
  await db.insert(alertPairings).values({ driverDeviceId, securityDeviceId: active.securityDeviceId }).onDuplicateKeyUpdate({ set: { createdAt: new Date() } });
  return getSecuritySummary(active.securityDeviceId);
}

async function getSecuritySummary(securityDeviceId: string): Promise<{ securityDeviceId: string; securityLabel: string }> {
  const device = await getDevice(securityDeviceId);
  if (!device || device.role !== "security") throw new Error("security-not-found");
  return { securityDeviceId, securityLabel: device.label };
}

export async function getSecurityIdsForDriver(driverDeviceId: string): Promise<string[]> {
  const db = await getDb();
  if (!db) return [...memory.pairings].filter((key) => key.startsWith(`${driverDeviceId}:`)).map((key) => key.split(":")[1]);
  const rows = await db.select({ securityDeviceId: alertPairings.securityDeviceId }).from(alertPairings).where(eq(alertPairings.driverDeviceId, driverDeviceId));
  return rows.map((row) => row.securityDeviceId);
}

export async function createOrGetAlert(input: {
  id: string;
  driverDeviceId: string;
  driverName: string;
  vehicle: { model: string; color: string; plate: string };
  latitude: number | null;
  longitude: number | null;
  locationSource: LocationSource;
  capturedAt: string;
}): Promise<{ alert: AlertRecord; created: boolean }> {
  const db = await getDb();
  if (!db) {
    const existing = memory.alerts.get(input.id);
    if (existing) {
      if (existing.driverDeviceId !== input.driverDeviceId) throw new Error("alert-id-conflict");
      return { alert: existing, created: false };
    }
    const alert: AlertRecord = { id: input.id, driverDeviceId: input.driverDeviceId, driverName: input.driverName, vehicle: input.vehicle, latitude: input.latitude, longitude: input.longitude, locationSource: input.locationSource, capturedAt: input.capturedAt, createdAt: now(), updatedAt: now(), status: "new", trackingActive: true };
    memory.alerts.set(alert.id, alert);
    return { alert, created: true };
  }
  const existingRows = await db.select().from(alertRecords).where(eq(alertRecords.alertId, input.id)).limit(1);
  if (existingRows[0]) {
    if (existingRows[0].driverDeviceId !== input.driverDeviceId) throw new Error("alert-id-conflict");
    return { alert: mapDbAlert(existingRows[0]), created: false };
  }
  await db.insert(alertRecords).values({ alertId: input.id, driverDeviceId: input.driverDeviceId, driverName: input.driverName, vehicleModel: input.vehicle.model, vehicleColor: input.vehicle.color, vehiclePlate: input.vehicle.plate, latitude: input.latitude, longitude: input.longitude, locationSource: input.locationSource, capturedAt: input.capturedAt, status: "new", trackingActive: true });
  const rows = await db.select().from(alertRecords).where(eq(alertRecords.alertId, input.id)).limit(1);
  if (!rows[0]) throw new Error("alert-save-failed");
  void pruneRetention();
  return { alert: mapDbAlert(rows[0]), created: true };
}

export async function listAlertsForSecurity(securityDeviceId: string, since: number): Promise<AlertRecord[]> {
  const db = await getDb();
  if (!db) {
    const driverIds = [...memory.pairings].filter((key) => key.endsWith(`:${securityDeviceId}`)).map((key) => key.split(":")[0]);
    return [...memory.alerts.values()].filter((alert) => driverIds.includes(alert.driverDeviceId) && (alert.createdAt > since || alert.updatedAt > since)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
  }
  const pairingRows = await db.select({ driverDeviceId: alertPairings.driverDeviceId }).from(alertPairings).where(eq(alertPairings.securityDeviceId, securityDeviceId));
  const driverIds = pairingRows.map((row) => row.driverDeviceId);
  if (!driverIds.length) return [];
  const sinceDate = new Date(Math.max(0, since));
  const rows = await db.select().from(alertRecords).where(and(inArray(alertRecords.driverDeviceId, driverIds), or(gt(alertRecords.createdAt, sinceDate), gt(alertRecords.updatedAt, sinceDate)))).orderBy(desc(alertRecords.updatedAt)).limit(100);
  return rows.map(mapDbAlert);
}

export async function updateAlertLocation(input: { driverDeviceId: string; alertId: string; latitude: number; longitude: number; capturedAt: string }): Promise<AlertRecord | undefined> {
  const db = await getDb();
  if (!db) {
    const alert = memory.alerts.get(input.alertId);
    if (!alert || alert.driverDeviceId !== input.driverDeviceId) return undefined;
    alert.latitude = input.latitude;
    alert.longitude = input.longitude;
    alert.locationSource = "current";
    alert.capturedAt = input.capturedAt;
    alert.updatedAt = now();
    memory.locations.push({ alertId: input.alertId, driverDeviceId: input.driverDeviceId, latitude: input.latitude, longitude: input.longitude, capturedAt: input.capturedAt, createdAt: now() });
    return alert;
  }
  const existing = await db.select().from(alertRecords).where(and(eq(alertRecords.alertId, input.alertId), eq(alertRecords.driverDeviceId, input.driverDeviceId))).limit(1);
  if (!existing[0]) return undefined;
  await db.update(alertRecords).set({ latitude: input.latitude, longitude: input.longitude, locationSource: "current", capturedAt: input.capturedAt, updatedAt: new Date() }).where(eq(alertRecords.alertId, input.alertId));
  await db.insert(alertLocations).values({ alertId: input.alertId, driverDeviceId: input.driverDeviceId, latitude: input.latitude, longitude: input.longitude, capturedAt: input.capturedAt });
  const rows = await db.select().from(alertRecords).where(eq(alertRecords.alertId, input.alertId)).limit(1);
  return rows[0] ? mapDbAlert(rows[0]) : undefined;
}

export async function stopAlertTracking(driverDeviceId: string, alertId: string): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    const alert = memory.alerts.get(alertId);
    if (!alert || alert.driverDeviceId !== driverDeviceId) return false;
    alert.trackingActive = false;
    alert.updatedAt = now();
    return true;
  }
  const result = await db.update(alertRecords).set({ trackingActive: false, updatedAt: new Date() }).where(and(eq(alertRecords.alertId, alertId), eq(alertRecords.driverDeviceId, driverDeviceId)));
  return result[0].affectedRows > 0;
}

export async function acknowledgeAlert(securityDeviceId: string, alertId: string): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    const alert = memory.alerts.get(alertId);
    const allowed = alert && [...memory.pairings].includes(pairKey(alert.driverDeviceId, securityDeviceId));
    if (!allowed || !alert) return false;
    alert.status = "acknowledged";
    alert.updatedAt = now();
    return true;
  }
  const pairingRows = await db.select().from(alertPairings).where(eq(alertPairings.securityDeviceId, securityDeviceId));
  const driverIds = pairingRows.map((row) => row.driverDeviceId);
  if (!driverIds.length) return false;
  const result = await db.update(alertRecords).set({ status: "acknowledged", acknowledgedBy: securityDeviceId, acknowledgedAt: new Date(), updatedAt: new Date() }).where(and(eq(alertRecords.alertId, alertId), inArray(alertRecords.driverDeviceId, driverIds)));
  return result[0].affectedRows > 0;
}

export async function resolveAlert(securityDeviceId: string, alertId: string): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    const alert = memory.alerts.get(alertId);
    const allowed = alert && [...memory.pairings].includes(pairKey(alert.driverDeviceId, securityDeviceId));
    if (!allowed || !alert) return false;
    alert.status = "resolved";
    alert.trackingActive = false;
    alert.updatedAt = now();
    return true;
  }
  const pairingRows = await db.select().from(alertPairings).where(eq(alertPairings.securityDeviceId, securityDeviceId));
  const driverIds = pairingRows.map((row) => row.driverDeviceId);
  if (!driverIds.length) return false;
  const result = await db.update(alertRecords).set({ status: "resolved", trackingActive: false, acknowledgedBy: securityDeviceId, acknowledgedAt: new Date(), updatedAt: new Date() }).where(and(eq(alertRecords.alertId, alertId), inArray(alertRecords.driverDeviceId, driverIds)));
  return result[0].affectedRows > 0;
}

export async function pruneRetention(): Promise<void> {
  if (now() - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now();
  const retentionDays = Math.max(1, Number(process.env.ALERT_RETENTION_DAYS ?? 30) || 30);
  const cutoff = new Date(now() - retentionDays * 24 * 60 * 60 * 1000);
  const db = await getDb();
  if (!db) {
    for (const [id, alert] of memory.alerts) if (alert.createdAt < cutoff.getTime()) memory.alerts.delete(id);
    memory.locations = memory.locations.filter((location) => location.createdAt >= cutoff.getTime());
    memory.pairCodes.splice(0, memory.pairCodes.length, ...memory.pairCodes.filter((code) => code.expiresAt >= now() - PAIR_CODE_TTL_MS));
    return;
  }
  await db.delete(alertLocations).where(lt(alertLocations.createdAt, cutoff));
  await db.delete(alertRecords).where(lt(alertRecords.createdAt, cutoff));
  await db.delete(alertPairCodes).where(lt(alertPairCodes.expiresAt, cutoff));
}

export function generateAlertId(): string {
  return createId("alert");
}
