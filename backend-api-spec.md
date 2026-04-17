# 백엔드 API 명세 (클라이언트 연동용)

클라이언트(`uploader.js`)가 호출하는 5개 엔드포인트 명세입니다.
Spring Boot 또는 Node.js 어느 쪽으로 구현해도 동일하게 동작합니다.

---

## 1. POST /api/upload/multipart/create
Multipart Upload를 시작하고 uploadId를 발급합니다.

**Request Body**
```json
{ "filename": "ortho.tif", "contentType": "image/tiff", "size": 53687091200 }
```
**Response**
```json
{ "uploadId": "abc123", "key": "uploads/ortho.tif" }
```
백엔드 동작: SeaweedFS S3 `CreateMultipartUpload` 호출

---

## 2. POST /api/upload/multipart/sign-part
단일 파트의 Presigned PUT URL을 발급합니다.

**Request Body**
```json
{ "uploadId": "abc123", "key": "uploads/ortho.tif", "partNumber": 1 }
```
**Response**
```json
{ "url": "http://seaweedfs-s3:8333/bucket/uploads/ortho.tif?partNumber=1&uploadId=abc123&X-Amz-Signature=..." }
```

---

## 3. POST /api/upload/multipart/sign-parts
여러 파트의 Presigned URL을 배치로 발급합니다 (네트워크 왕복 최소화).

**Request Body**
```json
{ "uploadId": "abc123", "key": "uploads/ortho.tif", "partNumbers": [1, 2, 3, 4] }
```
**Response**
```json
{
  "presignedUrls": {
    "1": "http://seaweedfs-s3:8333/...?partNumber=1&...",
    "2": "http://seaweedfs-s3:8333/...?partNumber=2&...",
    "3": "http://seaweedfs-s3:8333/...?partNumber=3&...",
    "4": "http://seaweedfs-s3:8333/...?partNumber=4&..."
  }
}
```

---

## 4. POST /api/upload/multipart/complete
모든 파트 업로드 후 SeaweedFS에 병합을 요청합니다.
SeaweedFS는 메타데이터만 연결하므로 50GB도 즉시 완료됩니다.

**Request Body**
```json
{
  "uploadId": "abc123",
  "key": "uploads/ortho.tif",
  "parts": [
    { "PartNumber": 1, "ETag": "\"d41d8cd98f00b204e9800998ecf8427e\"" },
    { "PartNumber": 2, "ETag": "\"abc...\"" }
  ]
}
```
**Response**
```json
{ "location": "/bucket/uploads/ortho.tif" }
```
백엔드 동작 후: SeaweedFS Filer Notification(Webhook)으로 후처리 파이프라인 트리거

---

## 5. POST /api/upload/multipart/abort
업로드를 취소하고 임시 파트를 삭제합니다.

**Request Body**
```json
{ "uploadId": "abc123", "key": "uploads/ortho.tif" }
```
**Response**: `204 No Content`

---

## 6. GET /api/upload/multipart/list-parts
이어올리기(Resume)를 위해 이미 업로드된 파트 목록을 조회합니다.

**Query Params**: `uploadId=abc123&key=uploads/ortho.tif`

**Response**
```json
[
  { "PartNumber": 1, "ETag": "\"d41d8...\"", "Size": 67108864 },
  { "PartNumber": 2, "ETag": "\"abc...\"",   "Size": 67108864 }
]
```
