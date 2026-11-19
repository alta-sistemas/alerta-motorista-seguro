import AsyncStorage from "@react-native-async-storage/async-storage";
import { triggerRemoteAlert, type DeviceIdentity } from "@/lib/alert-api";

const QUEUE_KEY = "alerta.alert-queue.v1";
const MAX_QUEUE = 10;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

type QueuedAlert = {
  alertId: string;
  identity: DeviceIdentity;
  driverName: string;
  vehicle: { model: string; color: string; plate: string };
  location: { latitude: number; longitude: number } | null;
  locationSource: "current" | "last" | "none";
  capturedAt: string;
  attempts: number;
  nextAttemptAt: number;
};

async function readQueue(): Promise<QueuedAlert[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as QueuedAlert[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedAlert[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
}

export async function enqueueAlert(input: Omit<QueuedAlert, "attempts" | "nextAttemptAt">): Promise<void> {
  const queue = await readQueue();
  const withoutDuplicate = queue.filter((item) => item.alertId !== input.alertId);
  withoutDuplicate.push({ ...input, attempts: 0, nextAttemptAt: Date.now() });
  await writeQueue(withoutDuplicate);
}

export async function flushQueuedAlerts(): Promise<number> {
  const queue = await readQueue();
  const now = Date.now();
  let delivered = 0;
  const remaining: QueuedAlert[] = [];
  for (const item of queue) {
    if (item.nextAttemptAt > now) {
      remaining.push(item);
      continue;
    }
    try {
      await triggerRemoteAlert({ ...item, alertId: item.alertId });
      delivered += 1;
    } catch {
      const attempts = item.attempts + 1;
      const backoff = Math.min(MAX_BACKOFF_MS, 10_000 * 2 ** Math.min(attempts, 5));
      const jitter = Math.floor(Math.random() * 2000);
      remaining.push({ ...item, attempts, nextAttemptAt: now + backoff + jitter });
    }
  }
  await writeQueue(remaining);
  return delivered;
}
