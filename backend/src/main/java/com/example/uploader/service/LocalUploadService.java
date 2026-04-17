package com.example.uploader.service;

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

    public String init(String filename, long totalSize, long chunkSize) throws IOException {
        String uploadId = UUID.randomUUID().toString();

        Path finalDir = Path.of(uploadDir, "completed");
        Files.createDirectories(finalDir);
        Path finalFile = finalDir.resolve(uploadId + "_" + sanitize(filename));

        RandomAccessFile raf = new RandomAccessFile(finalFile.toFile(), "rw");
        raf.setLength(totalSize);

        sessions.put(uploadId, new UploadSession(finalFile, raf, chunkSize));
        log.info("Upload init: uploadId={}, file={}, size={}MB", uploadId, filename, totalSize / 1_000_000);
        return uploadId;
    }

    public void saveChunk(String uploadId, int partNumber, MultipartFile chunk) throws IOException {
        UploadSession session = sessions.get(uploadId);
        if (session == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);

        long offset = (long)(partNumber - 1) * session.chunkSize();
        byte[] data = chunk.getBytes();

        synchronized (session.raf()) {
            session.raf().seek(offset);
            session.raf().write(data);
        }
        log.debug("Chunk written: part={}, offset={}, size={}", partNumber, offset, data.length);
    }

    public Path complete(String uploadId) throws IOException {
        UploadSession session = sessions.remove(uploadId);
        if (session == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);
        session.raf().close();
        log.info("Upload complete: file={}, size={}MB",
                session.finalFile().getFileName(), Files.size(session.finalFile()) / 1_000_000);
        return session.finalFile();
    }

    public void abort(String uploadId) throws IOException {
        UploadSession session = sessions.remove(uploadId);
        if (session != null) {
            session.raf().close();
            Files.deleteIfExists(session.finalFile());
            log.info("Upload aborted: uploadId={}", uploadId);
        }
    }

    public void deleteCompleted(String location) throws IOException {
        Files.deleteIfExists(Path.of(location));
        log.info("Completed file deleted: {}", location);
    }

    private String sanitize(String filename) {
        return filename.replaceAll("[/\\\\]", "_").replaceAll("\\.\\.", "_");
    }
}
