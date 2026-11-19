import { requireOptionalNativeModule } from "expo-modules-core";

export type OverlayConfig = {
  apiBaseUrl: string;
  deviceId: string;
  deviceToken: string;
  driverName: string;
  vehicle: { model: string; color: string; plate: string };
};

interface OdinOverlayNativeModule {
  isSupported(): boolean;
  hasPermission(): boolean;
  configure(configJson: string): boolean;
  start(): boolean;
  stop(): boolean;
  stopTracking(): boolean;
  consumePendingTrigger(): boolean;
}

const Native = requireOptionalNativeModule<OdinOverlayNativeModule>("OdinOverlay");

export function overlaySupported(): boolean {
  return Boolean(Native?.isSupported());
}

export function overlayHasPermission(): boolean {
  return Boolean(Native?.hasPermission());
}

export function configureOdinOverlay(config: OverlayConfig): boolean {
  return Boolean(Native?.configure(JSON.stringify(config)));
}

export function startOdinOverlay(): boolean {
  return Boolean(Native?.start());
}

export function stopOdinOverlay(): boolean {
  return Boolean(Native?.stop());
}

export function stopOdinOverlayTracking(): boolean {
  return Boolean(Native?.stopTracking());
}

export function consumeOdinOverlayTrigger(): boolean {
  return Boolean(Native?.consumePendingTrigger());
}
