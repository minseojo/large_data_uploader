package com.example.uploader.controller;

import com.example.uploader.service.LocalUploadSeqService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;

@RestController
@RequestMapping("/api/local/upload-seq")
@RequiredArgsConstructor
public class LocalUploadSeqController {

    private final LocalUploadSeqService uploadService;

    @PostMapping("/init")
    public ResponseEntity<Map<String, String>> init(@RequestBody Map<String, String> body) throws IOException {
        String uploadId = uploadService.init(body.get("filename"));
        return ResponseEntity.ok(Map.of("uploadId", uploadId));
    }

    @PostMapping("/chunk")
    public ResponseEntity<Map<String, String>> uploadChunk(
            @RequestParam String uploadId,
            @RequestParam int partNumber,
            @RequestParam MultipartFile chunk) throws IOException {
        uploadService.saveChunk(uploadId, partNumber, chunk);
        return ResponseEntity.ok(Map.of("status", "ok", "partNumber", String.valueOf(partNumber)));
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
