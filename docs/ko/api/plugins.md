---
title: Plugins (플러그인)
summary: 플러그인 카탈로그, 수명주기, 도구, 브리지, 작업, 웹훅
---

플러그인 시스템은 설치 가능한 모듈로 제어 플레인을 확장합니다. 플러그인은 도구, UI, 작업, 웹훅을 제공할 수 있습니다.

## 플러그인 카탈로그

### 플러그인 목록

```
GET /api/plugins
```

설치된 플러그인을 나열합니다.

### 플러그인 예시 목록

```
GET /api/plugins/examples
```

참조용으로 사용 가능한 예시 플러그인을 나열합니다.

### UI 기여

```
GET /api/plugins/ui-contributions
```

플러그인이 제공하는 UI 컴포넌트를 나열합니다.

### 플러그인 조회

```
GET /api/plugins/{pluginId}
```

플러그인 세부 정보와 매니페스트를 반환합니다.

## 플러그인 수명주기

### 플러그인 설치

```
POST /api/plugins/install
{
  "source": "insightflo/research-workbench",
  "version": "1.2.0"
}
```

레지스트리 소스에서 플러그인을 설치합니다.

### 플러그인 제거

```
DELETE /api/plugins/{pluginId}
```

플러그인을 제거합니다.

### 플러그인 활성화

```
POST /api/plugins/{pluginId}/enable
```

### 플러그인 비활성화

```
POST /api/plugins/{pluginId}/disable
```

### 플러그인 업그레이드

```
POST /api/plugins/{pluginId}/upgrade
```

플러그인을 최신 버전으로 업그레이드합니다.

## 플러그인 도구

### 도구 목록

```
GET /api/plugins/tools
```

플러그인이 제공하는 모든 도구를 나열합니다.

### 도구 실행

```
POST /api/plugins/tools/execute
{
  "tool": "insightflo.research-workbench:research-search",
  "arguments": { "query": "climate risks" },
  "runContext": {
    "agentId": "{agentId}",
    "runId": "{runId}",
    "companyId": "{companyId}"
  }
}
```

플러그인 도구를 실행합니다. `runContext`는 유효한 에이전트 실행 컨텍스트를 포함해야 하며, 그렇지 않으면 호스트가 `Agent run context is not valid for tool execution`을 반환합니다.

## 브리지

### 데이터 전송

```
POST /api/plugins/{pluginId}/bridge/data
{
  "channel": "events",
  "payload": { "type": "updated" }
}
```

### 액션 전송

```
POST /api/plugins/{pluginId}/bridge/action
{
  "action": "refresh",
  "payload": {}
}
```

### 채널 스트림

```
GET /api/plugins/{pluginId}/bridge/stream/{channel}
```

플러그인 채널에 대한 서버 전송 이벤트 스트림을 엽니다.

### 플러그인 데이터

```
POST /api/plugins/{pluginId}/data/{key}
{
  "value": {}
}
```

### 플러그인 액션

```
POST /api/plugins/{pluginId}/actions/{key}
{
  "arguments": {}
}
```

## 작업(Jobs)

### 작업 목록

```
GET /api/plugins/{pluginId}/jobs
```

### 작업 실행 목록

```
GET /api/plugins/{pluginId}/jobs/{jobId}/runs
```

### 작업 트리거

```
POST /api/plugins/{pluginId}/jobs/{jobId}/trigger
{
  "input": {}
}
```

작업 실행을 트리거합니다.

## 웹훅

### 플러그인 웹훅

```
POST /api/plugins/{pluginId}/webhooks/{endpointKey}
```

인바운드 웹훅을 플러그인 엔드포인트로 전달합니다.

## 대시보드

### 플러그인 대시보드

```
GET /api/plugins/{pluginId}/dashboard
```

플러그인이 제공하는 대시보드 데이터를 반환합니다.

## 구성

### 구성 조회

```
GET /api/plugins/{pluginId}/config
```

### 구성 설정

```
POST /api/plugins/{pluginId}/config
{
  "values": {}
}
```

### 구성 테스트

```
POST /api/plugins/{pluginId}/config/test
{
  "values": {}
}
```

적용하지 않고 플러그인 구성을 테스트합니다.

## 진단

### 플러그인 상태

```
GET /api/plugins/{pluginId}/health
```

### 플러그인 로그

```
GET /api/plugins/{pluginId}/logs
```

## 정적 UI

### 플러그인 UI 파일

```
GET /api/_plugins/{pluginId}/ui/{filePath}
```

플러그인이 제공하는 정적 UI 에셋을 제공합니다.
