---
title: 스토리지
summary: 로컬 디스크 대 S3 호환 스토리지
---

papercompany는 업로드된 파일(이슈 첨부 파일, 이미지)을 구성 가능한 스토리지 제공자로 저장합니다.

## 로컬 디스크(기본값)

파일은 다음 위치에 저장됩니다:

```
~/.paperclip/instances/default/data/storage
```

설정이 필요 없습니다. 로컬 개발과 단일 머신 배포에 적합합니다.

## S3 호환 스토리지

프로덕션 또는 멀티 노드 배포에서는 S3 호환 객체 스토리지(AWS S3, MinIO, Cloudflare R2 등)를 사용하세요.

CLI로 구성:

```sh
pnpm paperclipai configure --section storage
```

## 설정

| 제공자 | 적합한 상황 |
|----------|----------|
| `local_disk` | 로컬 개발, 단일 머신 배포 |
| `s3` | 프로덕션, 멀티 노드, 클라우드 배포 |

스토리지 설정은 인스턴스 설정 파일에 저장됩니다:

```
~/.paperclip/instances/default/config.json
```
