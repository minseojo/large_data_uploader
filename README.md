# Large Raster Upload System

대용량 Raster 파일(GeoTIFF 등, 10~50GB)을 온프레미스 환경에서 SeaweedFS S3로 업로드하는 시스템입니다.

---

## 핵심 개념 정리

### 1. 업로드 병목은 소프트웨어가 아닌 네트워크
- 1Gbps LAN 환경 실측: ~110 MB/s (이론치 125 MB/s의 88%)
- 청크 크기, 동시성, 업로드 방식(S3/로컬) 모두 **전송 속도에 영향 없음**
- 속도를 높이려면 10Gbps NIC + 스위치 교체가 유일한 방법

### 2. 멀티파트 청킹을 쓰는 이유
- **재시도**: 실패한 파트만 재전송 (50GB 중 100MB만)
- **이어올리기**: 업로드 중단 후 재개 가능
- **안정성**: 단일 TCP 연결 대비 네트워크 오류 복구 용이

### 3. 업로드 방식 비교 (7GB 파일, 1Gbps LAN 실측)

| 방식 | 전송 속도 | 병합 시간 | 특징 |
|------|----------|---------|------|
| S3-Multipart | ~112 MB/s | ~0초 | SeaweedFS 메타데이터만 연결 |
| Local-Offset (RAF) | ~111 MB/s | ~0초 | 청크를 offset에 직접 write |
| Local-Mmap | ~111 MB/s | ~0초 | Memory-Mapped File, OS 레벨 write |
| Local-Stream | ~113 MB/s | ~0초 | 청킹 없는 단일 스트림, 가장 단순 |
| Local-Seq (temp+merge) | ~111 MB/s | **~10초** | 임시파일 저장 후 순차 병합 |

### 4. 동시성(Concurrency) 효과
- **LAN(RTT < 1ms)**: concurrency=1도 대역폭 포화 → 2 이상은 효과 없음
- **WAN(RTT 50ms+)**: 단일 TCP 연결이 TCP window로 제한 → 병렬 연결로 대역폭 채움
- 멀티파트에서 concurrency는 WAN 환경에서 의미있음

### 5. SeaweedFS 특성
- S3 멀티파트 complete 시 **데이터 복사 없이 메타데이터만 연결** → 50GB도 즉시 병합
- path-style URL 사용 (`http://host:8333/bucket/key`)
- Presigned URL 방식: 클라이언트 → SeaweedFS 직접 PUT (백엔드 부하 없음)

### 6. 네트워크 제한 테스트 (tc)
- `tc qdisc`는 **egress(송신)만 제어** → 업로드 테스트엔 ingress 필요
- ingress police는 패킷 드롭 방식 → TCP 재전송 폭발로 결과 왜곡
- 정확한 업로드 속도 제한 테스트는 WAN 환경 권장

---

## 아키텍처

```
브라우저 (index.html + uppy.js)
    │
    ├─ POST /api/upload/multipart/create     → Backend (8080)
    ├─ POST /api/upload/multipart/sign-parts → Backend (8080)
    │
    └─ PUT (Presigned URL) ─────────────────→ SeaweedFS S3 (8333)
                                               직접 업로드 (백엔드 bypass)
```

---

## 빠른 시작

### 사전 요구사항
- Java 17+
- SeaweedFS (`weed server -s3`)
- Live Server (VS Code 확장) 또는 아무 HTTP 서버

### 1. 백엔드 설정

`backend/src/main/resources/application.yml` 수정:

```yaml
seaweedfs:
  s3:
    endpoint: http://<SeaweedFS-IP>:8333
    access-key: <your-access-key>
    secret-key: <your-secret-key>
    bucket: <your-bucket-name>

cors:
  allowed-origins:
    - http://localhost:5500
    - http://127.0.0.1:5500
```

### 2. 백엔드 실행

```bash
cd backend
./gradlew bootRun
# 또는 jar로 실행
./gradlew bootJar
java -jar build/libs/big-size-uploader-1.0.0.jar
```

서버 기본 포트: **8080**

### 3. 프론트엔드 실행

`uploader.js` 상단의 `BACKEND_URL` 확인 (기본값: `http://localhost:8080`):

```js
const BACKEND_URL = 'http://localhost:8080/api/upload';
```

`index.html`을 Live Server로 열거나:
```bash
npx serve .   # Node.js 있는 경우
```

브라우저에서 `http://localhost:5500` 접속

---

## 벤치마크

Node.js 18+ 필요

```bash
# S3 멀티파트만
node benchmark.mjs s3

# 로컬 디스크 방식만 (offset/seq/stream/mmap)
node benchmark.mjs local
node benchmark.mjs local-seq
node benchmark.mjs local-stream
node benchmark.mjs local-mmap

# 전체 비교
node benchmark.mjs both
```

`benchmark.mjs` 상단에서 파일 경로 및 파라미터 설정:

```js
const FILE_PATH      = '/path/to/your/large-file.tif';
const BASE_URL       = 'http://<server-ip>:8080';
const CHUNK_SIZES_MB = [32, 64, 100];
const CONCURRENCIES  = [1, 2, 4, 8];
```

결과는 `benchmark_results_<날짜>.csv`로 저장됩니다 (Excel BOM 포함).

---

## API 엔드포인트

### S3 멀티파트 (Presigned URL)
| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/upload/multipart/create` | 업로드 세션 시작 |
| POST | `/api/upload/multipart/sign-parts` | Presigned URL 배치 발급 |
| POST | `/api/upload/multipart/complete` | 병합 완료 |
| POST | `/api/upload/multipart/abort` | 업로드 중단 |
| GET  | `/api/upload/multipart/list-parts` | 업로드된 파트 목록 |

### 로컬 디스크 (벤치마크용)
| Method | Path | 방식 |
|--------|------|------|
| POST | `/api/local/upload/*` | Offset (RandomAccessFile) |
| POST | `/api/local/upload-seq/*` | Sequential (temp + merge) |
| POST | `/api/local/upload-stream/*` | Single stream |
| POST | `/api/local/upload-mmap/*` | Memory-Mapped File |

---

## 프로젝트 구조

```
large_data_uploader/
├── index.html          # 업로드 UI
├── uploader.js         # Uppy 기반 S3 멀티파트 클라이언트
├── benchmark.mjs       # 성능 측정 스크립트 (Node.js)
└── backend/            # Spring Boot 백엔드
    └── src/main/
        ├── java/.../
        │   ├── controller/   # MultipartUpload + LocalUpload 컨트롤러
        │   ├── service/      # 업로드 로직
        │   ├── config/       # S3Config, CorsConfig
        │   └── dto/          # 요청/응답 DTO
        └── resources/
            └── application.yml
```
