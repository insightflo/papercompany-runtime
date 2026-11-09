/**
 * 인앱 DB 백업 flight 상태 공유
 *
 * 목적: 주기 정리 작업(heartbeat-run-output-retention.ts)이 인앱 예약 백업
 * (index.ts 의 runScheduledBackup → runDatabaseBackup, SQL 읽기 기반) 실행 중
 * heartbeat_runs UPDATE 를 자제하도록 하는 공유 마커(a1-opt-plan.md §3-3:
 * 백업과 절단 UPDATE 를 동시에 돌리지 않는다). 외부 pg_dump 백업(A1 systemd
 * papercompany-db-backup.service)은 pg_stat_activity 로 별도 탐지한다.
 */

let activeFlights = 0;

export function beginDatabaseBackupFlight(): void {
  activeFlights += 1;
}

export function endDatabaseBackupFlight(): void {
  if (activeFlights > 0) activeFlights -= 1;
}

export function isDatabaseBackupFlightActive(): boolean {
  return activeFlights > 0;
}
