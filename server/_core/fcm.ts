import { createSign } from "node:crypto";

type ServiceAccount = { client_email: string; private_key: string; project_id?: string };
type FcmMessage = {
  token: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
  android: {
    priority: "HIGH";
    notification: {
      channel_id: string;
      sound: string;
      default_sound: boolean;
      notification_priority: "PRIORITY_MAX";
      visibility: "PUBLIC";
    };
  };
};
export type FcmSendResult = { sent: number; invalidTokens: string[]; skipped: boolean };

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function getServiceAccount(): ServiceAccount | null {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (!parsed.client_email || !parsed.private_key) return null;
    return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, "\n"), project_id: parsed.project_id };
  } catch {
    return null;
  }
}

async function getAccessToken(account: ServiceAccount): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${base64Url(signer.sign(account.private_key))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  if (!response.ok) return null;
  const result = await response.json() as { access_token?: string; expires_in?: number };
  if (!result.access_token) return null;
  cachedToken = { value: result.access_token, expiresAt: Date.now() + (result.expires_in ?? 3600) * 1000 };
  return result.access_token;
}

function isInvalidToken(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /UNREGISTERED|INVALID_ARGUMENT|registration-token-not-registered|not a valid FCM registration token/i.test(body);
}

export async function sendFcmEmergency(tokens: string[], input: { title: string; body: string; alertId: string }): Promise<FcmSendResult> {
  const account = getServiceAccount();
  const projectId = process.env.FIREBASE_PROJECT_ID || account?.project_id;
  if (!account || !projectId || tokens.length === 0) return { sent: 0, invalidTokens: [], skipped: true };
  const accessToken = await getAccessToken(account);
  if (!accessToken) return { sent: 0, invalidTokens: [], skipped: true };
  const invalidTokens: string[] = [];
  let sent = 0;
  for (const token of [...new Set(tokens)]) {
    const message: FcmMessage = {
      token,
      notification: { title: input.title, body: input.body },
      data: { alertId: input.alertId, type: "emergency" },
      android: {
        priority: "HIGH",
        notification: {
          channel_id: "emergency-alerts",
          sound: "default",
          default_sound: true,
          notification_priority: "PRIORITY_MAX",
          visibility: "PUBLIC",
        },
      },
    };
    try {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
      const body = await response.text();
      if (response.ok) sent += 1;
      else if (isInvalidToken(response.status, body)) invalidTokens.push(token);
    } catch {
      // The persisted alert remains available in the security inbox for a later retry.
    }
  }
  return { sent, invalidTokens, skipped: false };
}
