package com.example.uploader.controller;

import com.example.uploader.dto.MultipartRequests.*;
import com.example.uploader.service.MultipartUploadService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/upload/multipart")
@RequiredArgsConstructor
public class MultipartUploadController {

    private final MultipartUploadService uploadService;

    /**
     * 1단계: Multipart Upload 시작 → uploadId, key 발급
     */
    @PostMapping("/create")
    public ResponseEntity<CreateResponse> create(@RequestBody CreateRequest req) {
        return ResponseEntity.ok(uploadService.createMultipartUpload(req));
    }

    /**
     * 2-a단계: 단일 파트 Presigned URL 발급
     */
    @PostMapping("/sign-part")
    public ResponseEntity<SignPartResponse> signPart(@RequestBody SignPartRequest req) {
        return ResponseEntity.ok(uploadService.signPart(req));
    }

    /**
     * 2-b단계: 다수 파트 Presigned URL 배치 발급 (Uppy 우선 사용)
     */
    @PostMapping("/sign-parts")
    public ResponseEntity<SignPartsResponse> signParts(@RequestBody SignPartsRequest req) {
        return ResponseEntity.ok(uploadService.signParts(req));
    }

    /**
     * 3단계: 모든 파트 업로드 완료 → SeaweedFS 병합 요청
     */
    @PostMapping("/complete")
    public ResponseEntity<CompleteResponse> complete(@RequestBody CompleteRequest req) {
        return ResponseEntity.ok(uploadService.completeMultipartUpload(req));
    }

    /**
     * 4단계: 업로드 중단 및 임시 파트 삭제
     */
    @PostMapping("/abort")
    public ResponseEntity<Void> abort(@RequestBody AbortRequest req) {
        uploadService.abortMultipartUpload(req);
        return ResponseEntity.noContent().build();
    }

    /**
     * 이어올리기: 이미 업로드된 파트 목록 조회
     */
    @GetMapping("/list-parts")
    public ResponseEntity<List<PartInfo>> listParts(
            @RequestParam String uploadId,
            @RequestParam String key) {
        return ResponseEntity.ok(uploadService.listParts(uploadId, key));
    }

    /**
     * 벤치마크용: 완료된 오브젝트 삭제
     */
    @PostMapping("/delete")
    public ResponseEntity<Void> delete(@RequestBody AbortRequest req) {
        uploadService.deleteObject(req.key());
        return ResponseEntity.noContent().build();
    }
}
