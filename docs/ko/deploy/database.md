---
title: 데이터베이스
summary: 임베디드 PostgreSQL 대 Docker Postgres 대 호스팅
---

papercompany는 Drizzle ORM을 통해 PostgreSQL을 사용합니다. 데이터베이스를 실행하는 방법은 세 가지입니다.

## 1. 임베디드 PostgreSQL(기본값)

설정이 필요 없습니다. `DATABASE_URL`을 설정하지 않으면 서버가 임베디드 PostgreSQL 인스턴스를 자동으로 시작합니다.

```sh
pnpm dev
```

첫 시작 시 서버는:

1. 저장을 위해 `~/.paperclip/instances/default/db/`를 생성
2. `paperclip` 데이터베이스가 존재하는지 확인
3. 마이그레이션 자동 적용
4. 요청 서비스 시작

데이터는 재시작 후에도 유지됩니다. 초기화하려면: `rm -rf ~/.paperclip/instances/default/db`.

Docker 퀵스타트도 기본적으로 임베디드 PostgreSQL을 사용합니다.

## 2. 로컬 PostgreSQL(Docker)

로컬에서 전체 PostgreSQL 서버를 실행하려면:

```sh
docker compose up -d
```

이 명령은 `localhost:5432`에서 PostgreSQL 17을 시작합니다. 연결 문자열을 설정하세요:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

스키마를 푸시하세요:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. 호스팅 PostgreSQL(Supabase)

프로덕션에서는 [Supabase](https://supabase.com/) 같은 호스팅 제공자를 사용하세요.

1. [database.new](https://database.new)에서 프로젝트 생성
2. Project Settings > Database에서 연결 문자열 복사
3. `.env`에 `DATABASE_URL` 설정

마이그레이션에는 **직접 연결**(포트 5432)을, 애플리케이션에는 **풀 연결**(포트 6543)을 사용하세요.

연결 풀링을 사용한다면 prepared statements를 비활성화하세요:

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## 모드 간 전환

| `DATABASE_URL` | 모드 |
|----------------|------|
| 미설정 | 임베디드 PostgreSQL |
| `postgres://...localhost...` | 로컬 Docker PostgreSQL |
| `postgres://...supabase.com...` | 호스팅 Supabase |

Drizzle 스키마(`packages/db/src/schema/`)는 모드와 관계없이 동일합니다.
