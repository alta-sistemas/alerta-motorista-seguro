import { boolean, double, index, int, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/** Core user table backing the optional Manus auth flow. */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/** One row per installed driver/security identity. Only the SHA-256 token hash is stored. */
export const alertDevices = mysqlTable(
  "alert_devices",
  {
    deviceId: varchar("deviceId", { length: 80 }).primaryKey(),
    role: mysqlEnum("role", ["driver", "security"]).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
  },
  (table) => [index("alert_devices_role_idx").on(table.role)],
);

/** FCM device tokens are separate so token rotation and invalid-token cleanup are safe. */
export const alertFcmTokens = mysqlTable(
  "alert_fcm_tokens",
  {
    id: int("id").autoincrement().primaryKey(),
    deviceId: varchar("deviceId", { length: 80 }).notNull(),
    token: varchar("token", { length: 512 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("alert_fcm_tokens_device_token_uq").on(table.deviceId, table.token),
    index("alert_fcm_tokens_device_idx").on(table.deviceId),
  ],
);

/** Short-lived pairing codes. The plaintext code is returned only to the security app. */
export const alertPairCodes = mysqlTable(
  "alert_pair_codes",
  {
    id: int("id").autoincrement().primaryKey(),
    securityDeviceId: varchar("securityDeviceId", { length: 80 }).notNull(),
    codeHash: varchar("codeHash", { length: 64 }).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    usedAt: timestamp("usedAt"),
    attempts: int("attempts").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("alert_pair_codes_hash_idx").on(table.codeHash),
    index("alert_pair_codes_security_idx").on(table.securityDeviceId),
  ],
);

export const alertPairings = mysqlTable(
  "alert_pairings",
  {
    id: int("id").autoincrement().primaryKey(),
    driverDeviceId: varchar("driverDeviceId", { length: 80 }).notNull(),
    securityDeviceId: varchar("securityDeviceId", { length: 80 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("alert_pairings_driver_security_uq").on(table.driverDeviceId, table.securityDeviceId),
    index("alert_pairings_driver_idx").on(table.driverDeviceId),
    index("alert_pairings_security_idx").on(table.securityDeviceId),
  ],
);

export const alertRecords = mysqlTable(
  "alert_records",
  {
    alertId: varchar("alertId", { length: 120 }).primaryKey(),
    driverDeviceId: varchar("driverDeviceId", { length: 80 }).notNull(),
    driverName: varchar("driverName", { length: 120 }).notNull(),
    vehicleModel: varchar("vehicleModel", { length: 100 }).notNull(),
    vehicleColor: varchar("vehicleColor", { length: 60 }).notNull(),
    vehiclePlate: varchar("vehiclePlate", { length: 30 }).notNull(),
    latitude: double("latitude"),
    longitude: double("longitude"),
    locationSource: mysqlEnum("locationSource", ["current", "last", "none"]).notNull(),
    capturedAt: varchar("capturedAt", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["new", "acknowledged", "resolved"]).default("new").notNull(),
    trackingActive: boolean("trackingActive").default(true).notNull(),
    acknowledgedBy: varchar("acknowledgedBy", { length: 80 }),
    acknowledgedAt: timestamp("acknowledgedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("alert_records_driver_idx").on(table.driverDeviceId),
    index("alert_records_created_idx").on(table.createdAt),
    index("alert_records_updated_idx").on(table.updatedAt),
  ],
);

/** Recent location history retained for the configured LGPD retention window. */
export const alertLocations = mysqlTable(
  "alert_locations",
  {
    id: int("id").autoincrement().primaryKey(),
    alertId: varchar("alertId", { length: 120 }).notNull(),
    driverDeviceId: varchar("driverDeviceId", { length: 80 }).notNull(),
    latitude: double("latitude").notNull(),
    longitude: double("longitude").notNull(),
    capturedAt: varchar("capturedAt", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("alert_locations_alert_idx").on(table.alertId, table.createdAt),
    index("alert_locations_driver_idx").on(table.driverDeviceId, table.createdAt),
  ],
);

export type AlertDevice = typeof alertDevices.$inferSelect;
export type AlertFcmToken = typeof alertFcmTokens.$inferSelect;
export type AlertPairCode = typeof alertPairCodes.$inferSelect;
export type AlertPairing = typeof alertPairings.$inferSelect;
export type AlertRecord = typeof alertRecords.$inferSelect;
export type AlertLocation = typeof alertLocations.$inferSelect;
