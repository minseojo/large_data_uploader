package com.example.localupload.controller;

import com.example.localupload.service.LocalUploadService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;

@RestController
@RequestMapping("/api/local/upload")
@RequiredArgsConstructor
public class LocalUploadController {

    private final LocalUploadService uploadService;

    // 1단계: 업로드 세션 초기화
    @PostMapping("/init")
    public ResponseEntity<Map<String, String>> init(@RequestBody Map<String, String> body) throws IOException {
        String uploadId = uploadService.init(body.get("filename"));
        return ResponseEntity.ok(Map.of("uploadId", uploadId));
    }

    // 2단계: 청크 업로드
    @PostMapping("/chunk")
    public ResponseEntity<Map<String, String>> uploadChunk(
            @RequestParam String uploadId,
            @RequestParam int partNumber,
            @RequestParam MultipartFile chunk) throws IOException {
        uploadService.saveChunk(uploadId, partNumber, chunk);
        return ResponseEntity.ok(Map.of("status", "ok", "partNumber", String.valueOf(partNumber)));
    }

    // 3단계: 병합 완료
    @PostMapping("/complete")
    public ResponseEntity<Map<String, String>> complete(@RequestBody Map<String, String> body) throws IOException {
        Path finalFile = uploadService.complete(body.get("uploadId"));
        return ResponseEntity.ok(Map.of("location", finalFile.toString()));
    }

    // 중단 및 청크 정리
    @PostMapping("/abort")
    public ResponseEntity<Void> abort(@RequestBody Map<String, String> body) throws IOException {
        uploadService.abort(body.get("uploadId"));
        return ResponseEntity.noContent().build();
    }

    // 완료된 파일 삭제 (벤치마크용)
    @PostMapping("/delete")
    public ResponseEntity<Void> delete(@RequestBody Map<String, String> body) throws IOException {
        uploadService.deleteCompleted(body.get("location"));
        return ResponseEntity.noContent().build();
    }
}
