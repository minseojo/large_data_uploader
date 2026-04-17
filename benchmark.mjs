/**
 * benchmark.mjs
 * 청크 크기 × 동시 업로드 수 모든 조합으로 멀티파트 업로드 성능 측정
 *
 * 사용법:
 *   node benchmark.mjs
 *
 * 결과: benchmark_results_<날짜>.csv
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { statSync } from 'fs';

// ── 설정 ──────────────────────────────────────────────────────────────────────

const FILE_PATH    = 'D:/도로공사/2025_02_18_도로공사/포인트클라우드_3D타일결과물/HDRPC-ChangNyeong-MiRyang/result.tdb';
const BACKEND_URL  = 'http://localhost:8080/api/upload';

const CHUNK_SIZES_MB  = [5, 8, 16, 25, 50, 64, 100, 150];
const CONCURRENCIES   = [2, 4, 6, 8, 10, 16];

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function fetchJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function putPart(url, buffer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
      method:   'PUT',
      headers: {
        'Content-Length': buffer.length,
        'Content-Type':   'application/octet-stream',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const etag = res.headers['etag']?.replace(/"/g, '') ?? '';
        if (res.statusCode >= 400) {
          reject(new Error(`PUT ${res.statusCode}: ${data}`));
          return;
        }
        resolve(etag);
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

function post(path, body) {
  return fetchJson(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, body);
}

// ── 청크 분할 헬퍼 ───────────────────────────────────────────────────────────

function readChunk(fd, offset, size) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.allocUnsafe(size);
    fs.read(fd, buf, 0, size, offset, (err, bytesRead) => {
      if (err) reject(err);
      else resolve(bytesRead < size ? buf.subarray(0, bytesRead) : buf);
    });
  });
}

// ── 단일 업로드 실행 ──────────────────────────────────────────────────────────

async function runUpload(filePath, chunkMB, concurrency) {
  const chunkBytes = chunkMB * 1024 * 1024;
  const fileSize   = statSync(filePath).size;
  const fileName   = path.basename(filePath);
  const totalParts = Math.ceil(fileSize / chunkBytes);

  // 1. 업로드 시작
  const { uploadId, key } = await post('/multipart/create', {
    filename:    fileName,
    contentType: 'image/tiff',
    size:        fileSize,
  });

  // 2. 파트 번호 배열 생성
  const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);

  // 3. Presigned URL 배치 요청 (최대 100개씩 나눔)
  const presignedUrls = {};
  for (let i = 0; i < partNumbers.length; i += 100) {
    const batch = partNumbers.slice(i, i + 100);
    const resp = await post('/multipart/sign-parts', { uploadId, key, partNumbers: batch });
    Object.assign(presignedUrls, resp.presignedUrls ?? resp);
  }

  // 4. 파트 병렬 업로드 — 파이프라인: PUT 중에 다음 청크 디스크 읽기 선행
  // worker당 "현재 PUT" + "다음 청크 읽기"를 겹쳐서 네트워크 유휴 시간 제거
  const fd = fs.openSync(filePath, 'r');
  const etags = new Array(totalParts);
  let idx = 0;
  let done = 0;

  async function worker() {
    // 첫 번째 청크 미리 읽기
    if (idx >= totalParts) return;
    let partIdx = idx++;
    let buf = await readChunk(fd, partIdx * chunkBytes, Math.min(chunkBytes, fileSize - partIdx * chunkBytes));

    while (true) {
      const currentPartIdx = partIdx;
      const currentBuf     = buf;
      const partNumber     = currentPartIdx + 1;
      const url            = presignedUrls[partNumber];

      // 현재 청크 PUT과 다음 청크 디스크 읽기를 동시에 실행
      const nextPartIdx = idx < totalParts ? idx++ : -1;
      const [etag] = await Promise.all([
        putPart(url, currentBuf),
        nextPartIdx >= 0
          ? readChunk(fd, nextPartIdx * chunkBytes, Math.min(chunkBytes, fileSize - nextPartIdx * chunkBytes))
              .then(b => { buf = b; partIdx = nextPartIdx; })
          : Promise.resolve(),
      ]);

      etags[currentPartIdx] = { PartNumber: partNumber, ETag: etag };
      process.stdout.write(`\r  파트 ${++done}/${totalParts} 완료`);

      if (nextPartIdx < 0) break;
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  fs.closeSync(fd);
  console.log();

  // 5. 완료
  const resp = await post('/multipart/complete', {
    uploadId,
    key,
    parts: etags,
  });

  return { key, location: resp.location };
}

// ── 오브젝트 삭제 (백엔드 delete 엔드포인트 호출) ────────────────────────────

async function deleteFromStorage(key) {
  try {
    await post('/multipart/delete', { key });
  } catch {
    // delete 엔드포인트 없으면 무시 — 수동 삭제 필요
  }
  console.log(`  삭제 요청: ${key}`);
}

// ── 메인 벤치마크 루프 ────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`파일을 찾을 수 없습니다: ${FILE_PATH}`);
    process.exit(1);
  }

  const fileSize = statSync(FILE_PATH).size;
  const fileSizeMB = (fileSize / 1e6).toFixed(1);
  const total = CHUNK_SIZES_MB.length * CONCURRENCIES.length;

  console.log(`파일: ${path.basename(FILE_PATH)} (${fileSizeMB} MB)`);
  console.log(`총 ${total}개 조합 테스트 시작\n`);

  const results = [];
  let done = 0;

  for (const chunkMB of CHUNK_SIZES_MB) {
    for (const concurrency of CONCURRENCIES) {
      done++;
      const totalParts = Math.ceil(fileSize / (chunkMB * 1024 * 1024));
      console.log(`[${done}/${total}] 청크 ${chunkMB}MB × 동시 ${concurrency}개 (파트 ${totalParts}개)`);

      const startMs = performance.now();
      let status = 'success';
      let key = null;

      try {
        const result = await runUpload(FILE_PATH, chunkMB, concurrency);
        key = result.key;
      } catch (err) {
        status = 'error';
        console.error(`  오류: ${err.message}`);
      }

      const elapsedSec = ((performance.now() - startMs) / 1000).toFixed(2);
      const speedMBs   = status === 'success'
        ? (fileSize / 1e6 / parseFloat(elapsedSec)).toFixed(1)
        : '-';

      console.log(`  → ${elapsedSec}초 / ${speedMBs} MB/s\n`);

      results.push({
        chunkMB, concurrency, totalParts,
        fileSizeMB, elapsedSec, speedMBs, status,
        time: new Date().toLocaleString('ko-KR'),
      });

      // 업로드 성공 시 스토리지에서 삭제
      if (key) await deleteFromStorage(key);

      // 결과를 즉시 파일에 기록 (중간에 중단돼도 보존)
      writeCSV(results);
    }
  }

  console.log(`\n완료! 결과 파일: ${csvFilename()}`);
}

// ── CSV 출력 ─────────────────────────────────────────────────────────────────

function csvFilename() {
  return `benchmark_results_${new Date().toISOString().slice(0, 10)}.csv`;
}

function writeCSV(results) {
  const header = ['청크(MB)', '동시업로드', '파트수', '파일크기(MB)', '소요시간(초)', '평균속도(MB/s)', '결과', '시각'];
  const rows = results.map(r =>
    [r.chunkMB, r.concurrency, r.totalParts, r.fileSizeMB, r.elapsedSec, r.speedMBs, r.status, r.time]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );
  const csv = '\uFEFF' + [header.join(','), ...rows].join('\n');
  fs.writeFileSync(csvFilename(), csv, 'utf8');
}

main().catch(err => {
  console.error('예기치 않은 오류:', err);
  process.exit(1);
});
