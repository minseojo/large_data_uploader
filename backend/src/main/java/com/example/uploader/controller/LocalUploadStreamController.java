package com.example.uploader.controller;

import com.example.uploader.service.LocalUploadStreamService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;

@RestController
@RequestMapping("/api/local/upload-stream")
@RequiredArgsConstructor
public class LocalUploadStreamController {

    private final LocalUploadStreamService uploadService;

    @PostMapping("/init")
    public ResponseEntity<Map<String, String>> init(@RequestBody Map<String, String> body) throws IOException {
        String uploadId = uploadService.init(body.get("filename"));
        return ResponseEntity.ok(Map.of("uploadId", uploadId));
    }

    @PostMapping(value = "/send", consumes = "application/octet-stream")
    public ResponseEntity<Map<String, String>> send(
            @RequestParam String uploadId,
            @RequestHeader("Content-Length") long contentLength,
            jakarta.servlet.http.HttpServletRequest request) throws IOException {
        uploadService.receiveStream(uploadId, request.getInputStream(), contentLength);
        return ResponseEntity.ok(Map.of("status", "ok"));
    }

    @PostMapping("/complete")
    public ResponseEntity<Map<String, String>> complete(@RequestBody Map<String, String> body) throws IOException {
        Path finalFile = uploadService.complete(body.get("uploadId"));
        return ResponseEntity.ok(Map.of("location", finalFile.toString()));
    }

    @PostMapping("/abort")
    public ResponseEntity<Void> abort(@RequestBody Map<String, String> body) throws IOException {
        uploadService.abort(body.get("uploadId"));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/delete")
    public ResponseEntity<Void> delete(@RequestBody Map<String, String> body) throws IOException {
        uploadService.deleteCompleted(body.get("location"));
        return ResponseEntity.noContent().build();
    }
}
