package com.example.uploader.controller;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.util.Map;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(S3Exception.class)
    public ResponseEntity<Map<String, String>> handleS3Exception(S3Exception e) {
        log.error("SeaweedFS S3 error: statusCode={}, message={}", e.statusCode(), e.getMessage());
        return ResponseEntity.status(e.statusCode())
                .body(Map.of("error", e.awsErrorDetails().errorCode(),
                             "message", e.awsErrorDetails().errorMessage()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> handleIllegalArgument(IllegalArgumentException e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(Map.of("error", "BAD_REQUEST", "message", e.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> handleGeneral(Exception e) {
        log.error("Unexpected error", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("error", "INTERNAL_ERROR", "message", e.getMessage()));
    }
}
