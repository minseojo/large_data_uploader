package com.example.uploader.service;

import com.example.uploader.dto.MultipartRequests.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.PresignedUploadPartRequest;
import software.amazon.awssdk.services.s3.presigner.model.UploadPartPresignRequest;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class MultipartUploadService {

    private final S3Client s3Client;
    private final S3Presigner s3Presigner;

    @Value("${seaweedfs.s3.bucket}")
    private String bucket;

    @Value("${seaweedfs.s3.presigned-url-expiry-minutes}")
    private int presignedUrlExpiryMinutes;

    // ── 1. Multipart Upload 시작 ───────────────────────────────────────────────

    public CreateResponse createMultipartUpload(CreateRequest req) {
        // 파일명에 타임스탬프 prefix로 충돌 방지
        String key = "uploads/" + Instant.now().toEpochMilli() + "_" + sanitizeFilename(req.filename());

        CreateMultipartUploadRequest awsReq = CreateMultipartUploadRequest.builder()
                .bucket(bucket)
                .key(key)
                .contentType(req.contentType())
                .build();

        CreateMultipartUploadResponse awsResp = s3Client.createMultipartUpload(awsReq);
        log.info("Multipart upload created: key={}, uploadId={}, size={}GB",
                key, awsResp.uploadId(), req.size() / 1_073_741_824.0);

        return new CreateResponse(awsResp.uploadId(), key);
    }

    // ── 2-a. 단일 파트 Presigned URL 발급 ─────────────────────────────────────

    public SignPartResponse signPart(SignPartRequest req) {
        String url = generatePresignedUrl(req.uploadId(), req.key(), req.partNumber());
        return new SignPartResponse(url);
    }

    // ── 2-b. 다수 파트 Presigned URL 배치 발급 (네트워크 왕복 최소화) ────────────

    public SignPartsResponse signParts(SignPartsRequest req) {
        Map<Integer, String> urls = new HashMap<>();
        for (int partNumber : req.partNumbers()) {
            urls.put(partNumber, generatePresignedUrl(req.uploadId(), req.key(), partNumber));
        }
        log.debug("Presigned {} part URLs for uploadId={}", urls.size(), req.uploadId());
        return new SignPartsResponse(urls);
    }

    // ── 3. Multipart Upload 완료 (SeaweedFS: 메타데이터만 연결, 즉시 완료) ────────

    public CompleteResponse completeMultipartUpload(CompleteRequest req) {
        List<CompletedPart> completedParts = req.parts().stream()
                .map(p -> CompletedPart.builder()
                        .partNumber(p.partNumber())
                        .eTag(p.eTag())
                        .build())
                .toList();

        CompleteMultipartUploadRequest awsReq = CompleteMultipartUploadRequest.builder()
                .bucket(bucket)
                .key(req.key())
                .uploadId(req.uploadId())
                .multipartUpload(CompletedMultipartUpload.builder()
                        .parts(completedParts)
                        .build())
                .build();

        s3Client.completeMultipartUpload(awsReq);
        log.info("Multipart upload completed: key={}, parts={}", req.key(), req.parts().size());

        return new CompleteResponse("/" + bucket + "/" + req.key());
    }

    // ── 4. 업로드 중단 ─────────────────────────────────────────────────────────

    public void abortMultipartUpload(AbortRequest req) {
        AbortMultipartUploadRequest awsReq = AbortMultipartUploadRequest.builder()
                .bucket(bucket)
                .key(req.key())
                .uploadId(req.uploadId())
                .build();

        s3Client.abortMultipartUpload(awsReq);
        log.info("Multipart upload aborted: key={}, uploadId={}", req.key(), req.uploadId());
    }

    // ── 5. 이어올리기: 업로드된 파트 목록 조회 ────────────────────────────────────

    public List<PartInfo> listParts(String uploadId, String key) {
        ListPartsRequest awsReq = ListPartsRequest.builder()
                .bucket(bucket)
                .key(key)
                .uploadId(uploadId)
                .build();

        ListPartsResponse awsResp = s3Client.listParts(awsReq);
        log.debug("Listed {} parts for uploadId={}", awsResp.parts().size(), uploadId);

        return awsResp.parts().stream()
                .map(p -> new PartInfo(p.partNumber(), p.eTag(), p.size()))
                .toList();
    }

    // ── 6. 완료된 오브젝트 삭제 (벤치마크용) ──────────────────────────────────────

    public void deleteObject(String key) {
        s3Client.deleteObject(r -> r.bucket(bucket).key(key));
        log.info("Object deleted: key={}", key);
    }

    // ── 내부 유틸 ──────────────────────────────────────────────────────────────

    private String generatePresignedUrl(String uploadId, String key, int partNumber) {
        UploadPartPresignRequest presignReq = UploadPartPresignRequest.builder()
                .signatureDuration(Duration.ofMinutes(presignedUrlExpiryMinutes))
                .uploadPartRequest(r -> r
                        .bucket(bucket)
                        .key(key)
                        .uploadId(uploadId)
                        .partNumber(partNumber))
                .build();

        PresignedUploadPartRequest presigned = s3Presigner.presignUploadPart(presignReq);
        return presigned.url().toString();
    }

    private String sanitizeFilename(String filename) {
        // 경로 탐색 공격 방지: 슬래시, 점점 제거
        return filename.replaceAll("[/\\\\]", "_")
                       .replaceAll("\\.\\.", "_");
    }
}
