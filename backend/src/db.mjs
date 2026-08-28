import pg from "pg";

const connectionString = process.env.DATABASE_URL ?? "postgres://appforge:appforge@127.0.0.1:5433/appforge";

export const pool = new pg.Pool({ connectionString });
