/**
 * uploader.js
 * SeaweedFS S3 Multipart 업로드 클라이언트 (Uppy.js v3)
 *
 * 50GB 대용량 업로드 최적화 포인트:
 *  - 청크 64MB: S3 최소(5MB) 대비 메모리 압력↓, 파트 수↓ (50GB → 약 800개)
 *  - 동시 업로드 4개: 대역폭 포화 vs 브라우저 연결 한도 균형
 *  - retryDelays 지수 백오프: 네트워크 순단 시 자동 복구
 *  - limit(파일 수): 1로 제한하여 불필요한 메모리 점유 방지
 */

import { Uppy, Dashboard, AwsS3Multipart } from 'https://releases.transloadit.com/uppy/v3.21.0/uppy.min.mjs';

// ── 설정 ──────────────────────────────────────────────────────────────────────

const CONFIG = {
  BACKEND_URL: 'http://localhost:8080/api/upload', // Spring Boot / Node.js 백엔드
  CHUNK_SIZE_MB: 64,                               // 파트 크기 (단위: MB)
  CONCURRENT_UPLOADS: 4,                           // 동시 업로드 파트 수
  MAX_FILE_SIZE_GB: 55,                            // 허용 최대 파일 크기
  ALLOWED_MIME: ['image/tiff', 'image/geotiff',    // 허용 파일 형식
                 'application/octet-stream'],
};

const CHUNK_BYTES = CONFIG.CHUNK_SIZE_MB * 1024 * 1024;
const MAX_FILE_BYTES = CONFIG.MAX_FILE_SIZE_GB * 1024 * 1024 * 1024;

// ── Uppy 인스턴스 ─────────────────────────────────────────────────────────────

const uppy = new Uppy({
  id: 'raster-uploader',
  autoProceed: false,            // 사용자가 명시적으로 업로드 버튼을 클릭해야 시작
  allowMultipleUploadBatches: false,

  restrictions: {
    maxNumberOfFiles: 1,         // 한 번에 한 파일만 허용하여 메모리 보호
    maxFileSize: MAX_FILE_BYTES,
    allowedFileTypes: ['.tif', '.tiff', '.geotiff'],
  },

  // Uppy 내부 로그를 콘솔에 출력 (운영 시 'silent'로 변경)
  logger: {
    debug: (...args) => console.debug('[Uppy]', ...args),
    warn:  (...args) => console.warn('[Uppy]', ...args),
    error: (...args) => console.error('[Uppy]', ...args),
  },
})

// ── Dashboard UI ──────────────────────────────────────────────────────────────

.use(Dashboard, {
  target: '#uppy-dashboard',
  inline: true,
  width: '100%',
  height: 420,
  showProgressDetails: true,
  proudlyDisplayPoweredByUppy: false,
  locale: {
    strings: {
      dropPasteFiles: 'GeoTIFF 파일을 드래그하거나 %{browseFiles}',
      browseFiles: '파일 선택',
      uploadXFiles: { 0: '업로드 시작', 1: '업로드 시작' },
      uploading: '업로드 중...',
      complete: '업로드 완료',
      uploadFailed: '업로드 실패',
      paused: '일시 정지',
    },
  },
})

// ── S3 Multipart 플러그인 ─────────────────────────────────────────────────────

.use(AwsS3Multipart, {
  // 파트(청크) 크기: 64MB — 브라우저 메모리와 S3 파트 수의 균형점
  partSize: CHUNK_BYTES,

  // 동시 업로드 파트 수: 4개 — 100Mbps 이상 회선에서 최적
  limit: CONFIG.CONCURRENT_UPLOADS,

  // 지수 백오프 재시도: 0ms → 1s → 3s → 10s → 30s (총 5회)
  retryDelays: [0, 1_000, 3_000, 10_000, 30_000],

  // ── 백엔드 API 연동 메서드 ────────────────────────────────────────────────

  /**
   * 1단계: Multipart Upload 시작 → 백엔드가 SeaweedFS에서 uploadId 발급
   */
  async createMultipartUpload(file) {
    const resp = await apiFetch(`${CONFIG.BACKEND_URL}/multipart/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name.replace(/'/g, '_'),
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      }),
    });
    // 백엔드 응답: { uploadId: string, key: string }
    return resp;
  },

  /**
   * 2단계: 각 파트의 Presigned URL 요청 → 백엔드가 SeaweedFS S3 URL 생성
   * numbers: 업로드할 파트 번호 배열 (1-based)
   */
  async signPart(file, { uploadId, key, partNumber }) {
    const resp = await apiFetch(`${CONFIG.BACKEND_URL}/multipart/sign-part`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key, partNumber }),
    });
    // 백엔드 응답: { url: string (presigned PUT URL) }
    return resp;
  },

  /**
   * 2-b단계: 여러 파트 URL을 한 번에 요청 (배치 최적화)
   * Uppy가 signPart 대신 이 메서드를 우선 사용함
   */
  async signParts(file, { uploadId, key, partNumbers }) {
    const resp = await apiFetch(`${CONFIG.BACKEND_URL}/multipart/sign-parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key, partNumbers }),
    });
    // 백엔드 응답: { presignedUrls: { [partNumber]: string } }
    return resp.presignedUrls;
  },

  /**
   * 3단계: 모든 파트 업로드 완료 → 백엔드가 SeaweedFS에 CompleteMultipartUpload 요청
   * parts: [{ PartNumber, ETag }, ...]
   */
  async completeMultipartUpload(file, { uploadId, key, parts }) {
    const cleanedParts = parts.map(p => ({
      ...p,
      ETag: p.ETag?.replace(/\\/g, '').replace(/"/g, ''),
    }));
    const resp = await apiFetch(`${CONFIG.BACKEND_URL}/multipart/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key, parts: cleanedParts }),
    });
    // 백엔드 응답: { location: string } — 저장된 파일 경로
    return resp;
  },

  /**
   * 중단/오류 시: 업로드 취소 → 백엔드가 SeaweedFS에 AbortMultipartUpload 요청
   */
  async abortMultipartUpload(file, { uploadId, key }) {
    await apiFetch(`${CONFIG.BACKEND_URL}/multipart/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key }),
    });
  },

  /**
   * 이어올리기(Resume): 이미 업로드된 파트 목록 조회
   */
  async listParts(file, { uploadId, key }) {
    const resp = await apiFetch(
      `${CONFIG.BACKEND_URL}/multipart/list-parts?uploadId=${encodeURIComponent(uploadId)}&key=${encodeURIComponent(key)}`
    );
    // 백엔드 응답: [{ PartNumber, ETag, Size }, ...]
    return resp;
  },
});

// ── 이벤트 핸들러 ─────────────────────────────────────────────────────────────

uppy.on('upload-start', (files) => {
  const totalGB = (files.reduce((s, f) => s + f.size, 0) / 1e9).toFixed(2);
  updateStatus(`업로드 시작 — ${files.length}개 파일, 총 ${totalGB} GB`);
  console.info(`[Upload] 시작: ${files.map(f => f.name).join(', ')} (${totalGB} GB)`);
});

uppy.on('upload-progress', (file, progress) => {
  const pct = Math.round((progress.bytesUploaded / progress.bytesTotal) * 100);
  const uploaded = (progress.bytesUploaded / 1e9).toFixed(2);
  const total    = (progress.bytesTotal    / 1e9).toFixed(2);
  updateStatus(`업로드 중: ${file.name} — ${pct}% (${uploaded} / ${total} GB)`);
});

uppy.on('upload-success', (file, response) => {
  console.info('[Upload] 완료:', file.name, response);
  updateStatus(`완료: ${file.name} → ${response.body?.location ?? '저장됨'}`);
});

uppy.on('upload-error', (file, error, response) => {
  console.error('[Upload] 오류:', file?.name, error);
  updateStatus(`오류: ${file?.name} — ${error.message}`);
});

uppy.on('restriction-failed', (file, error) => {
  alert(`파일 제한 위반: ${error.message}`);
});

// ── 유틸리티 ──────────────────────────────────────────────────────────────────

/**
 * 공통 fetch 래퍼 — JSON 응답 파싱 및 HTTP 오류 처리
 */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

function updateStatus(msg) {
  const el = document.getElementById('status-bar');
  if (el) el.innerHTML = `<strong>업로드 상태:</strong> ${msg}<br/>
    <strong>청크 크기:</strong> <span class="badge">${CONFIG.CHUNK_SIZE_MB} MB</span>
    <strong>동시 업로드:</strong> <span class="badge">${CONFIG.CONCURRENT_UPLOADS}개 파트</span>
    <strong>최대 재시도:</strong> <span class="badge">5회</span>`;
}

export default uppy;
