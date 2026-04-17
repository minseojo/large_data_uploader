package com.example.uploader.service;

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
public class LocalUploadSeqService {

    @Value("${upload.dir}")
    private String uploadDir;

    public String init(String filename) throws IOException {
        String uploadId = UUID.randomUUID().toString();
        Path chunkDir = chunkDir(uploadId);
        Files.createDirectories(chunkDir);
        Files.writeString(chunkDir.resolve(".filename"), filename);
        log.info("SeqUpload init: uploadId={}, filename={}", uploadId, filename);
        return uploadId;
    }

    public void saveChunk(String uploadId, int partNumber, MultipartFile chunk) throws IOException {
        Path chunkFile = chunkDir(uploadId).resolve(String.format("%05d", partNumber));
        try (InputStream in = chunk.getInputStream();
             OutputStream out = new BufferedOutputStream(Files.newOutputStream(chunkFile))) {
            in.transferTo(out);
        }
        log.debug("SeqUpload chunk saved: part={}, size={}", partNumber, chunk.getSize());
    }

    public Path complete(String uploadId) throws IOException {
        Path chunkDir = chunkDir(uploadId);
        String filename = Files.readString(chunkDir.resolve(".filename")).trim();

        Path finalDir  = Path.of(uploadDir, "completed");
        Files.createDirectories(finalDir);
        Path finalFile = finalDir.resolve(uploadId + "_" + sanitize(filename));

        try (OutputStream out = new BufferedOutputStream(Files.newOutputStream(finalFile), 8 * 1024 * 1024)) {
            try (Stream<Path> parts = Files.list(chunkDir)
                    .filter(p -> !p.getFileName().toString().startsWith("."))
                    .sorted(Comparator.comparing(p -> p.getFileName().toString()))) {
                for (Path part : (Iterable<Path>) parts::iterator) {
                    Files.copy(part, out);
                }
            }
        }

        log.info("SeqUpload complete: file={}, size={}MB",
                finalFile.getFileName(), Files.size(finalFile) / 1_000_000);

        deleteDir(chunkDir);
        return finalFile;
    }

    public void abort(String uploadId) throws IOException {
        Path chunkDir = chunkDir(uploadId);
        if (Files.exists(chunkDir)) {
            deleteDir(chunkDir);
            log.info("SeqUpload aborted: uploadId={}", uploadId);
        }
    }

    public void deleteCompleted(String location) throws IOException {
        Files.deleteIfExists(Path.of(location));
        log.info("SeqUpload file deleted: {}", location);
    }

    private Path chunkDir(String uploadId) {
        return Path.of(uploadDir, "seq-chunks", uploadId);
    }

    private String sanitize(String filename) {
        return filename.replaceAll("[/\\\\]", "_").replaceAll("\\.\\.", "_");
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
