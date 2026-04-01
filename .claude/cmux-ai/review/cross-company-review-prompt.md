아래는 Paperclip 기반 멀티 컴퍼니 에이전트 시스템에서 "크로스 컴퍼니 유지보수 요청" 구조입니다.
이 구조가 좋은 설계인지, 더 나은 대안이 있는지 리뷰해주세요.

## 현재 구조

두 회사가 Paperclip 인스턴스 하나에서 운영됨:
- 가즈아: 투자 자동화 (현업 — CLI로 직접 실행)
- 개수라발발타: 개발/연구 (IT — 코드 유지보수)

## 유지보수 요청 흐름

```
가즈아 에이전트(도라에몽)가 CLI 실행 중 에러 발생
→ 가즈아에 [유지보수] 라벨 이슈 생성 (에러 내용 포함)
→ 개수라발발타의 스파이더맨이 가즈아 API를 폴링해서 [유지보수] 이슈 감지
→ 스파이더맨이 가즈아 코드를 수정
→ 가즈아 이슈에 수정 내용 코멘트 + status: in_review
→ 가즈아 감찰관(포청천)이 검수 → done
```

## Workflow Engine으로 전환 예정

```yaml
name: "크로스 컴퍼니 유지보수"
trigger: webhook
crossCompany: true
steps:
  - id: report-bug
    companyId: gazua
    agent: reporter (동적)
  - id: fix
    companyId: gaesura
    agent: spiderman
    dependsOn: [report-bug]
  - id: report-back
    companyId: gazua
    agent: spiderman
    dependsOn: [fix]
  - id: verify
    companyId: gazua
    agent: inspector
    dependsOn: [report-back]
```

## 검토 요청

1. 이 구조 자체가 좋은 패턴인가? (현업/IT 분리, 크로스 컴퍼니 티켓)
2. 폴링 → webhook 전환이 적절한가?
3. 가즈아 코드를 개수라발발타 에이전트가 직접 수정하는 것의 보안/격리 우려?
4. 더 나은 대안이 있는가? (예: 단일 회사로 통합, 별도 유지보수 큐 등)
5. 실제 ITSM(ServiceNow, Jira Service Management) 대비 이 구조의 장단점?
