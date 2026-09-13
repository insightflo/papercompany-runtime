import { describe } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

export type QualityTestDb = { db: Db; close(): Promise<void> };

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
export const describeQualityDb = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres quality tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * 격리 PostgreSQL 테스트 DB(기존 startEmbeddedPostgresTestDatabase 패턴)로 Drizzle Db를 만든다.
 * 마이그레이션은 헬퍼가 적용하며, 127.0.0.1:54329 나 DATABASE_URL 운영 DB에 접속하지 않는다.
 */
export async function createQualityTestDb(): Promise<QualityTestDb> {
  const tempDb = await startEmbeddedPostgresTestDatabase("quality-structural-t1-");
  const db = createDb(tempDb.connectionString);
  return {
    db,
    close: async () => {
      await db.$client.end({ timeout: 5 });
      await tempDb.cleanup();
    },
  };
}
