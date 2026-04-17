package com.example.localupload.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.*;
import java.nio.MappedByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Memory-Mapped File 방식 — OS가 메모리 주소에 파일을 직접 매핑
 * JVM 버퍼 복사 없이 OS 레벨에서 write 최적화
 * offset 방식과 동일하게 청크를 파트 위치에 직접 쓰되, MappedByteBuffer 사용
 */
@Slf4j
@Service
public class LocalUploadMmapService {

    @Value("${upload.dir}")
    private String uploadDir;

    private final Map<String, MmapSession> sessions = new ConcurrentHashMap<>();

    // MappedByteBuffer는 int 범위(2GB) 제한이 있으므로 청크별로 개별 매핑
    private record MmapSession(Path finalFile, FileChannel channel, long chunkSize) {}

    // ── 1. 세션 초기화 ────────────────────────────────────────────────────────────

    public String init(String filename, long totalSize, long chunkSize) throws IOException {
        String uploadId = UUID.randomUUID().toString();

        Path finalDir = Path.of(uploadDir, "completed");
        Files.createDirectories(finalDir);
        Path finalFile = finalDir.resolve(uploadId + "_" + sanitize(filename));

        FileChannel channel = FileChannel.open(finalFile,
                StandardOpenOption.CREATE, StandardOpenOption.READ, StandardOpenOption.WRITE);
        channel.write(java.nio.ByteBuffer.allocate(1), totalSize - 1); // 파일 크기 예약

        sessions.put(uploadId, new MmapSession(finalFile, channel, chunkSize));
        log.info("MmapUpload init: uploadId={}, file={}, size={}MB", uploadId, filename, totalSize / 1_000_000);
        return uploadId;
    }

    // ── 2. 청크 → 청크 범위만 개별 mmap으로 write ────────────────────────────────

    public void saveChunk(String uploadId, int partNumber, MultipartFile chunk) throws IOException {
        MmapSession session = sessions.get(uploadId);
        if (session == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);

        long offset = (long)(partNumber - 1) * session.chunkSize();
        byte[] data = chunk.getBytes();

        // 청크 범위만 매핑 — int 범위 제한 우회
        MappedByteBuffer buf = session.channel().map(FileChannel.MapMode.READ_WRITE, offset, data.length);
        buf.put(data);
        buf.force();
        log.debug("MmapUpload chunk written: part={}, offset={}", partNumber, offset);
    }

    // ── 3. 완료 — channel 닫기 ────────────────────────────────────────────────────

    public Path complete(String uploadId) throws IOException {
        MmapSession session = sessions.remove(uploadId);
        if (session == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);

        session.channel().close();

        log.info("MmapUpload complete: file={}, size={}MB",
                session.finalFile().getFileName(), Files.size(session.finalFile()) / 1_000_000);
        return session.finalFile();
    }

    // ── 4. 중단 ───────────────────────────────────────────────────────────────────

    public void abort(String uploadId) throws IOException {
        MmapSession session = sessions.remove(uploadId);
        if (session != null) {
            session.channel().close();
            Files.deleteIfExists(session.finalFile());
            log.info("MmapUpload aborted: uploadId={}", uploadId);
        }
    }

    // ── 5. 완료 파일 삭제 (벤치마크용) ───────────────────────────────────────────

    public void deleteCompleted(String location) throws IOException {
        Files.deleteIfExists(Path.of(location));
        log.info("MmapUpload file deleted: {}", location);
    }

    private String sanitize(String filename) {
        return filename.replaceAll("[/\\\\]", "_").replaceAll("\\.\\.", "_");
    }
}
