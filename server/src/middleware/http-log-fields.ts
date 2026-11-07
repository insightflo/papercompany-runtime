/**
 * [목적] 접근 로그(pino-http)에서 pretty/JSON 출력으로 남길 필드를 한 곳에서 정의한다.
 * [배경] 2026-11-07 A1 missions 조회 지연 진단에서, 서버가 응답시간(responseTime)을 로그에서
 *        버리고 있어 "느리다"는 제보를 로그로 사후 확인할 수 없었다. pino-http는 요청이 끝날 때
 *        responseTime을 붙이지만, pino-pretty ignore 목록에 이름이 있으면 출력 단계에서 사라진다.
 * [연결] middleware/logger.ts가 이 값을 두 transport의 ignore로 사용하고,
 *        __tests__/http-logger-response-time.test.ts가 같은 값을 실제로 렌더링해 검증한다.
 * [주의] 여기에 responseTime을 다시 추가하면 지연 측정 수단이 사라진다. req/res는 본문에
 *        민감정보가 실릴 수 있어 계속 숨긴다.
 */
export const httpLogIgnore = "pid,hostname,req,res";
