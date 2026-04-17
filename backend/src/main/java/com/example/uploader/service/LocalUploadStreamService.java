package com.example.uploader.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.*;
import java.nio.file.*;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Service
public class LocalUploadStreamService {

    @Value("${upload.dir}")
    private String uploadDir;

    private final Map<String, Path> sessions = new ConcurrentHashMap<>();

    public String init(String filename) throws IOException {
        String uploadId = UUID.randomUUID().toString();
        Path finalDir = Path.of(uploadDir, "completed");
        Files.createDirectories(finalDir);
        Path finalFile = finalDir.resolve(uploadId + "_" + sanitize(filename));
        sessions.put(uploadId, finalFile);
        log.info("StreamUpload init: uploadId={}, filename={}", uploadId, filename);
        return uploadId;
    }

    public void receiveStream(String uploadId, InputStream inputStream, long contentLength) throws IOException {
        Path finalFile = sessions.get(uploadId);
        if (finalFile == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);

        try (OutputStream out = new BufferedOutputStream(Files.newOutputStream(finalFile), 8 * 1024 * 1024)) {
            inputStream.transferTo(out);
        }
        log.info("StreamUpload received: file={}, size={}MB", finalFile.getFileName(), contentLength / 1_000_000);
    }

    public Path complete(String uploadId) throws IOException {
        Path finalFile = sessions.remove(uploadId);
        if (finalFile == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);
        log.info("StreamUpload complete: file={}, size={}MB",
                finalFile.getFileName(), Files.size(finalFile) / 1_000_000);
        return finalFile;
    }

    public void abort(String uploadId) throws IOException {
        Path finalFile = sessions.remove(uploadId);
        if (finalFile != null) {
            Files.deleteIfExists(finalFile);
            log.info("StreamUpload aborted: uploadId={}", uploadId);
        }
    }

    public void deleteCompleted(String location) throws IOException {
        Files.deleteIfExists(Path.of(location));
        log.info("StreamUpload file deleted: {}", location);
    }

    private String sanitize(String filename) {
        return filename.replaceAll("[/\\\\]", "_").replaceAll("\\.\\.", "_");
    }
}
