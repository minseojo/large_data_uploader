package com.example.localupload.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.*;
import java.nio.file.*;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 청킹 없이 단일 스트림으로 수신 — multipart 파싱 오버헤드 없음
 * 클라이언트가 raw binary body로 전체 파일을 한 번에 전송
 */
@Slf4j
@Service
public class LocalUploadStreamService {

    @Value("${upload.dir}")
    private String uploadDir;

    private final Map<String, Path> sessions = new ConcurrentHashMap<>();

    // ── 1. 세션 초기화 ────────────────────────────────────────────────────────────

    public String init(String filename) throws IOException {
        String uploadId = UUID.randomUUID().toString();
        Path finalDir = Path.of(uploadDir, "completed");
        Files.createDirectories(finalDir);
        Path finalFile = finalDir.resolve(uploadId + "_" + sanitize(filename));
        sessions.put(uploadId, finalFile);
        log.info("StreamUpload init: uploadId={}, file={}", uploadId, filename);
        return uploadId;
    }

    // ── 2. 스트림 수신 → 파일에 직접 write ───────────────────────────────────────

    public void receiveStream(String uploadId, InputStream inputStream, long contentLength) throws IOException {
        Path finalFile = sessions.get(uploadId);
        if (finalFile == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);

        try (OutputStream out = new BufferedOutputStream(Files.newOutputStream(finalFile), 8 * 1024 * 1024)) {
            inputStream.transferTo(out);
        }
        log.info("StreamUpload done: file={}, size={}MB", finalFile.getFileName(), contentLength / 1_000_000);
    }

    // ── 3. 완료 ───────────────────────────────────────────────────────────────────

    public Path complete(String uploadId) {
        Path finalFile = sessions.remove(uploadId);
        if (finalFile == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);
        return finalFile;
    }

    // ── 4. 중단 ───────────────────────────────────────────────────────────────────

    public void abort(String uploadId) throws IOException {
        Path finalFile = sessions.remove(uploadId);
        if (finalFile != null) {
            Files.deleteIfExists(finalFile);
            log.info("StreamUpload aborted: uploadId={}", uploadId);
        }
    }

    // ── 5. 완료 파일 삭제 (벤치마크용) ───────────────────────────────────────────

    public void deleteCompleted(String location) throws IOException {
        Files.deleteIfExists(Path.of(location));
        log.info("StreamUpload file deleted: {}", location);
    }

    private String sanitize(String filename) {
        return filename.replaceAll("[/\\\\]", "_").replaceAll("\\.\\.", "_");
    }
}
