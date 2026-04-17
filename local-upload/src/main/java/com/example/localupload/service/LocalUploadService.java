package com.example.localupload.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.*;
import java.nio.file.*;
import java.util.Comparator;
import java.util.UUID;
import java.util.stream.Stream;

@Slf4j
@Service
public class LocalUploadService {

    @Value("${upload.dir}")
    private String uploadDir;

    // ── 1. 업로드 세션 초기화 ──────────────────────────────────────────────────

    public String init(String filename) throws IOException {
        String uploadId = UUID.randomUUID().toString();
        Path chunkDir = chunkDir(uploadId);
        Files.createDirectories(chunkDir);

        // 원본 파일명 저장 (complete 시 사용)
        Files.writeString(chunkDir.resolve(".filename"), filename);

        log.info("Upload init: uploadId={}, filename={}", uploadId, filename);
        return uploadId;
    }

    // ── 2. 청크 수신 및 임시 저장 ──────────────────────────────────────────────

    public void saveChunk(String uploadId, int partNumber, MultipartFile chunk) throws IOException {
        Path chunkFile = chunkDir(uploadId).resolve(String.format("%05d", partNumber));
        try (InputStream in = chunk.getInputStream();
             OutputStream out = Files.newOutputStream(chunkFile)) {
            in.transferTo(out);
        }
        log.debug("Chunk saved: uploadId={}, part={}, size={}", uploadId, partNumber, chunk.getSize());
    }

    // ── 3. 청크 병합 → 최종 파일 ──────────────────────────────────────────────

    public Path complete(String uploadId) throws IOException {
        Path chunkDir = chunkDir(uploadId);
        String filename = Files.readString(chunkDir.resolve(".filename")).trim();

        Path finalDir  = Path.of(uploadDir, "completed");
        Files.createDirectories(finalDir);
        Path finalFile = finalDir.resolve(uploadId + "_" + filename);

        // 파트 번호 순서대로 병합
        try (OutputStream out = new BufferedOutputStream(Files.newOutputStream(finalFile), 8 * 1024 * 1024)) {
            try (Stream<Path> parts = Files.list(chunkDir)
                    .filter(p -> !p.getFileName().toString().startsWith("."))
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))) {
                for (Path part : (Iterable<Path>) parts::iterator) {
                    Files.copy(part, out);
                }
            }
        }

        log.info("Upload complete: file={}, size={}MB", finalFile.getFileName(),
                Files.size(finalFile) / 1_000_000);

        // 임시 청크 디렉토리 삭제
        deleteDir(chunkDir);

        return finalFile;
    }

    // ── 4. 업로드 중단 및 임시 파일 정리 ──────────────────────────────────────

    public void abort(String uploadId) throws IOException {
        Path chunkDir = chunkDir(uploadId);
        if (Files.exists(chunkDir)) {
            deleteDir(chunkDir);
            log.info("Upload aborted: uploadId={}", uploadId);
        }
    }

    // ── 5. 완료된 파일 삭제 (벤치마크용) ──────────────────────────────────────

    public void deleteCompleted(String location) throws IOException {
        Path file = Path.of(location);
        if (Files.exists(file)) {
            Files.delete(file);
            log.info("Completed file deleted: {}", file);
        }
    }

    // ── 내부 유틸 ─────────────────────────────────────────────────────────────

    private Path chunkDir(String uploadId) {
        return Path.of(uploadDir, "chunks", uploadId);
    }

    private void deleteDir(Path dir) throws IOException {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder())
                .forEach(p -> {
                    try { Files.delete(p); }
                    catch (IOException e) { log.warn("Delete failed: {}", p); }
                });
        }
    }
}
