/**
 * benchmark.mjs
 * 청크 크기 × 동시 업로드 수 모든 조합으로 멀티파트 업로드 성능 측정
 *
 * 사용법:
 *   node benchmark.mjs           → S3 멀티파트 (SeaweedFS)
 *   node benchmark.mjs local     → Spring Boot 로컬 디스크
 *   node benchmark.mjs both      → 두 방식 순서대로 비교
 *
 * 결과: benchmark_results_<날짜>.csv
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { statSync } from 'fs';

// ── 설정 ──────────────────────────────────────────────────────────────────────

const FILE_PATH        = '/path/to/your/large-file.';
const BASE_URL         = 'http://localhost:8080';
const S3_URL           = `${BASE_URL}/api/upload`;
const LOCAL_URL        = `${BASE_URL}/api/local/upload`;
const LOCAL_SEQ_URL    = `${BASE_URL}/api/local/upload-seq`;
const LOCAL_STREAM_URL = `${BASE_URL}/api/local/upload-stream`;
const LOCAL_MMAP_URL   = `${BASE_URL}/api/local/upload-mmap`;
const MODE        = process.argv[2] ?? 's3'; // 's3' | 'local' | 'local-seq' | 'local-stream' | 'local-mmap' | 'both'

// 청크크기/동시성 비교 테스트
const CHUNK_SIZES_MB = [16, 32, 64, 128];
const CONCURRENCIES  = [1, 2, 4, 8, 16];

// ── HTTP 유틸 ─────────────────────────────────────────────────────────────────

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
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${data}`)); return; }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
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
      headers:  { 'Content-Length': buffer.length, 'Content-Type': 'application/octet-stream' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`PUT ${res.statusCode}: ${data}`)); return; }
        resolve(res.headers['etag']?.replace(/"/g, '') ?? '');
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// multipart/form-data로 청크 POST (로컬 업로드용)
function postChunk(url, buffer, filename) {
  return new Promise((resolve, reject) => {
    const boundary = `----Boundary${Date.now()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`POST ${res.statusCode}: ${data}`)); return; }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postJson(baseUrl, p, body) {
  return fetchJson(`${baseUrl}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, body);
}

// ── 청크 읽기 ─────────────────────────────────────────────────────────────────

function readChunk(fd, offset, size) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.allocUnsafe(size);
    fs.read(fd, buf, 0, size, offset, (err, bytesRead) => {
      if (err) reject(err);
      else resolve(bytesRead < size ? buf.subarray(0, bytesRead) : buf);
    });
  });
}

// ── S3 멀티파트 업로드 ────────────────────────────────────────────────────────

async function runS3Upload(filePath, chunkMB, concurrency) {
  const chunkBytes = chunkMB * 1024 * 1024;
  const fileSize   = statSync(filePath).size;
  const fileName   = path.basename(filePath);
  const totalParts = Math.ceil(fileSize / chunkBytes);

  const { uploadId, key } = await postJson(S3_URL, '/multipart/create', {
    filename: fileName, contentType: 'application/octet-stream', size: fileSize,
  });

  // Presigned URL 배치 발급 (100개씩)
  const presignedUrls = {};
  const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1);
  for (let i = 0; i < partNumbers.length; i += 100) {
    const resp = await postJson(S3_URL, '/multipart/sign-parts', {
      uploadId, key, partNumbers: partNumbers.slice(i, i + 100),
    });
    Object.assign(presignedUrls, resp.presignedUrls ?? resp);
  }

  const fd = fs.openSync(filePath, 'r');
  const etags = new Array(totalParts);
  let idx = 0, done = 0;

  async function worker() {
    if (idx >= totalParts) return;
    let partIdx = idx++;
    let buf = await readChunk(fd, partIdx * chunkBytes, Math.min(chunkBytes, fileSize - partIdx * chunkBytes));

    while (true) {
      const curIdx = partIdx, curBuf = buf, partNumber = curIdx + 1;
      const nextIdx = idx < totalParts ? idx++ : -1;
      const [etag] = await Promise.all([
        putPart(presignedUrls[partNumber], curBuf),
        nextIdx >= 0
          ? readChunk(fd, nextIdx * chunkBytes, Math.min(chunkBytes, fileSize - nextIdx * chunkBytes))
              .then(b => { buf = b; partIdx = nextIdx; })
          : Promise.resolve(),
      ]);
      etags[curIdx] = { PartNumber: partNumber, ETag: etag };
      process.stdout.write(`\r  파트 ${++done}/${totalParts} 완료`);
      if (nextIdx < 0) break;
    }
  }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  fs.closeSync(fd);
  console.log();
  const transferMs = performance.now() - t0;

  const t1 = performance.now();
  const resp = await postJson(S3_URL, '/multipart/complete', { uploadId, key, parts: etags });
  const completeMs = performance.now() - t1;

  await postJson(S3_URL, '/multipart/delete', { key }).catch(() => {});
  console.log(`  삭제: ${key}`);

  return { transferMs, completeMs, location: resp.location };
}

// ── 로컬 디스크 업로드 ────────────────────────────────────────────────────────

async function runLocalUpload(filePath, chunkMB, concurrency) {
  const chunkBytes = chunkMB * 1024 * 1024;
  const fileSize   = statSync(filePath).size;
  const fileName   = path.basename(filePath);
  const totalParts = Math.ceil(fileSize / chunkBytes);

  const { uploadId } = await postJson(LOCAL_URL, '/init', {
    filename: fileName, totalSize: fileSize, chunkSize: chunkBytes,
  });

  const fd = fs.openSync(filePath, 'r');
  let idx = 0, done = 0;

  async function worker() {
    while (idx < totalParts) {
      const partIdx    = idx++;
      const partNumber = partIdx + 1;
      const offset     = partIdx * chunkBytes;
      const size       = Math.min(chunkBytes, fileSize - offset);
      const buf        = await readChunk(fd, offset, size);
      await postChunk(
        `${LOCAL_URL}/chunk?uploadId=${uploadId}&partNumber=${partNumber}`,
        buf, fileName
      );
      process.stdout.write(`\r  파트 ${++done}/${totalParts} 완료`);
    }
  }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  fs.closeSync(fd);
  console.log();
  const transferMs = performance.now() - t0;

  const t1 = performance.now();
  const resp = await postJson(LOCAL_URL, '/complete', { uploadId });
  const completeMs = performance.now() - t1;

  await postJson(LOCAL_URL, '/delete', { location: resp.location }).catch(() => {});
  console.log(`  삭제: ${resp.location}`);

  return { transferMs, completeMs, location: resp.location };
}

// ── 로컬 순차 병합 업로드 ─────────────────────────────────────────────────────

async function runLocalSeqUpload(filePath, chunkMB, concurrency) {
  const chunkBytes = chunkMB * 1024 * 1024;
  const fileSize   = statSync(filePath).size;
  const fileName   = path.basename(filePath);
  const totalParts = Math.ceil(fileSize / chunkBytes);

  const { uploadId } = await postJson(LOCAL_SEQ_URL, '/init', { filename: fileName });

  const fd = fs.openSync(filePath, 'r');
  let idx = 0, done = 0;

  async function worker() {
    while (idx < totalParts) {
      const partIdx    = idx++;
      const partNumber = partIdx + 1;
      const offset     = partIdx * chunkBytes;
      const size       = Math.min(chunkBytes, fileSize - offset);
      const buf        = await readChunk(fd, offset, size);
      await postChunk(
        `${LOCAL_SEQ_URL}/chunk?uploadId=${uploadId}&partNumber=${partNumber}`,
        buf, fileName
      );
      process.stdout.write(`\r  파트 ${++done}/${totalParts} 완료`);
    }
  }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  fs.closeSync(fd);
  console.log();
  const transferMs = performance.now() - t0;

  const t1 = performance.now();
  const resp = await postJson(LOCAL_SEQ_URL, '/complete', { uploadId });
  const completeMs = performance.now() - t1;

  await postJson(LOCAL_SEQ_URL, '/delete', { location: resp.location }).catch(() => {});
  console.log(`  삭제: ${resp.location}`);

  return { transferMs, completeMs, location: resp.location };
}

// ── 로컬 스트림 업로드 (청킹 없이 단일 전송) ──────────────────────────────────

async function runLocalStreamUpload(filePath, chunkMB, concurrency) {
  // stream은 청킹/동시성 파라미터 무관 — 단일 스트림으로 전송
  const fileSize = statSync(filePath).size;
  const fileName = path.basename(filePath);

  const { uploadId } = await postJson(LOCAL_STREAM_URL, '/init', { filename: fileName });

  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const parsed = new URL(`${LOCAL_STREAM_URL}/send?uploadId=${uploadId}`);
    const req = http.request({
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/octet-stream', 'Content-Length': fileSize },
    }, res => {
      res.on('data', () => {});
      res.on('end', () => res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve());
    });
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(req);
  });
  process.stdout.write(`\r  전송 완료`);
  console.log();
  const transferMs = performance.now() - t0;

  const t1 = performance.now();
  const resp = await postJson(LOCAL_STREAM_URL, '/complete', { uploadId });
  const completeMs = performance.now() - t1;

  await postJson(LOCAL_STREAM_URL, '/delete', { location: resp.location }).catch(() => {});
  console.log(`  삭제: ${resp.location}`);

  return { transferMs, completeMs, location: resp.location };
}

// ── 로컬 mmap 업로드 ──────────────────────────────────────────────────────────

async function runLocalMmapUpload(filePath, chunkMB, concurrency) {
  const chunkBytes = chunkMB * 1024 * 1024;
  const fileSize   = statSync(filePath).size;
  const fileName   = path.basename(filePath);
  const totalParts = Math.ceil(fileSize / chunkBytes);

  const { uploadId } = await postJson(LOCAL_MMAP_URL, '/init', {
    filename: fileName, totalSize: fileSize, chunkSize: chunkBytes,
  });

  const fd = fs.openSync(filePath, 'r');
  let idx = 0, done = 0;

  async function worker() {
    while (idx < totalParts) {
      const partIdx    = idx++;
      const partNumber = partIdx + 1;
      const offset     = partIdx * chunkBytes;
      const size       = Math.min(chunkBytes, fileSize - offset);
      const buf        = await readChunk(fd, offset, size);
      await postChunk(`${LOCAL_MMAP_URL}/chunk?uploadId=${uploadId}&partNumber=${partNumber}`, buf, fileName);
      process.stdout.write(`\r  파트 ${++done}/${totalParts} 완료`);
    }
  }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  fs.closeSync(fd);
  console.log();
  const transferMs = performance.now() - t0;

  const t1 = performance.now();
  const resp = await postJson(LOCAL_MMAP_URL, '/complete', { uploadId });
  const completeMs = performance.now() - t1;

  await postJson(LOCAL_MMAP_URL, '/delete', { location: resp.location }).catch(() => {});
  console.log(`  삭제: ${resp.location}`);

  return { transferMs, completeMs, location: resp.location };
}

// ── 벤치마크 루프 ─────────────────────────────────────────────────────────────

async function runBenchmark(label, uploadFn) {
  const fileSize   = statSync(FILE_PATH).size;
  const fileSizeMB = (fileSize / 1e6).toFixed(1);
  const total      = CHUNK_SIZES_MB.length * CONCURRENCIES.length;
  const results    = [];
  let seq = 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${label}] 파일: ${path.basename(FILE_PATH)} (${fileSizeMB} MB)`);
  console.log(`총 ${total}개 조합\n`);

  for (const chunkMB of CHUNK_SIZES_MB) {
    for (const concurrency of CONCURRENCIES) {
      seq++;
      const totalParts = Math.ceil(fileSize / (chunkMB * 1024 * 1024));
      console.log(`[${seq}/${total}] 청크 ${chunkMB}MB × 동시 ${concurrency}개 (파트 ${totalParts}개)`);

      let status = 'success';
      let transferSec = '-', completeSec = '-', totalSec = '-', speedMBs = '-';

      try {
        const t0 = performance.now();
        const { transferMs, completeMs } = await uploadFn(FILE_PATH, chunkMB, concurrency);
        const t1 = performance.now();
        transferSec = (transferMs / 1000).toFixed(2);
        completeSec = (completeMs / 1000).toFixed(2);
        totalSec    = ((t1 - t0) / 1000).toFixed(2);
        speedMBs    = (fileSize / 1e6 / parseFloat(transferSec)).toFixed(1);
      } catch (err) {
        status = 'error';
        console.error(`  오류: ${err.message || err}`);
        console.error(err.stack);
      }

      console.log(`  → 전송 ${transferSec}초 / 병합 ${completeSec}초 / 합계 ${totalSec}초 / ${speedMBs} MB/s\n`);

      const record = {
        mode: label, chunkMB, concurrency, totalParts,
        fileSizeMB, transferSec, completeSec, totalSec, speedMBs, status,
        time: new Date().toLocaleString('ko-KR'),
      };
      results.push(record);
      appendCSV(record);
    }
  }

  return results;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`파일을 찾을 수 없습니다: ${FILE_PATH}`);
    process.exit(1);
  }

  let results = [];

  if (MODE === 's3' || MODE === 'both') {
    results = results.concat(await runBenchmark('S3-Multipart', runS3Upload));
  }
  if (MODE === 'local' || MODE === 'both') {
    results = results.concat(await runBenchmark('Local-Offset', runLocalUpload));
  }
  if (MODE === 'local-seq' || MODE === 'both') {
    results = results.concat(await runBenchmark('Local-Seq', runLocalSeqUpload));
  }
  if (MODE === 'local-stream' || MODE === 'both') {
    results = results.concat(await runBenchmark('Local-Stream', runLocalStreamUpload));
  }
  if (MODE === 'local-mmap' || MODE === 'both') {
    results = results.concat(await runBenchmark('Local-Mmap', runLocalMmapUpload));
  }

  console.log(`\n완료! 결과 파일: ${csvFilename()}`);
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function csvFilename() {
  return `benchmark_results_${new Date().toISOString().slice(0, 10)}.csv`;
}

const HEADER = ['방식', '청크(MB)', '동시업로드', '파트수', '파일크기(MB)', '전송시간(초)', '병합시간(초)', '합계시간(초)', '평균속도(MB/s)', '결과', '시각'];

function appendCSV(record) {
  const file = csvFilename();
  const row = [
    record.mode, record.chunkMB, record.concurrency, record.totalParts,
    record.fileSizeMB, record.transferSec, record.completeSec, record.totalSec,
    record.speedMBs, record.status, record.time,
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '\uFEFF' + HEADER.join(',') + '\n', 'utf8');
  }
  fs.appendFileSync(file, row + '\n', 'utf8');
}

main().catch(err => {
  console.error('예기치 않은 오류:', err);
  process.exit(1);
});
