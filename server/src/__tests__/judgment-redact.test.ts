import { describe, expect, it } from "vitest";
import {
  findSecretOriginPolicyFields,
  redactForEgress,
} from "../services/judgment/redact.js";

describe("redactForEgress — 규칙별 검출/치환", () => {
  it("주민등록번호를 치환한다 (X 마스킹 형 포함)", () => {
    const result = redactForEgress({ text: "주민번호 900101-1234567 및 900101-234567X" });
    expect(result.status).toBe("checked_redacted");
    expect(result.findings).toEqual([{ rule: "korean_rrn", count: 2 }]);
    expect(result.redacted).toEqual({
      text: "주민번호 «REDACTED_KOREAN_RRN_1» 및 «REDACTED_KOREAN_RRN_2»",
    });
  });

  it("더 긴 숫자열 일부는 주민번호로 오탐하지 않는다 (경계 가드)", () => {
    const result = redactForEgress({ id: "9900101-12345678" });
    expect(result.findings.find((f) => f.rule === "korean_rrn")).toBeUndefined();
  });

  it("이메일을 치환한다", () => {
    const result = redactForEgress("담당자: kwak@example.co.kr 로 연락");
    expect(result.status).toBe("checked_redacted");
    expect(result.findings).toEqual([{ rule: "email", count: 1 }]);
    expect(result.redacted).toBe("담당자: «REDACTED_EMAIL_1» 로 연락");
  });

  it("한국 전화번호(휴대/서울/지역/+82)를 치환한다", () => {
    const result = redactForEgress({
      mobile: "010-1234-5678",
      seoul: "02-345-6789",
      area: "051-123-4567",
      intl: "+82-10-1234-5678",
    });
    expect(result.status).toBe("checked_redacted");
    expect(result.findings).toEqual([{ rule: "korean_phone", count: 4 }]);
    expect(result.redacted).toEqual({
      mobile: "«REDACTED_KOREAN_PHONE_1»",
      seoul: "«REDACTED_KOREAN_PHONE_2»",
      area: "«REDACTED_KOREAN_PHONE_3»",
      intl: "«REDACTED_KOREAN_PHONE_4»",
    });
  });

  it("API키/토큰 패턴을 치환한다 (sk-, AKIA, Bearer, api_key 할당)", () => {
    const result = redactForEgress({
      openai: "sk-abcdefghijklmnopqrstuvwxyz",
      aws: "AKIAIOSFODNN7EXAMPLE",
      auth: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token",
      config: 'apiKey = "abcdef1234567890abcd"',
    });
    expect(result.status).toBe("checked_redacted");
    const rules = result.findings.map((f) => f.rule);
    expect(rules).toContain("api_key");
    expect(rules).toContain("aws_access_key_id");
    expect(rules).toContain("bearer_token");
    expect(rules).toContain("api_key_assignment");
    const redacted = result.redacted as Record<string, string>;
    expect(redacted.openai).not.toContain("sk-abcdefghijklmnop");
    expect(redacted.aws).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted.auth).not.toContain("eyJhbGciOi");
    expect(redacted.config).not.toContain("abcdef1234567890");
  });

  it("탐지 0건이면 checked_no_findings", () => {
    const result = redactForEgress({ plan: { steps: ["설계", "구현"], budget: 3 } });
    expect(result.status).toBe("checked_no_findings");
    expect(result.findings).toEqual([]);
    expect(result.redacted).toEqual({ plan: { steps: ["설계", "구현"], budget: 3 } });
  });
});

describe("redactForEgress — 관계 보존/구조 보존/불변", () => {
  it("같은 값은 같은 토큰을 받는다 (다른 값은 다른 토큰)", () => {
    const result = redactForEgress({
      a: "user1@example.com",
      b: "user1@example.com",
      c: "user2@example.com",
    });
    const redacted = result.redacted as Record<string, string>;
    expect(redacted.a).toBe(redacted.b);
    expect(redacted.a).not.toBe(redacted.c);
    // count 는 발생 수(3) — 토큰 수(2)가 아니라 치환된 발생 전체를 센다.
    expect(result.findings).toEqual([{ rule: "email", count: 3 }]);
  });

  it("중첩 객체/배열 구조와 비문자열 원시값을 보존한다", () => {
    const state = {
      plan: { title: "계획", meta: { rev: 2, ok: true, none: null } },
      steps: [{ name: "연락처 확인", owner: "010-1111-2222" }, "빈 문자열 아님"],
      top: "a@b.co",
    };
    const result = redactForEgress(state);
    const redacted = result.redacted as typeof state;
    expect(Object.keys(redacted)).toEqual(["plan", "steps", "top"]);
    expect(redacted.plan.meta).toEqual({ rev: 2, ok: true, none: null });
    expect(redacted.steps).toHaveLength(2);
    expect(redacted.steps[0].name).toBe("연락처 확인");
    expect(redacted.steps[0].owner).toBe("«REDACTED_KOREAN_PHONE_1»");
    expect(redacted.plan.title).toBe("계획");
  });

  it("JSON 문자열 내부 패턴도 문자열 단위로 치환한다 (구조 파괴 없음)", () => {
    const result = redactForEgress({ payload: '{"email":"x@example.com","n":1}' });
    expect(result.redacted).toEqual({
      payload: '{"email":"«REDACTED_EMAIL_1»","n":1}',
    });
  });

  it("원본 state 를 변경하지 않는다 (deep clone 반환)", () => {
    const state = { inner: { contact: "010-1234-5678" }, list: ["a@b.co"] };
    const snapshot = JSON.stringify(state);
    redactForEgress(state);
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(state.inner.contact).toBe("010-1234-5678");
  });

  it("findings 에 matched text 가 노출되지 않는다", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz";
    const result = redactForEgress({ key: secret });
    expect(JSON.stringify(result.findings)).not.toContain(secret);
    expect(JSON.stringify(result.redacted)).not.toContain(secret);
  });
});

describe("redactForEgress — error 경로", () => {
  it("직렬화 불가 값(bigint/function/undefined)이 있으면 status error, redacted null", () => {
    expect(redactForEgress({ bad: 1n }).status).toBe("error");
    expect(redactForEgress({ bad: 1n }).redacted).toBeNull();
    expect(redactForEgress({ fn: () => {} }).status).toBe("error");
    expect(redactForEgress(undefined).status).toBe("error");
  });

  it("순환 참조면 status error", () => {
    const state: Record<string, unknown> = { name: "x" };
    state.self = state;
    const result = redactForEgress(state);
    expect(result.status).toBe("error");
    expect(result.redacted).toBeNull();
  });

  it("순수 함수 — 같은 입력에 같은 출력(재시도 가능)", () => {
    const state = { a: "010-1234-5678", b: ["y@example.com"] };
    expect(redactForEgress(state)).toEqual(redactForEgress(state));
  });

  it("문자열 state 최상위도 치환한다", () => {
    const result = redactForEgress("문서 x@example.com 포함");
    expect(result.redacted).toBe("문서 «REDACTED_EMAIL_1» 포함");
  });
});

describe("findSecretOriginPolicyFields — 정책 하드 거부 스캔", () => {
  it("값 래퍼 형태: 필드가 { originPolicy: \"secret\" } 이면 경로 반환", () => {
    const state = {
      contact: { value: "010-1234-5678", originPolicy: "secret" },
      plan: { originPolicy: "internal" },
    };
    expect(findSecretOriginPolicyFields(state)).toEqual(["contact"]);
  });

  it("분류 맵 형태: { originPolicy: { field: \"secret\" } } 이면 필드명 반환", () => {
    const state = {
      originPolicy: { contact: "secret", plan: "public" },
      contact: "원문",
      plan: "공개",
    };
    expect(findSecretOriginPolicyFields(state)).toEqual(["contact"]);
  });

  it("중첩 객체/배열 안의 secret 분류도 찾는다", () => {
    const state = {
      sections: [{ title: "a", originPolicy: "secret" }],
    };
    expect(findSecretOriginPolicyFields(state)).toEqual(["sections[0]"]);
  });

  it("secret 이 없으면 빈 배열 (shadow 조립기 state 는 항상 이 쪽)", () => {
    const state = { plan: { steps: [] }, mission: { id: "m1" } };
    expect(findSecretOriginPolicyFields(state)).toEqual([]);
  });

  it("경로만 반환 — 원본 값을 반환하지 않는다", () => {
    const state = { contact: { value: "시크릿원문", originPolicy: "secret" } };
    const paths = findSecretOriginPolicyFields(state);
    expect(JSON.stringify(paths)).not.toContain("시크릿원문");
  });
});
