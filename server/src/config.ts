import { readFileSync } from "node:fs";

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  jwtSecret: string;
  requireAuth: boolean;
  maxOpsPerSec: number;
  maxBurst: number;
  snapshotEvery: number;
  idleRoomMs: number;
  corsOrigins: string[];
  maxMessageBytes: number;
}

function fromEnv(name: string, def?: string): string {
  const v = process.env[name];
  if (v !== undefined) return v;
  if (def !== undefined) return def;
  throw new Error(`env var ${name} is required`);
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be int`);
  return n;
}

function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true";
}

function secret(): string {
  const v = process.env.CANVASLIVE_JWT_SECRET;
  if (v && v.length >= 16) return v;
  const path = process.env.CANVASLIVE_JWT_SECRET_FILE;
  if (path) {
    const s = readFileSync(path, "utf8").trim();
    if (s.length >= 16) return s;
  }
  // Dev-only fallback. Logs a loud warning; never use in prod.
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[config] CANVASLIVE_JWT_SECRET not set; generating an ephemeral dev secret",
    );
    return "dev-secret-" + Math.random().toString(36).slice(2, 12).padEnd(20, "x");
  }
  throw new Error("CANVASLIVE_JWT_SECRET is required in production");
}

export function loadConfig(): Config {
  return {
    port: intEnv("PORT", 8787),
    host: fromEnv("HOST", "0.0.0.0"),
    dbPath: fromEnv("CANVASLIVE_DB", "./canvaslive.db"),
    jwtSecret: secret(),
    requireAuth: boolEnv("CANVASLIVE_REQUIRE_AUTH", false),
    maxOpsPerSec: intEnv("CANVASLIVE_MAX_OPS_PER_SEC", 200),
    maxBurst: intEnv("CANVASLIVE_MAX_BURST", 400),
    snapshotEvery: intEnv("CANVASLIVE_SNAPSHOT_EVERY", 500),
    idleRoomMs: intEnv("CANVASLIVE_IDLE_ROOM_MS", 30 * 60 * 1000),
    corsOrigins: fromEnv("CANVASLIVE_CORS_ORIGINS", "*")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxMessageBytes: intEnv("CANVASLIVE_MAX_MSG_BYTES", 256 * 1024),
  };
}
