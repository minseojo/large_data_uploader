import { Uppy, Dashboard, AwsS3Multipart } from 'https://releases.transloadit.com/uppy/v3.21.0/uppy.min.mjs';

// 백엔드 서버 주소 — 로컬 실행 시 http://localhost:8080, 원격 서버는 IP로 변경
const BACKEND_URL = 'http://localhost:8080/api/upload';
const MAX_FILE_BYTES = 55 * 1024 * 1024 * 1024;

// ── 설정 읽기 (UI 셀렉트 → 숫자) ──────────────────────────────────────────────

function getChunkBytes() {
  return parseInt(document.getElementById('chunk-size').value) * 1024 * 1024;
}

function getConcurrency() {
  return parseInt(document.getElementById('concurrency').value);
}

// ── 성능 측정 상태 ─────────────────────────────────────────────────────────────

const results = [];
let uploadStartTime = null;
let currentMeta = null;

// ── Uppy 인스턴스 ─────────────────────────────────────────────────────────────

const uppy = new Uppy({
  id: 'raster-uploader',
  autoProceed: false,
  allowMultipleUploadBatches: false,
  restrictions: {
    maxNumberOfFiles: 1,
    maxFileSize: MAX_FILE_BYTES,
    allowedFileTypes: ['.tif', '.tiff', '.geotiff'],
  },
  logger: {
    debug: (...args) => console.debug('[Uppy]', ...args),
    warn:  (...args) => console.warn('[Uppy]', ...args),
    error: (...args) => console.error('[Uppy]', ...args),
  },
})

.use(Dashboard, {
  target: '#uppy-dashboard',
  inline: true,
  width: '100%',
  height: 400,
  showProgressDetails: true,
  proudlyDisplayPoweredByUppy: false,
  locale: {
    strings: {
      dropPasteFiles: '파일을 드래그하거나 %{browseFiles}',
      browseFiles: '파일 선택',
      uploadXFiles: { 0: '업로드 시작', 1: '업로드 시작' },
      uploading: '업로드 중...',
      complete: '업로드 완료',
      uploadFailed: '업로드 실패',
      paused: '일시 정지',
    },
  },
})

.use(AwsS3Multipart, {
  // partSize / limit은 업로드 시작 시점에 UI에서 읽음
  retryDelays: [0, 1_000, 3_000, 10_000, 30_000],

  async createMultipartUpload(file) {
    // 업로드 시작 시점의 설정값을 캡처
    currentMeta = {
      chunkMB: parseInt(document.getElementById('chunk-size').value),
      concurrency: getConcurrency(),
    };
    uploadStartTime = performance.now();
    updateBadges(currentMeta.chunkMB, currentMeta.concurrency);

    return apiFetch(`${BACKEND_URL}/multipart/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name.replace(/'/g, '_'),
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      }),
    });
  },

  async signPart(file, { uploadId, key, partNumber }) {
    return apiFetch(`${BACKEND_URL}/multipart/sign-part`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key, partNumber }),
    });
  },

  async signParts(file, { uploadId, key, partNumbers }) {
    const resp = await apiFetch(`${BACKEND_URL}/multipart/sign-parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key, partNumbers }),
    });
    return resp.presignedUrls;
  },

  async completeMultipartUpload(file, { uploadId, key, parts }) {
    const cleanedParts = parts.map(p => ({
      ...p,
      ETag: p.ETag?.replace(/\\/g, '').replace(/"/g, ''),
    }));
    return apiFetch(`${BACKEND_URL}/multipart/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key, parts: cleanedParts }),
    });
  },

  async abortMultipartUpload(file, { uploadId, key }) {
    await apiFetch(`${BACKEND_URL}/multipart/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key }),
    });
  },

  async listParts(file, { uploadId, key }) {
    return apiFetch(
      `${BACKEND_URL}/multipart/list-parts?uploadId=${encodeURIComponent(uploadId)}&key=${encodeURIComponent(key)}`
    );
  },
});

// ── 동적으로 partSize / limit 적용 ────────────────────────────────────────────
// Uppy AwsS3Multipart는 인스턴스 생성 후 setOptions으로 업데이트 가능

document.getElementById('chunk-size').addEventListener('change', applyOptions);
document.getElementById('concurrency').addEventListener('change', applyOptions);

function applyOptions() {
  uppy.getPlugin('AwsS3Multipart').setOptions({
    partSize: getChunkBytes(),
    limit: getConcurrency(),
  });
  updateBadges(
    parseInt(document.getElementById('chunk-size').value),
    getConcurrency()
  );
}

// 초기값 적용
applyOptions();

// ── 이벤트 핸들러 ─────────────────────────────────────────────────────────────

uppy.on('upload-progress', (file, progress) => {
  const pct = Math.round((progress.bytesUploaded / progress.bytesTotal) * 100);
  const uploaded = (progress.bytesUploaded / 1e6).toFixed(0);
  const total    = (progress.bytesTotal / 1e6).toFixed(0);
  updateStatus(`업로드 중: ${file.name} — ${pct}% (${uploaded} / ${total} MB)`);
});

uppy.on('upload-success', (file) => {
  const elapsedSec = ((performance.now() - uploadStartTime) / 1000).toFixed(1);
  const speedMBs   = (file.size / 1e6 / parseFloat(elapsedSec)).toFixed(1);

  const record = {
    filename:    file.name,
    sizeMB:      (file.size / 1e6).toFixed(1),
    chunkMB:     currentMeta.chunkMB,
    concurrency: currentMeta.concurrency,
    elapsedSec:  parseFloat(elapsedSec),
    speedMBs:    parseFloat(speedMBs),
    status:      'success',
    time:        new Date().toLocaleString('ko-KR'),
  };

  saveResult(record);
  updateStatus(`완료: ${file.name} — ${elapsedSec}초 / 평균 ${speedMBs} MB/s`);
  console.info('[Upload] 완료:', record);
});

uppy.on('upload-error', (file, error) => {
  const elapsedSec = uploadStartTime
    ? ((performance.now() - uploadStartTime) / 1000).toFixed(1)
    : '-';

  const record = {
    filename:    file?.name ?? '알 수 없음',
    sizeMB:      file ? (file.size / 1e6).toFixed(1) : '-',
    chunkMB:     currentMeta?.chunkMB ?? '-',
    concurrency: currentMeta?.concurrency ?? '-',
    elapsedSec:  elapsedSec,
    speedMBs:    '-',
    status:      'error',
    time:        new Date().toLocaleString('ko-KR'),
  };

  saveResult(record);
  updateStatus(`오류: ${file?.name} — ${error.message}`);
  console.error('[Upload] 오류:', record, error);
});

uppy.on('restriction-failed', (file, error) => {
  alert(`파일 제한 위반: ${error.message}`);
});

// ── 결과 저장 및 렌더링 ────────────────────────────────────────────────────────

const STORAGE_KEY = 'upload_perf_results';

function loadResults() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveResult(record) {
  results.push(record);
  const all = loadResults();
  all.push(record);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  renderTable(all);
}

function renderTable(data) {
  const tbody = document.getElementById('result-body');
  const exportBtn = document.getElementById('export-btn');

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="no-results">업로드 결과가 없습니다.</td></tr>';
    exportBtn.disabled = true;
    return;
  }

  tbody.innerHTML = data.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.filename}</td>
      <td>${r.sizeMB} MB</td>
      <td>${r.chunkMB} MB</td>
      <td>${r.concurrency}개</td>
      <td>${r.elapsedSec}초</td>
      <td>${r.speedMBs !== '-' ? r.speedMBs + ' MB/s' : '-'}</td>
      <td><span class="badge ${r.status === 'success' ? 'green' : 'red'}">${r.status === 'success' ? '성공' : '실패'}</span></td>
      <td>${r.time}</td>
    </tr>
  `).join('');

  exportBtn.disabled = false;
}

// ── CSV 내보내기 ───────────────────────────────────────────────────────────────

document.getElementById('export-btn').addEventListener('click', () => {
  const all = loadResults();
  if (!all.length) return;

  const header = ['#', '파일명', '크기(MB)', '청크(MB)', '동시업로드', '소요시간(초)', '평균속도(MB/s)', '결과', '시각'];
  const rows = all.map((r, i) =>
    [i + 1, r.filename, r.sizeMB, r.chunkMB, r.concurrency, r.elapsedSec, r.speedMBs, r.status, r.time]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );

  const csv = '\uFEFF' + [header.join(','), ...rows].join('\n'); // BOM for Excel
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `upload_perf_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── 유틸리티 ──────────────────────────────────────────────────────────────────

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
  if (el) el.querySelector
    ? (el.innerHTML = `<strong>업로드 상태:</strong> ${msg}<br/>
        <strong>청크 크기:</strong> <span class="badge" id="badge-chunk">${document.getElementById('chunk-size').value} MB</span>
        <strong>동시 업로드:</strong> <span class="badge" id="badge-concurrency">${document.getElementById('concurrency').value}개</span>
        <strong>최대 재시도:</strong> <span class="badge">5회</span>`)
    : null;
}

function updateBadges(chunkMB, concurrency) {
  const bc = document.getElementById('badge-chunk');
  const bn = document.getElementById('badge-concurrency');
  if (bc) bc.textContent = `${chunkMB} MB`;
  if (bn) bn.textContent = `${concurrency}개`;
}

// 페이지 로드 시 저장된 결과 복원
renderTable(loadResults());

export default uppy;
