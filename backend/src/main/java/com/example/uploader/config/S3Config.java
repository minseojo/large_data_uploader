package com.example.uploader.config;

import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;

import java.net.URI;
import java.util.List;

@Slf4j
@Configuration
@RequiredArgsConstructor
public class S3Config {

    private final CorsConfig corsConfig;

    @Value("${seaweedfs.s3.endpoint}")
    private String endpoint;

    @Value("${seaweedfs.s3.access-key}")
    private String accessKey;

    @Value("${seaweedfs.s3.secret-key}")
    private String secretKey;

    @Value("${seaweedfs.s3.region}")
    private String region;

    @Value("${seaweedfs.s3.bucket}")
    private String bucket;

    private StaticCredentialsProvider credentialsProvider() {
        return StaticCredentialsProvider.create(
                AwsBasicCredentials.create(accessKey, secretKey));
    }

    @Bean
    public S3Client s3Client() {
        return S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .credentialsProvider(credentialsProvider())
                .region(Region.of(region))
                .forcePathStyle(true)
                .build();
    }

    @Bean
    public S3Presigner s3Presigner() {
        return S3Presigner.builder()
                .endpointOverride(URI.create(endpoint))
                .credentialsProvider(credentialsProvider())
                .region(Region.of(region))
                .build();
    }

    @PostConstruct
    public void initBucketCors() {
        try {
            CORSRule corsRule = CORSRule.builder()
                    .allowedOrigins(corsConfig.getAllowedOrigins())
                    .allowedMethods(List.of("GET", "PUT", "POST", "DELETE", "HEAD"))
                    .allowedHeaders("*")
                    .exposeHeaders("ETag", "Location")
                    .maxAgeSeconds(3600)
                    .build();

            s3Client().putBucketCors(PutBucketCorsRequest.builder()
                    .bucket(bucket)
                    .corsConfiguration(CORSConfiguration.builder()
                            .corsRules(corsRule)
                            .build())
                    .build());

            log.info("Bucket CORS configured for: {}", corsConfig.getAllowedOrigins());
        } catch (Exception e) {
            log.warn("Failed to set bucket CORS: {}", e.getMessage());
        }
    }
}
