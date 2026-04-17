package com.example.localupload.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.*;
import java.nio.file.*;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Service
public class LocalUploadService {

    @Value("${upload.dir}")
    private String uploadDir;

    private final Map<String, UploadSession> sessions = new ConcurrentHashMap<>();

    private record UploadSession(Path finalFile, RandomAccessFile raf, long chunkSize) {}

    // ── 1. 세션 초기화 — 파일 미리 할당 + RAF 열어두기 ───────────────────────────

    public String init(String filename, long totalSize, long chunkSize) throws IOException {
        String uploadId = UUID.randomUUID().toString();

        Path finalDir = Path.of(uploadDir, "completed");
        Files.createDirectories(finalDir);
        Path finalFile = finalDir.resolve(uploadId + "_" + sanitize(filename));

        // RAF를 열어두고 세션에 보관 — 청크마다 open/close 오버헤드 제거
        RandomAccessFile raf = new RandomAccessFile(finalFile.toFile(), "rw");
        raf.setLength(totalSize);

        sessions.put(uploadId, new UploadSession(finalFile, raf, chunkSize));
        log.info("Upload init: uploadId={}, file={}, size={}MB", uploadId, filename, totalSize / 1_000_000);
        return uploadId;
    }

    // ── 2. 청크 수신 → 파트 offset에 직접 write ──────────────────────────────────

    public void saveChunk(String uploadId, int partNumber, MultipartFile chunk) throws IOException {
        UploadSession session = sessions.get(uploadId);
        if (session == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);

        long offset = (long)(partNumber - 1) * session.chunkSize();
        byte[] data = chunk.getBytes();

        // RAF는 seek+write가 thread-safe하지 않으므로 세션 객체로 동기화
        synchronized (session.raf()) {
            session.raf().seek(offset);
            session.raf().write(data);
        }
        log.debug("Chunk written: part={}, offset={}, size={}", partNumber, offset, data.length);
    }

    // ── 3. 완료 — RAF 닫기 ────────────────────────────────────────────────────────

    public Path complete(String uploadId) throws IOException {
        UploadSession session = sessions.remove(uploadId);
        if (session == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);
        session.raf().close();
        log.info("Upload complete: file={}, size={}MB",
                session.finalFile().getFileName(), Files.size(session.finalFile()) / 1_000_000);
        return session.finalFile();
    }

    // ── 4. 중단 — RAF 닫고 파일 삭제 ──────────────────────────────────────────────

    public void abort(String uploadId) throws IOException {
        UploadSession session = sessions.remove(uploadId);
        if (session != null) {
            session.raf().close();
            Files.deleteIfExists(session.finalFile());
            log.info("Upload aborted: uploadId={}", uploadId);
        }
    }

    // ── 5. 완료 파일 삭제 (벤치마크용) ────────────────────────────────────────────

    public void deleteCompleted(String location) throws IOException {
        Files.deleteIfExists(Path.of(location));
        log.info("Completed file deleted: {}", location);
    }

    // ── 내부 유틸 ──────────────────────────────────────────────────────────────────

    private String sanitize(String filename) {
        return filename.replaceAll("[/\\\\]", "_").replaceAll("\\.\\.", "_");
    }
}
