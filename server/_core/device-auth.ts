import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export function createDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokensMatch(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashDeviceToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getDeviceToken(request: Request): string | null {
  const authorization = request.header("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  const headerToken = request.header("x-device-token")?.trim();
  return headerToken || null;
}
