import type { Express, Request, Response } from "express";
import { sendFcmEmergency } from "./fcm";
import { getDeviceToken } from "./device-auth";
import {
  acknowledgeAlert,
  createOrGetAlert,
  createPairing,
  getDevice,
  getFcmTokens,
  getSecurityIdsForDriver,
  listAlertsForSecurity,
  pruneRetention,
  registerDevice,
  removeFcmTokens,
  resolveAlert,
  stopAlertTracking,
  updateAlertLocation,
  upsertFcmToken,
  verifyDevice,
  type AlertRole,
  type AlertRecord,
  type LocationSource,
} from "./alertStore";

function stringValue(value: unknown, max = 180): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function jsonError(res: Response, status: number, message: string) {
  return res.status(status).json({ ok: false, error: message });
}

function validDeviceId(value: unknown): string {
  const deviceId = stringValue(value, 80);
  return /^[a-zA-Z0-9_.:-]{8,80}$/.test(deviceId) ? deviceId : "";
}

function validAlertId(value: unknown): string {
  const alertId = stringValue(value, 120);
  return /^[a-zA-Z0-9_.:-]{8,120}$/.test(alertId) ? alertId : "";
}

function validLocation(value: unknown): { latitude: number; longitude: number } | null {
  if (!value || typeof value !== "object") return null;
  const location = value as { latitude?: unknown; longitude?: unknown };
  if (typeof location.latitude !== "number" || typeof location.longitude !== "number") return null;
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  if (location.latitude < -90 || location.latitude > 90 || location.longitude < -180 || location.longitude > 180) return null;
  return { latitude: location.latitude, longitude: location.longitude };
}

function requestedRole(value: unknown): AlertRole | null {
  return value === "driver" || value === "security" ? value : null;
}

async function requireDevice(req: Request, res: Response, deviceId: string, role?: AlertRole) {
  const token = getDeviceToken(req);
  if (!token) {
    jsonError(res, 401, "Token do dispositivo ausente");
    return null;
  }
  const device = await verifyDevice(deviceId, token);
  if (!device || (role && device.role !== role)) {
    jsonError(res, 401, "Token do dispositivo inválido");
    return null;
  }
  return device;
}

function alertResponse(alert: AlertRecord) {
  return {
    id: alert.id,
    driverDeviceId: alert.driverDeviceId,
    driverName: alert.driverName,
    vehicle: alert.vehicle,
    latitude: alert.latitude,
    longitude: alert.longitude,
    locationSource: alert.locationSource,
    capturedAt: alert.capturedAt,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    status: alert.status,
    trackingActive: alert.trackingActive,
  };
}

export function registerAlertApi(app: Express) {
  app.post("/api/alert/register", async (req: Request, res: Response) => {
    const deviceId = validDeviceId(req.body?.deviceId);
    const role = requestedRole(req.body?.role);
    const label = stringValue(req.body?.label, 120) || (role === "security" ? "Pessoa de segurança" : "Motorista");
    const token = getDeviceToken(req);
    if (!deviceId || !role || !token) return jsonError(res, 400, "deviceId, role e token são obrigatórios");

    const existing = await getDevice(deviceId);
    if (existing && !(await verifyDevice(deviceId, token))) return jsonError(res, 401, "Token do dispositivo inválido");
    const registered = await registerDevice({ deviceId, role, label, token, requestedPairCode: stringValue(req.body?.pairCode, 6) || null, pushToken: stringValue(req.body?.pushToken, 512) || null });
    if (role === "security" && req.body?.pushToken) await upsertFcmToken(deviceId, stringValue(req.body.pushToken, 512));
    return res.json({ ok: true, deviceId: registered.device.deviceId, role: registered.device.role, pairCode: registered.pairCode, pairedDrivers: [] });
  });

  app.post("/api/alert/pair-code", async (req: Request, res: Response) => {
    const deviceId = validDeviceId(req.body?.deviceId);
    const device = deviceId ? await requireDevice(req, res, deviceId, "security") : null;
    if (!device) return;
    const token = getDeviceToken(req);
    if (!token) return jsonError(res, 401, "Token do dispositivo ausente");
    const result = await registerDevice({ deviceId, role: "security", label: device.label, token, requestedPairCode: null });
    return res.json({ ok: true, pairCode: result.pairCode });
  });

  app.post("/api/alert/pair", async (req: Request, res: Response) => {
    const driverDeviceId = validDeviceId(req.body?.driverDeviceId);
    const driver = driverDeviceId ? await requireDevice(req, res, driverDeviceId, "driver") : null;
    const code = stringValue(req.body?.code, 6);
    if (!driver) return;
    if (!/^\d{6}$/.test(code)) return jsonError(res, 400, "Código de pareamento inválido");
    try {
      const result = await createPairing(driverDeviceId, code);
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error && error.message === "pairing-limit" ? "O motorista já possui três centrais vinculadas" : "Código inválido, expirado ou já utilizado";
      return jsonError(res, 400, message);
    }
  });

  app.post("/api/alert/trigger", async (req: Request, res: Response) => {
    const driverDeviceId = validDeviceId(req.body?.driverDeviceId);
    const driver = driverDeviceId ? await requireDevice(req, res, driverDeviceId, "driver") : null;
    if (!driver) return;
    const alertId = validAlertId(req.body?.alertId);
    const location = req.body?.location === null ? null : validLocation(req.body?.location);
    const hasLocationPayload = req.body?.location !== null && req.body?.location !== undefined;
    const locationSource: LocationSource = req.body?.locationSource === "current" || req.body?.locationSource === "last" ? req.body.locationSource : "none";
    const vehicle = req.body?.vehicle;
    if (!alertId || !vehicle || typeof vehicle !== "object") return jsonError(res, 400, "alertId e veículo são obrigatórios");
    if (hasLocationPayload && !location) return jsonError(res, 400, "Localização inválida");
    const model = stringValue(vehicle.model, 100);
    const color = stringValue(vehicle.color, 60);
    const plate = stringValue(vehicle.plate, 30).toUpperCase();
    if (!model || !color || !plate) return jsonError(res, 400, "Modelo, cor e placa são obrigatórios");
    const capturedAt = stringValue(req.body?.capturedAt, 64) || new Date().toISOString();
    let result: Awaited<ReturnType<typeof createOrGetAlert>>;
    try {
      result = await createOrGetAlert({ id: alertId, driverDeviceId, driverName: stringValue(req.body?.driverName, 120) || driver.label, vehicle: { model, color, plate }, latitude: location?.latitude ?? null, longitude: location?.longitude ?? null, locationSource: location ? locationSource : "none", capturedAt });
    } catch (error) {
      if (error instanceof Error && error.message === "alert-id-conflict") return jsonError(res, 409, "alertId já pertence a outro dispositivo");
      throw error;
    }
    const securityIds = await getSecurityIdsForDriver(driverDeviceId);
    if (result.created && securityIds.length) {
      const tokens = await getFcmTokens(securityIds);
      const pushResult = await sendFcmEmergency(tokens, { title: "ALERTA DE EMERGÊNCIA", body: `${result.alert.driverName} pediu ajuda. Toque para abrir a central.`, alertId: result.alert.id });
      if (pushResult.invalidTokens.length) await removeFcmTokens(pushResult.invalidTokens);
    }
    void pruneRetention();
    return res.json({ ok: true, alertId: result.alert.id, deliveredTo: securityIds.length, alert: alertResponse(result.alert) });
  });

  app.post("/api/alert/location", async (req: Request, res: Response) => {
    const driverDeviceId = validDeviceId(req.body?.driverDeviceId);
    const driver = driverDeviceId ? await requireDevice(req, res, driverDeviceId, "driver") : null;
    const location = validLocation({ latitude: req.body?.latitude, longitude: req.body?.longitude });
    const alertId = validAlertId(req.body?.alertId);
    if (!driver) return;
    if (!location || !alertId) return jsonError(res, 400, "alertId e localização são obrigatórios");
    const alert = await updateAlertLocation({ driverDeviceId, alertId, latitude: location.latitude, longitude: location.longitude, capturedAt: stringValue(req.body?.capturedAt, 64) || new Date().toISOString() });
    return alert ? res.json({ ok: true, alert: alertResponse(alert) }) : jsonError(res, 404, "Alerta não encontrado");
  });

  app.post("/api/alert/stop-tracking", async (req: Request, res: Response) => {
    const driverDeviceId = validDeviceId(req.body?.driverDeviceId);
    const driver = driverDeviceId ? await requireDevice(req, res, driverDeviceId, "driver") : null;
    const alertId = validAlertId(req.body?.alertId);
    if (!driver) return;
    if (!alertId) return jsonError(res, 400, "alertId é obrigatório");
    const stopped = await stopAlertTracking(driverDeviceId, alertId);
    return stopped ? res.json({ ok: true }) : jsonError(res, 404, "Alerta não encontrado");
  });

  app.get("/api/alert/inbox", async (req: Request, res: Response) => {
    const deviceId = validDeviceId(req.query.deviceId);
    const device = deviceId ? await requireDevice(req, res, deviceId, "security") : null;
    if (!device) return;
    const since = Math.max(0, Number(req.query.since ?? 0) || 0);
    const alerts = await listAlertsForSecurity(deviceId, since);
    return res.json({ ok: true, alerts: alerts.map(alertResponse) });
  });

  app.post("/api/alert/acknowledge", async (req: Request, res: Response) => {
    const deviceId = validDeviceId(req.body?.deviceId);
    const device = deviceId ? await requireDevice(req, res, deviceId, "security") : null;
    const alertId = validAlertId(req.body?.alertId);
    if (!device) return;
    if (!alertId) return jsonError(res, 400, "alertId é obrigatório");
    const acknowledged = await acknowledgeAlert(deviceId, alertId);
    return acknowledged ? res.json({ ok: true }) : jsonError(res, 404, "Alerta não encontrado");
  });

  app.post("/api/alert/resolve", async (req: Request, res: Response) => {
    const deviceId = validDeviceId(req.body?.deviceId);
    const device = deviceId ? await requireDevice(req, res, deviceId, "security") : null;
    const alertId = validAlertId(req.body?.alertId);
    if (!device) return;
    if (!alertId) return jsonError(res, 400, "alertId é obrigatório");
    const resolved = await resolveAlert(deviceId, alertId);
    return resolved ? res.json({ ok: true }) : jsonError(res, 404, "Alerta não encontrado");
  });
}
