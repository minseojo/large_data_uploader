package com.example.uploader.service;

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

@Slf4j
@Service
public class LocalUploadMmapService {

    @Value("${upload.dir}")
    private String uploadDir;

    private final Map<String, MmapSession> sessions = new ConcurrentHashMap<>();

    private record MmapSession(Path finalFile, FileChannel channel, long chunkSize) {}

    public String init(String filename, long totalSize, long chunkSize) throws IOException {
        String uploadId = UUID.randomUUID().toString();

        Path finalDir = Path.of(uploadDir, "completed");
        Files.createDirectories(finalDir);
        Path finalFile = finalDir.resolve(uploadId + "_" + sanitize(filename));

        FileChannel channel = FileChannel.open(finalFile,
                StandardOpenOption.CREATE, StandardOpenOption.READ, StandardOpenOption.WRITE);
        channel.write(java.nio.ByteBuffer.allocate(1), totalSize - 1);

        sessions.put(uploadId, new MmapSession(finalFile, channel, chunkSize));
        log.info("MmapUpload init: uploadId={}, file={}, size={}MB", uploadId, filename, totalSize / 1_000_000);
        return uploadId;
    }

    public void saveChunk(String uploadId, int partNumber, MultipartFile chunk) throws IOException {
        MmapSession session = sessions.get(uploadId);
        if (session == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);

        long offset = (long)(partNumber - 1) * session.chunkSize();
        byte[] data = chunk.getBytes();

        MappedByteBuffer buf = session.channel().map(FileChannel.MapMode.READ_WRITE, offset, data.length);
        buf.put(data);
        buf.force();
        log.debug("MmapUpload chunk written: part={}, offset={}", partNumber, offset);
    }

    public Path complete(String uploadId) throws IOException {
        MmapSession session = sessions.remove(uploadId);
        if (session == null) throw new IllegalArgumentException("Unknown uploadId: " + uploadId);
        session.channel().close();
        log.info("MmapUpload complete: file={}, size={}MB",
                session.finalFile().getFileName(), Files.size(session.finalFile()) / 1_000_000);
        return session.finalFile();
    }

    public void abort(String uploadId) throws IOException {
        MmapSession session = sessions.remove(uploadId);
        if (session != null) {
            session.channel().close();
            Files.deleteIfExists(session.finalFile());
            log.info("MmapUpload aborted: uploadId={}", uploadId);
        }
    }

    public void deleteCompleted(String location) throws IOException {
        Files.deleteIfExists(Path.of(location));
        log.info("MmapUpload file deleted: {}", location);
    }

    private String sanitize(String filename) {
        return filename.replaceAll("[/\\\\]", "_").replaceAll("\\.\\.", "_");
    }
}
